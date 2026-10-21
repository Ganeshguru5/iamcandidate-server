import { S3Client } from "@aws-sdk/client-s3"

import { getConfig } from "./config"

let client: S3Client | undefined
let presignClient: S3Client | undefined

function create(endpoint: string | undefined): S3Client {
  const { region } = getConfig()
  const accessKeyId = process.env.S3_ACCESS_KEY_ID
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY
  return new S3Client({
    region,
    // Presigned browser uploads can't carry the SDK's default CRC32 checksum
    // (it would be computed over an empty body and S3 would reject the PUT).
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    // Custom endpoints (MinIO locally) need path-style URLs and MinIO's own
    // credentials. In AWS neither is set and the Lambda role is used.
    ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
    ...(endpoint && accessKeyId && secretAccessKey
      ? { credentials: { accessKeyId, secretAccessKey } }
      : {}),
  })
}

/** Client used for server-side calls (HeadObject, DeleteObject). */
export function getS3Client(): S3Client {
  client ??= create(getConfig().s3Endpoint)
  return client
}

/**
 * Client used only to sign URLs. Locally the Lambda container reaches MinIO at
 * `http://minio:9000` while the browser needs `http://localhost:9000`, so the
 * signing endpoint can differ from the server endpoint.
 */
export function getPresignClient(): S3Client {
  presignClient ??= create(getConfig().s3PublicEndpoint)
  return presignClient
}

/** Test hook. */
export function setS3Clients(next: { client?: S3Client; presign?: S3Client }) {
  client = next.client
  presignClient = next.presign
}
