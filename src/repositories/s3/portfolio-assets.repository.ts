import { PutObjectCommand } from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"

import { getPresignClient } from "../../lib/s3"
import { UPLOAD_URL_TTL_SECONDS } from "./files.repository"

/** Public object keys: `portfolio/<imageId>/<fileName>`. */
export function portfolioAssetKey(imageId: string, fileName: string): string {
  const safe = fileName.replace(/[^\w.-]+/g, "-").slice(0, 120)
  return `portfolio/${imageId}/${safe}`
}

/** Images for the public portfolio site, in their own public-read bucket. */
export const portfolioAssetsRepository = {
  createUploadUrl(bucket: string, key: string, contentType: string): Promise<string> {
    return getSignedUrl(
      getPresignClient(),
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        ContentType: contentType,
        // Each upload gets a fresh key, so the file never changes once served.
        CacheControl: "public, max-age=31536000, immutable",
      }),
      { expiresIn: UPLOAD_URL_TTL_SECONDS },
    )
  },
}
