import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"

import { getConfig } from "./config"
import { AppError, BadRequestError } from "./errors"
import { logger } from "./logger"

/**
 * Minimal Google OAuth 2.0 + Drive v3 + Calendar v3 REST client built on
 * `fetch` (no googleapis dependency). Drive is read-only; Calendar can only
 * manage events. Each integration has its own grant and stored tokens.
 */
export const DRIVE_SCOPES = ["https://www.googleapis.com/auth/drive.readonly", "openid", "email"]
export const CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "openid",
  "email",
]

/** Which integration an OAuth round trip is for. Both share one redirect URI. */
export type GooglePurpose = "drive" | "calendar"

export const GOOGLE_PRODUCTS: Record<GooglePurpose, string> = {
  drive: "Google Drive",
  calendar: "Google Calendar",
}

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
const TOKEN_URL = "https://oauth2.googleapis.com/token"
const REVOKE_URL = "https://oauth2.googleapis.com/revoke"
const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo"
const DRIVE_URL = "https://www.googleapis.com/drive/v3"
const CALENDAR_URL = "https://www.googleapis.com/calendar/v3"

const STATE_TTL_MS = 10 * 60 * 1000

export function googleConfig() {
  const google = getConfig().google
  if (!google) {
    throw new BadRequestError(
      "Google sign-in isn't set up on this server yet (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI).",
    )
  }
  return google
}

/** Raised when the stored grant no longer works (revoked, expired test app, password change). */
export class GoogleGrantError extends AppError {
  constructor(product = GOOGLE_PRODUCTS.drive) {
    super(
      409,
      "INTEGRATION_ERROR",
      `${product} access has expired or was revoked. Reconnect ${product}.`,
    )
  }
}

/* OAuth state: signed, short-lived and bound to the user (CSRF protection) */

function sign(payload: string): string {
  const secret = getConfig().authSecret ?? getConfig().dataEncryptionKey ?? ""
  return createHmac("sha256", `google-oauth-state:${secret}`).update(payload).digest("base64url")
}

/**
 * The payload is readable (not secret): the frontend callback reads `p` to
 * know which integration to finish. The signature stops tampering.
 */
export function createState(
  userId: string,
  purpose: GooglePurpose = "drive",
  now = Date.now(),
): string {
  const payload = Buffer.from(
    JSON.stringify({
      u: userId,
      p: purpose,
      n: randomBytes(8).toString("hex"),
      e: now + STATE_TTL_MS,
    }),
  ).toString("base64url")
  return `${payload}.${sign(payload)}`
}

export function verifyState(
  state: string,
  userId: string,
  purpose: GooglePurpose = "drive",
  now = Date.now(),
): boolean {
  const [payload, signature] = state.split(".")
  if (!payload || !signature) return false
  const expected = Buffer.from(sign(payload))
  const actual = Buffer.from(signature)
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return false
  try {
    const { u, p, e } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      u: string
      p?: GooglePurpose
      e: number
    }
    return u === userId && (p ?? "drive") === purpose && e > now
  } catch {
    return false
  }
}

export function authorizationUrl(state: string, scopes: string[] = DRIVE_SCOPES): string {
  const { clientId, redirectUri } = googleConfig()
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: scopes.join(" "),
    access_type: "offline",
    // Always show consent so Google returns a refresh token.
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  })
  return `${AUTH_URL}?${params}`
}

/* HTTP helpers ------------------------------------------------------- */

async function googleFetch(url: string, init: RequestInit, what: string): Promise<Response> {
  let response: Response
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) })
  } catch (error) {
    logger.warn("Google request failed", { what, error: String(error) })
    throw new AppError(502, "INTEGRATION_ERROR", "Couldn't reach Google. Try again in a moment.")
  }
  return response
}

async function errorBody(response: Response): Promise<{ error?: string; message?: string }> {
  try {
    const body = (await response.json()) as {
      error?: string | { message?: string; status?: string }
      error_description?: string
    }
    if (typeof body.error === "string")
      return { error: body.error, message: body.error_description }
    return { error: body.error?.status, message: body.error?.message }
  } catch {
    return {}
  }
}

export interface TokenSet {
  accessToken: string
  expiresAt: number
  refreshToken?: string
  scope: string
}

