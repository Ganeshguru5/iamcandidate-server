/**
 * Creates the local DynamoDB table and MinIO bucket for the Docker setup
 * (idempotent). In AWS both are created by template.yaml — never run this
 * against AWS. `npm run dev` doesn't need it.
 *
 *   npm run local:up && npm run local:setup
 */
import { CreateBucketCommand, HeadBucketCommand } from "@aws-sdk/client-s3"

import { getConfig } from "../src/lib/config"
import { getS3Client } from "../src/lib/s3"
import { loadLocalEnv } from "./env"
import { ensureLocalTable } from "./local-table"

loadLocalEnv()
const config = getConfig()

if (!config.dynamodbEndpoint || !config.s3Endpoint) {
  console.error(
    "DYNAMODB_ENDPOINT and S3_ENDPOINT must be set — this script only targets local services.",
  )
  process.exit(1)
}

async function setupBucket() {
  const s3 = getS3Client()
  try {
    await s3.send(new HeadBucketCommand({ Bucket: config.bucketName }))
    console.log(`✓ bucket ${config.bucketName} already exists`)
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: config.bucketName }))
    console.log(`✓ created bucket ${config.bucketName}`)
  }
}

async function main() {
  const table = await ensureLocalTable(config)
  console.log(`✓ table ${config.tableName} ${table === "created" ? "created" : "already exists"}`)
  await setupBucket().catch(() =>
    console.warn(
      "! S3 (MinIO) not reachable — skipping bucket. Everything except document uploads works.",
    ),
  )
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
