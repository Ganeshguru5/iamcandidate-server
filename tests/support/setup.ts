import type { S3Client } from "@aws-sdk/client-s3"
import { beforeEach } from "vitest"

import { resetConfig } from "../../src/lib/config"
import { setDocumentClient } from "../../src/lib/dynamodb"
import { setS3Clients } from "../../src/lib/s3"
import { FakeDynamoDB } from "./fake-dynamodb"

Object.assign(process.env, {
  AWS_REGION: "ap-south-1",
  DYNAMODB_TABLE: "personal-os-test",
  DYNAMODB_ENDPOINT: "",
  S3_BUCKET: "personal-os-documents-test",
  S3_ENDPOINT: "",
  S3_PUBLIC_ENDPOINT: "",
  ALLOWED_ORIGINS: "http://localhost:3000",
  DEFAULT_USER_ID: "usr_test",
  LOG_LEVEL: "silent",
  DATA_ENCRYPTION_KEY: "test-encryption-key-test-encryption-key",
  ALLOW_PRIVATE_SMTP_HOSTS: "true",
  AWS_ACCESS_KEY_ID: "AKIATEST",
  AWS_SECRET_ACCESS_KEY: "test-secret",
})

export const testState: { db: FakeDynamoDB; s3Send: (command: unknown) => Promise<unknown> } = {
  db: new FakeDynamoDB(),
  s3Send: async () => ({}),
}

beforeEach(() => {
  resetConfig()
  testState.db = new FakeDynamoDB()
  testState.s3Send = async () => ({})
  setDocumentClient(testState.db.asClient())
  setS3Clients({
    // Server-side S3 calls go through a stub the test controls…
    client: { send: (command: unknown) => testState.s3Send(command) } as unknown as S3Client,
    // …while presigning uses the app's real client config (local computation
    // with the fake credentials below).
    presign: undefined,
  })
})