async function tokenRequest(
  params: Record<string, string>,
  purpose: GooglePurpose,
): Promise<TokenSet> {
  const { clientId, clientSecret } = googleConfig()
  const response = await googleFetch(
    TOKEN_URL,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...params }),
    },
    "token",
  )
  if (!response.ok) {
    const { error, message } = await errorBody(response)
    logger.warn("Google token error", { status: response.status, error, message })
    if (error === "invalid_grant") throw new GoogleGrantError(GOOGLE_PRODUCTS[purpose])
    throw new AppError(
      502,
      "INTEGRATION_ERROR",
      "Google rejected the sign-in. Try connecting again.",
    )
  }
  const body = (await response.json()) as {
    access_token: string
    expires_in: number
    refresh_token?: string
    scope: string
  }
  return {
    accessToken: body.access_token,
    expiresAt: Date.now() + body.expires_in * 1000,
    scope: body.scope,
    ...(body.refresh_token ? { refreshToken: body.refresh_token } : {}),
  }
}

export function exchangeCode(code: string, purpose: GooglePurpose = "drive"): Promise<TokenSet> {
  return tokenRequest(
    { code, grant_type: "authorization_code", redirect_uri: googleConfig().redirectUri },
    purpose,
  )
}

export function refreshAccessToken(
  refreshToken: string,
  purpose: GooglePurpose = "drive",
): Promise<TokenSet> {
  return tokenRequest({ refresh_token: refreshToken, grant_type: "refresh_token" }, purpose)
}

/** Best effort: the connection is removed locally either way. */
export async function revokeToken(token: string): Promise<void> {
  try {
    await googleFetch(
      REVOKE_URL,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token }),
      },
      "revoke",
    )
  } catch {
    // ignore
  }
}

export async function fetchUserEmail(accessToken: string): Promise<string> {
  const response = await googleFetch(
    USERINFO_URL,
    { headers: { authorization: `Bearer ${accessToken}` } },
    "userinfo",
  )
  if (!response.ok)
    throw new AppError(502, "INTEGRATION_ERROR", "Couldn't read your Google account.")
  const body = (await response.json()) as { email?: string }
  return body.email ?? "Google account"
}

/* Drive ------------------------------------------------------------- */

export interface DriveFile {
  id: string
  name: string
  mimeType: string
  size?: string
  modifiedTime: string
  parents?: string[]
}

async function driveRequest(accessToken: string, path: string, what: string): Promise<Response> {
  const response = await googleFetch(
    `${DRIVE_URL}${path}`,
    { headers: { authorization: `Bearer ${accessToken}` } },
    what,
  )
  if (response.ok) return response
  const { error, message } = await errorBody(response)
  logger.warn("Drive API error", { what, status: response.status, error, message })
  if (response.status === 401) throw new GoogleGrantError()
  if (response.status === 404)
    throw new AppError(404, "NOT_FOUND", "That Drive file no longer exists.")
  if (response.status === 403 && /exportSizeLimitExceeded/i.test(message ?? "")) {
    throw new BadRequestError("This Google file is too large to export.")
  }
  throw new AppError(502, "INTEGRATION_ERROR", "Google Drive returned an error. Try again.")
}

/** Children of a folder ("root" = My Drive), excluding trash. */
export async function listFolder(accessToken: string, folderId: string): Promise<DriveFile[]> {
  const files: DriveFile[] = []
  let pageToken: string | undefined
  do {
    const params = new URLSearchParams({
      q: `'${folderId.replace(/['\\]/g, "")}' in parents and trashed = false`,
      fields: "nextPageToken, files(id, name, mimeType, size, modifiedTime, parents)",
      orderBy: "folder,name",
      pageSize: "200",
      ...(pageToken ? { pageToken } : {}),
    })
    const response = await driveRequest(accessToken, `/files?${params}`, "list")
    const body = (await response.json()) as { files?: DriveFile[]; nextPageToken?: string }
    files.push(...(body.files ?? []))
    pageToken = body.nextPageToken
  } while (pageToken && files.length < 1000)
  return files
}

export async function getFile(accessToken: string, fileId: string): Promise<DriveFile> {
  const params = new URLSearchParams({ fields: "id, name, mimeType, size, modifiedTime, parents" })
  const response = await driveRequest(
    accessToken,
    `/files/${encodeURIComponent(fileId)}?${params}`,
    "get",
  )
  return (await response.json()) as DriveFile
}

