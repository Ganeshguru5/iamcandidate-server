import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"

import { getConfig } from "../../lib/config"
import { getPresignClient, getS3Client } from "../../lib/s3"

/** Presigned URLs are short-lived; the browser uses them immediately. */
export const UPLOAD_URL_TTL_SECONDS = 300
export const DOWNLOAD_URL_TTL_SECONDS = 300

/** Private, per-user object keys: `users/<userId>/documents/<documentId>/<fileName>`. */
export function documentKey(userId: string, documentId: string, fileName: string): string {
  const safe = fileName.replace(/[^\w.\- ()]+/g, "_").slice(0, 200)
  return `${userPrefix(userId)}${documentId}/${safe}`
}

export function userPrefix(userId: string): string {
  return `users/${userId}/documents/`
}

const bucket = () => getConfig().bucketName

export const filesRepository = {
  createUploadUrl(key: string, contentType: string): Promise<string> {
    return getSignedUrl(
      getPresignClient(),
      new PutObjectCommand({ Bucket: bucket(), Key: key, ContentType: contentType }),
      { expiresIn: UPLOAD_URL_TTL_SECONDS },
    )
  },

  createDownloadUrl(key: string, fileName: string): Promise<string> {
    return getSignedUrl(
      getPresignClient(),
      new GetObjectCommand({
        Bucket: bucket(),
        Key: key,
        ResponseContentDisposition: `attachment; filename="${fileName.replace(/["\\]/g, "_")}"`,
      }),
      { expiresIn: DOWNLOAD_URL_TTL_SECONDS },
    )
  },

  /** Size and type of an uploaded object, or undefined if it does not exist. */
  async head(key: string): Promise<{ sizeBytes: number; contentType?: string } | undefined> {
    try {
      const result = await getS3Client().send(new HeadObjectCommand({ Bucket: bucket(), Key: key }))
      return {
        sizeBytes: result.ContentLength ?? 0,
        ...(result.ContentType ? { contentType: result.ContentType } : {}),
      }
    } catch (error) {
      if (error instanceof Error && (error.name === "NotFound" || error.name === "NoSuchKey")) {
        return undefined
      }
      throw error
    }
  },

  /** Server-side upload (used for imports; browser uploads use presigned URLs). */
  async put(key: string, body: Uint8Array, contentType: string): Promise<void> {
    await getS3Client().send(
      new PutObjectCommand({ Bucket: bucket(), Key: key, Body: body, ContentType: contentType }),
    )
  },

  async delete(key: string): Promise<void> {
    await getS3Client().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }))
  },
}
