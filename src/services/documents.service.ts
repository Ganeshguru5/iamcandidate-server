import { BadRequestError, ConflictError, NotFoundError } from "../lib/errors"
import { createId, nowIso } from "../lib/ids"
import { logger, serializeError } from "../lib/logger"
import { applyPatch, type Patch } from "../lib/validation"
import type { DocumentFile, StoredDocument } from "../models"
import { repositories } from "../repositories/dynamodb"
import {
  documentKey,
  DOWNLOAD_URL_TTL_SECONDS,
  filesRepository,
  UPLOAD_URL_TTL_SECONDS,
  userPrefix,
} from "../repositories/s3/files.repository"
import { MAX_UPLOAD_BYTES, type DocumentInput } from "../schemas/documents"
import { activitiesService } from "./activities.service"
import { byDateDesc } from "./crud"

const repo = repositories.documents

/** API shape: the S3 key stays server-side. */
function toDto({ s3Key: _s3Key, ...doc }: StoredDocument): DocumentFile {
  return doc
}

/** `users/<userId>/documents/<documentId>/<file>` → `<documentId>`, only for the caller's prefix. */
function documentIdFromKey(userId: string, key: string): string {
  const prefix = userPrefix(userId)
  const rest = key.startsWith(prefix) ? key.slice(prefix.length) : ""
  const [id, fileName, ...extra] = rest.split("/")
  if (!id || !fileName || extra.length > 0 || !/^doc_[a-f0-9]{16}$/.test(id)) {
    throw new BadRequestError("uploadKey does not belong to this user")
  }
  return id
}

export const documentsService = {
  async list(
    userId: string,
    filters: { category?: DocumentFile["category"]; starred?: boolean },
  ): Promise<DocumentFile[]> {
    const items = await repo.list(userId)
    return items
      .filter((doc) => filters.category === undefined || doc.category === filters.category)
      .filter((doc) => filters.starred === undefined || doc.starred === filters.starred)
      .sort(byDateDesc("uploadedAt"))
      .map(toDto)
  },

  async get(userId: string, id: string): Promise<DocumentFile> {
    return toDto(await repo.getOrThrow(userId, id))
  },

  /**
   * Step 1 of an upload: reserve a document id and return a short-lived
   * presigned PUT URL. The browser uploads the bytes straight to S3, so file
   * contents never pass through Lambda or API Gateway.
   */
  async createUploadUrl(
    userId: string,
    input: { fileName: string; contentType: string; sizeBytes: number },
  ) {
    const documentId = createId("doc")
    const key = documentKey(userId, documentId, input.fileName)
    const uploadUrl = await filesRepository.createUploadUrl(key, input.contentType)
    return {
      documentId,
      uploadKey: key,
      uploadUrl,
      method: "PUT" as const,
      headers: { "Content-Type": input.contentType },
      expiresIn: UPLOAD_URL_TTL_SECONDS,
    }
  },

  /** Stores a file the server already has (e.g. imported from Google Drive). */
  async importFile(
    userId: string,
    file: {
      name: string
      body: Uint8Array
      contentType: string
      kind: DocumentFile["kind"]
      category: DocumentFile["category"]
      driveFileId?: string
    },
  ): Promise<DocumentFile> {
    const id = createId("doc")
    const key = documentKey(userId, id, file.name)
    await filesRepository.put(key, file.body, file.contentType)
    const now = nowIso()
    const doc: StoredDocument = {
      id,
      name: file.name,
      category: file.category,
      kind: file.kind,
      sizeBytes: file.body.byteLength,
      mimeType: file.contentType,
      starred: false,
      source: file.driveFileId ? "drive" : "local",
      ...(file.driveFileId ? { driveFileId: file.driveFileId } : {}),
      s3Key: key,
      uploadedAt: now,
      updatedAt: now,
    }
    await repo.create(userId, doc)
    await activitiesService.record(userId, {
      type: "document_uploaded",
      title: file.driveFileId ? "Imported from Google Drive" : "Document uploaded",
      description: doc.name,
      entity: { type: "document", id },
    })
    return toDto(doc)
  },

  /** Step 2: confirm the object exists in S3 and save its metadata. */
  async create(userId: string, input: DocumentInput): Promise<DocumentFile> {
    const id = documentIdFromKey(userId, input.uploadKey)
    if (await repo.get(userId, id)) throw new ConflictError(`Document ${id} already exists`)
    const object = await filesRepository.head(input.uploadKey)
    if (!object) {
      throw new BadRequestError(
        "No uploaded file found for uploadKey — upload it to the presigned URL first",
      )
    }
    if (object.sizeBytes > MAX_UPLOAD_BYTES) {
      await filesRepository.delete(input.uploadKey)
      throw new BadRequestError("Files must be 25 MB or smaller")
    }
    const now = nowIso()
    const { uploadKey, ...metadata } = input
    const doc: StoredDocument = {
      ...metadata,
      id,
      // Trust S3 over the client for the stored size.
      sizeBytes: object.sizeBytes,
      ...(object.contentType ? { mimeType: object.contentType } : {}),
      starred: false,
      source: "local",
      s3Key: uploadKey,
      uploadedAt: now,
      updatedAt: now,
    }
    await repo.create(userId, doc)
    await activitiesService.record(userId, {
      type: "document_uploaded",
      title: "Document uploaded",
      description: doc.name,
      entity: { type: "document", id },
    })
    return toDto(doc)
  },

  async update(
    userId: string,
    id: string,
    patch: Patch<Partial<Pick<DocumentFile, "name" | "category" | "starred" | "description">>>,
  ): Promise<DocumentFile> {
    const existing = await repo.getOrThrow(userId, id)
    const next: StoredDocument = { ...applyPatch(existing, patch), id, updatedAt: nowIso() }
    return toDto(await repo.replace(userId, next))
  },

  async toggleStar(userId: string, id: string): Promise<DocumentFile> {
    const existing = await repo.getOrThrow(userId, id)
    return toDto(await repo.replace(userId, { ...existing, starred: !existing.starred }))
  },

  async createDownloadUrl(userId: string, id: string) {
    const doc = await repo.getOrThrow(userId, id)
    if (!doc.s3Key) throw new NotFoundError("Stored file for document", id)
    const url = await filesRepository.createDownloadUrl(doc.s3Key, doc.name)
    return { url, expiresIn: DOWNLOAD_URL_TTL_SECONDS }
  },

  async remove(userId: string, id: string): Promise<void> {
    const removed = await repo.delete(userId, id)
    if (removed.s3Key) {
      try {
        await filesRepository.delete(removed.s3Key)
      } catch (error) {
        // Metadata is gone; an orphaned object is harmless and is logged for cleanup.
        logger.error("Failed to delete S3 object", {
          key: removed.s3Key,
          error: serializeError(error),
        })
      }
    }
    await activitiesService.record(userId, {
      type: "document_deleted",
      title: "Document deleted",
      description: removed.name,
    })
  },
}