/** Google Docs/Sheets/Slides have no binary; they are exported to a common format. */
export const EXPORTS: Record<string, { mimeType: string; extension: string }> = {
  "application/vnd.google-apps.document": { mimeType: "application/pdf", extension: ".pdf" },
  "application/vnd.google-apps.presentation": { mimeType: "application/pdf", extension: ".pdf" },
  "application/vnd.google-apps.drawing": { mimeType: "application/pdf", extension: ".pdf" },
  "application/vnd.google-apps.spreadsheet": {
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    extension: ".xlsx",
  },
}

/** Downloads (or exports) a file's content. */
export async function downloadFile(
  accessToken: string,
  file: DriveFile,
): Promise<{ body: Uint8Array; mimeType: string; name: string }> {
  const id = encodeURIComponent(file.id)
  const exportAs = EXPORTS[file.mimeType]
  if (file.mimeType.startsWith("application/vnd.google-apps.") && !exportAs) {
    throw new BadRequestError("This kind of Google file can't be imported.")
  }
  const path = exportAs
    ? `/files/${id}/export?${new URLSearchParams({ mimeType: exportAs.mimeType })}`
    : `/files/${id}?alt=media`
  const response = await driveRequest(accessToken, path, exportAs ? "export" : "download")
  const body = new Uint8Array(await response.arrayBuffer())
  const name =
    exportAs && !file.name.toLowerCase().endsWith(exportAs.extension)
      ? `${file.name}${exportAs.extension}`
      : file.name
  return { body, mimeType: exportAs?.mimeType ?? file.mimeType, name }
}

/* Calendar ---------------------------------------------------------- */

export interface CalendarEvent {
  summary: string
  description?: string
  location?: string
  /** Timed events use `dateTime`; all-day events use `date` (YYYY-MM-DD, end exclusive). */
  start: { dateTime: string } | { date: string }
  end: { dateTime: string } | { date: string }
}

async function calendarRequest(
  accessToken: string,
  path: string,
  init: RequestInit,
  what: string,
): Promise<Response> {
  const response = await googleFetch(
    `${CALENDAR_URL}${path}`,
    {
      ...init,
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
    },
    what,
  )
  if (response.ok || response.status === 404 || response.status === 410) return response
  const { error, message } = await errorBody(response)
  logger.warn("Calendar API error", { what, status: response.status, error, message })
  if (response.status === 401) throw new GoogleGrantError(GOOGLE_PRODUCTS.calendar)
  if (
    response.status === 403 &&
    /has not been used|is disabled|accessNotConfigured/i.test(message ?? "")
  ) {
    throw new BadRequestError(
      "The Google Calendar API isn't enabled for this server's Google Cloud project. Enable it in the Google Cloud console, then sync again.",
    )
  }
  throw new AppError(502, "INTEGRATION_ERROR", "Google Calendar returned an error. Try again.")
}

/**
 * Creates or updates the event with our own id in the primary calendar.
 * Ids are stable per iamcandidate item, so syncing again never duplicates events.
 */
export async function upsertCalendarEvent(
  accessToken: string,
  eventId: string,
  event: CalendarEvent,
): Promise<void> {
  const path = `/calendars/primary/events/${encodeURIComponent(eventId)}`
  const body = JSON.stringify({ ...event, status: "confirmed" })
  const updated = await calendarRequest(accessToken, path, { method: "PUT", body }, "update")
  if (updated.ok) return
  const created = await calendarRequest(
    accessToken,
    "/calendars/primary/events",
    { method: "POST", body: JSON.stringify({ ...event, id: eventId }) },
    "insert",
  )
  if (!created.ok) {
    throw new AppError(502, "INTEGRATION_ERROR", "Couldn't create a Google Calendar event.")
  }
}

/** Removes an event we created; already-deleted events are fine. */
export async function deleteCalendarEvent(accessToken: string, eventId: string): Promise<void> {
  await calendarRequest(
    accessToken,
    `/calendars/primary/events/${encodeURIComponent(eventId)}`,
    { method: "DELETE" },
    "delete",
  )
}
