import { getConfig } from "../lib/config"
import { AppError, BadRequestError } from "../lib/errors"
import {
  authorizationUrl,
  createState,
  DRIVE_SCOPES,
  downloadFile,
  exchangeCode,
  fetchUserEmail,
  getFile,
  listFolder,
  revokeToken,
  verifyState,
  type DriveFile,
} from "../lib/google"
import { nowIso } from "../lib/ids"
import { decryptSecret, encryptSecret } from "../lib/secrets"
import type { DocumentFile, DriveItem, GoogleDriveStatus, StoredGoogleDrive } from "../models"
import { settingsRepository } from "../repositories/dynamodb"
import { MAX_UPLOAD_BYTES } from "../schemas/documents"
import { activitiesService } from "./activities.service"
import { documentsService } from "./documents.service"
import { withGoogle } from "./google-tokens"

const FOLDER = "application/vnd.google-apps.folder"

function kindFor(mimeType: string, name: string): DriveItem["kind"] {
  const lower = name.toLowerCase()
  if (mimeType === "application/pdf" || lower.endsWith(".pdf")) return "pdf"
  if (/spreadsheet|excel|csv/.test(mimeType) || /\.(xlsx?|csv)$/.test(lower)) return "sheet"
  if (mimeType.startsWith("image/")) return "image"
  if (/zip|compressed|x-tar|x-7z/.test(mimeType)) return "zip"
  if (/word|opendocument\.text/.test(mimeType) || /\.docx?$/.test(lower)) return "docx"
  // Google Docs/Slides/Drawings are imported as PDF.
  if (mimeType.startsWith("application/vnd.google-apps.")) return "pdf"
  return "text"
}

function categoryFor(name: string): DocumentFile["category"] {
  if (/resume|cv\b/i.test(name)) return "resume"
  if (/cert/i.test(name)) return "certificates"
  return "other"
}

function toItem(file: DriveFile, parentId: string | null): DriveItem {
  const isFolder = file.mimeType === FOLDER
  return {
    id: file.id,
    name: file.name,
    type: isFolder ? "folder" : "file",
    parentId,
    modifiedAt: file.modifiedTime,
    mimeType: file.mimeType,
    ...(isFolder
      ? {}
      : {
          kind: kindFor(file.mimeType, file.name),
          ...(file.size ? { sizeBytes: Number(file.size) } : {}),
        }),
  }
}

/** Runs a Drive call with a fresh token (see withGoogle). */
function withDrive<T>(userId: string, run: (token: string) => Promise<T>): Promise<T> {
  return withGoogle(userId, "drive", run)
}

function toStatus(stored: StoredGoogleDrive | undefined): GoogleDriveStatus {
  return {
    available: Boolean(getConfig().google),
    connected: Boolean(stored),
    ...(stored ? { account: stored.email, connectedAt: stored.connectedAt } : {}),
  }
}

export const googleDriveService = {
  async status(userId: string): Promise<GoogleDriveStatus> {
    return toStatus(await settingsRepository.get(userId, "GOOGLE_DRIVE"))
  },

  /** Where to send the browser to grant read-only Drive access. */
  authUrl(userId: string): { url: string } {
    return { url: authorizationUrl(createState(userId, "drive"), DRIVE_SCOPES) }
  },

  /** Completes the OAuth redirect: verifies state, stores the encrypted tokens. */
  async connect(userId: string, code: string, state: string): Promise<GoogleDriveStatus> {
    if (!verifyState(state, userId, "drive")) {
      throw new BadRequestError(
        "This Google sign-in has expired or wasn't started here. Connect again.",
      )
    }
    const tokens = await exchangeCode(code, "drive")
    if (!tokens.refreshToken) {
      throw new AppError(
        502,
        "INTEGRATION_ERROR",
        "Google didn't grant offline access. Remove IamCandidate from your Google account's third-party access and connect again.",
      )
    }
    const stored: StoredGoogleDrive = {
      email: await fetchUserEmail(tokens.accessToken),
      encryptedRefreshToken: encryptSecret(tokens.refreshToken),
      encryptedAccessToken: encryptSecret(tokens.accessToken),
      accessTokenExpiresAt: tokens.expiresAt,
      scope: tokens.scope,
      connectedAt: nowIso(),
    }
    await settingsRepository.put(userId, "GOOGLE_DRIVE", stored)
    await activitiesService.record(userId, {
      type: "integration_connected",
      title: "Google Drive connected",
      description: stored.email,
      entity: { type: "integration", id: "google_drive" },
    })
    return toStatus(stored)
  },

  /** Revokes the grant at Google and forgets the tokens. */
  async disconnect(userId: string): Promise<GoogleDriveStatus> {
    const stored = await settingsRepository.get(userId, "GOOGLE_DRIVE")
    if (stored) {
      await revokeToken(decryptSecret(stored.encryptedRefreshToken))
      await settingsRepository.remove(userId, "GOOGLE_DRIVE")
      await activitiesService.record(userId, {
        type: "integration_disconnected",
        title: "Google Drive disconnected",
        entity: { type: "integration", id: "google_drive" },
      })
    }
    return toStatus(undefined)
  },

  /** One folder at a time; `parentId` undefined = My Drive. */
  async list(userId: string, parentId: string | undefined): Promise<DriveItem[]> {
    const files = await withDrive(userId, (token) => listFolder(token, parentId ?? "root"))
    return files.map((file) => toItem(file, parentId ?? null))
  },

  /** Copies a Drive file into Documents (S3). Google formats are exported first. */
  async import(
    userId: string,
    fileId: string,
    category?: DocumentFile["category"],
  ): Promise<DocumentFile> {
    return withDrive(userId, async (token) => {
      const file = await getFile(token, fileId)
      if (file.mimeType === FOLDER)
        throw new BadRequestError("Folders can't be imported; open it and pick a file.")
      if (file.size && Number(file.size) > MAX_UPLOAD_BYTES) {
        throw new BadRequestError("Files must be 25 MB or smaller")
      }
      const content = await downloadFile(token, file)
      if (content.body.byteLength > MAX_UPLOAD_BYTES) {
        throw new BadRequestError("Files must be 25 MB or smaller")
      }
      return documentsService.importFile(userId, {
        name: content.name,
        body: content.body,
        contentType: content.mimeType,
        kind: kindFor(content.mimeType, content.name) ?? "text",
        category: category ?? categoryFor(content.name),
        driveFileId: file.id,
      })
    })
  },
}
