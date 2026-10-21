import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"

import { getConfig } from "./config"
import { AppError, BadRequestError } from "./errors"
import { logger } from "./logger"

/**
 * Minimal Google OAuth 2.0 + Drive v3 REST client built on `fetch` (no
 * googleapis dependency). Read-only Drive access.
 */
export const DRIVE_SCOPES = ["https://www.googleapis.com/auth/drive.readonly", "openid", "email"]

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
const TOKEN_URL = "https://oauth2.googleapis.com/token"
const REVOKE_URL = "https://oauth2.googleapis.com/revoke"
const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo"
const DRIVE_URL = "https://www.googleapis.com/drive/v3"

const STATE_TTL_MS = 10 * 60 * 1000

export function googleConfig() {
  const google = getConfig().google
  if (!google) {
    throw new BadRequestError(
      "Google Drive isn't set up on this server yet (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI).",
    )
  }
  return google
}

/** Raised when the stored grant no longer works (revoked, expired test app, password change). */
export class GoogleGrantError extends AppError {
  constructor() {
    super(
      409,
      "INTEGRATION_ERROR",
      "Google Drive access has expired or was revoked. Reconnect Google Drive.",
    )
  }
}

/* OAuth state: signed, short-lived and bound to the user (CSRF protection) */

function sign(payload: string): string {
  const secret = getConfig().authSecret ?? getConfig().dataEncryptionKey ?? ""
  return createHmac("sha256", `google-oauth-state:${secret}`).update(payload).digest("base64url")
}

export function createState(userId: string, now = Date.now()): string {
  const payload = Buffer.from(
    JSON.stringify({ u: userId, n: randomBytes(8).toString("hex"), e: now + STATE_TTL_MS }),
  ).toString("base64url")
  return `${payload}.${sign(payload)}`
}

export function verifyState(state: string, userId: string, now = Date.now()): boolean {
  const [payload, signature] = state.split(".")
  if (!payload || !signature) return false
  const expected = Buffer.from(sign(payload))
  const actual = Buffer.from(signature)
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return false
  try {
    const { u, e } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      u: string
      e: number
    }
    return u === userId && e > now
  } catch {
    return false
  }
}

export function authorizationUrl(state: string): string {
  const { clientId, redirectUri } = googleConfig()
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: DRIVE_SCOPES.join(" "),
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

async function tokenRequest(params: Record<string, string>): Promise<TokenSet> {
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
    if (error === "invalid_grant") throw new GoogleGrantError()
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

export function exchangeCode(code: string): Promise<TokenSet> {
  return tokenRequest({
    code,
    grant_type: "authorization_code",
    redirect_uri: googleConfig().redirectUri,
  })
}

export function refreshAccessToken(refreshToken: string): Promise<TokenSet> {
  return tokenRequest({ refresh_token: refreshToken, grant_type: "refresh_token" })
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
