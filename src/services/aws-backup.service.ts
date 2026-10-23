import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3"

import { getConfig } from "../lib/config"
import { AppError, BadRequestError, ConflictError } from "../lib/errors"
import { nowIso } from "../lib/ids"
import { logger, serializeError } from "../lib/logger"
import { getS3Client } from "../lib/s3"
import { decryptSecret, encryptSecret } from "../lib/secrets"
import type { AwsBackupStatus, BackupProgress, BackupSummary, StoredAwsBackup } from "../models"
import { repositories, settingsRepository } from "../repositories/dynamodb"
import { queryAll, stripKeys, userPk } from "../repositories/dynamodb/table"
import { activitiesService } from "./activities.service"

/**
 * Backs up a user's knot data to their own S3 bucket with an access key they
 * provide: a JSON export of everything, plus a copy of every document file.
 *
 * API Gateway allows 30 seconds per request, so a backup runs in steps: each
 * call does ~20 seconds of work and returns a cursor; the client calls again
 * until `done`. Files already in the bucket with the same size are skipped.
 */
const STEP_BUDGET_MS = 20_000
const ROOT = "knot-backup/"

export interface AwsBackupInput {
  bucket: string
  region: string
  prefix: string
  accessKeyId: string
  /** Empty keeps the saved secret (when only bucket/prefix change). */
  secretAccessKey: string
}

interface Cursor {
  stamp: string
  dataKey: string
  index: number
  copied: number
  bytes: number
  failed: number
  total: number
}

type ClientFactory = (
  stored: Pick<StoredAwsBackup, "region" | "accessKeyId">,
  secret: string,
) => Pick<S3Client, "send">

const defaultFactory: ClientFactory = (stored, secret) =>
  new S3Client({
    region: stored.region,
    credentials: { accessKeyId: stored.accessKeyId, secretAccessKey: secret },
    maxAttempts: 2,
  })

let userClient: ClientFactory = defaultFactory

/** Test hook: replaces the client used for the user's own bucket. */
export function setBackupClientFactory(factory: ClientFactory | undefined) {
  userClient = factory ?? defaultFactory
}

/** Turns S3 errors into messages that say what to fix. */
function explain(error: unknown, bucket: string): never {
  const name = error instanceof S3ServiceException || error instanceof Error ? error.name : ""
  logger.warn("Backup S3 error", { error: serializeError(error) })
  switch (name) {
    case "InvalidAccessKeyId":
    case "SignatureDoesNotMatch":
    case "InvalidClientTokenId":
    case "UnrecognizedClientException":
      throw new BadRequestError("AWS didn't accept the access key. Check the key ID and secret.")
    case "AccessDenied":
    case "Forbidden":
      throw new BadRequestError(
        `The access key isn't allowed to write to ${bucket}. Give it s3:PutObject and s3:GetObject on the bucket (see the policy shown in knot).`,
      )
    case "NoSuchBucket":
      throw new BadRequestError(`The bucket ${bucket} doesn't exist.`)
    case "PermanentRedirect":
    case "AuthorizationHeaderMalformed":
    case "IllegalLocationConstraintException":
      throw new BadRequestError(`${bucket} is in a different region. Check the region.`)
    default:
      throw new AppError(502, "INTEGRATION_ERROR", "Couldn't reach your S3 bucket. Try again.")
  }
}

function toStatus(stored: StoredAwsBackup | undefined): AwsBackupStatus {
  if (!stored) return { connected: false }
  return {
    connected: true,
    bucket: stored.bucket,
    region: stored.region,
    prefix: stored.prefix,
    // Only the last 4 characters; the key id is an identifier, but no need to echo it.
    accessKeyId: `…${stored.accessKeyId.slice(-4)}`,
    connectedAt: stored.connectedAt,
    ...(stored.lastBackup ? { lastBackup: stored.lastBackup } : {}),
  }
}

/** Every record the user owns, without credentials or internal keys. */
async function exportData(userId: string) {
  const entries = await Promise.all(
    Object.entries(repositories).map(
      async ([name, repo]) => [name, await repo.list(userId)] as const,
    ),
  )
  const data = Object.fromEntries(entries) as Record<string, unknown[]>
  // Documents: drop the private S3 key; the files are copied separately.
  data.documents = (data.documents as Array<Record<string, unknown>>).map(
    ({ s3Key: _s3Key, ...doc }) => doc,
  )
  const [profile, notifications, activities] = await Promise.all([
    settingsRepository.get(userId, "PROFILE"),
    settingsRepository.get(userId, "NOTIFICATIONS"),
    queryAll(userPk(userId), "ACTIVITY#"),
  ])
  return {
    format: "knot-backup",
    version: 1,
    exportedAt: nowIso(),
    userId,
    settings: { profile, notifications },
    activities: activities.map((item) => stripKeys(item)),
    ...data,
  }
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url")
}

function decodeCursor(value: string): Cursor {
  try {
    const cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Cursor
    if (
      /^\d{8}T\d{6}Z$/.test(cursor.stamp) &&
      [cursor.index, cursor.copied, cursor.bytes, cursor.failed, cursor.total].every(
        (n) => Number.isInteger(n) && n >= 0,
      ) &&
      typeof cursor.dataKey === "string"
    ) {
      return cursor
    }
  } catch {
    // fall through
  }
  throw new BadRequestError("Invalid backup cursor. Start the backup again.")
}

const safeName = (name: string) => name.replace(/[^\w.\- ()]+/g, "_").slice(0, 200)

export const awsBackupService = {
  async status(userId: string): Promise<AwsBackupStatus> {
    return toStatus(await settingsRepository.get(userId, "AWS_BACKUP"))
  },

  /** Saves the bucket and key after a test write proves they work. */
  async connect(userId: string, input: AwsBackupInput): Promise<AwsBackupStatus> {
    const existing = await settingsRepository.get(userId, "AWS_BACKUP")
    const secret =
      input.secretAccessKey ||
      (existing && existing.accessKeyId === input.accessKeyId
        ? decryptSecret(existing.encryptedSecretAccessKey)
        : "")
    if (!secret) throw new BadRequestError("Enter the secret access key.")
    const prefix = input.prefix ? `${input.prefix.replace(/^\/+|\/+$/g, "")}/` : ""

    const client = userClient(input, secret)
    try {
      await client.send(
        new PutObjectCommand({
          Bucket: input.bucket,
          Key: `${prefix}${ROOT}connection-check.txt`,
          Body: `knot can write backups here. Checked ${nowIso()}.\n`,
          ContentType: "text/plain",
        }),
      )
    } catch (error) {
      explain(error, input.bucket)
    }

    const stored: StoredAwsBackup = {
      bucket: input.bucket,
      region: input.region,
      prefix,
      accessKeyId: input.accessKeyId,
      encryptedSecretAccessKey: encryptSecret(secret),
      connectedAt: existing?.connectedAt ?? nowIso(),
      ...(existing?.lastBackup ? { lastBackup: existing.lastBackup } : {}),
    }
    await settingsRepository.put(userId, "AWS_BACKUP", stored)
    if (!existing) {
      await activitiesService.record(userId, {
        type: "integration_connected",
        title: "AWS S3 backup connected",
        description: `s3://${input.bucket}/${prefix}`,
        entity: { type: "integration", id: "aws" },
      })
    }
    return toStatus(stored)
  },

  /** Forgets the access key. Backups already in the bucket stay there. */
  async disconnect(userId: string): Promise<AwsBackupStatus> {
    if (await settingsRepository.get(userId, "AWS_BACKUP")) {
      await settingsRepository.remove(userId, "AWS_BACKUP")
      await activitiesService.record(userId, {
        type: "integration_disconnected",
        title: "AWS S3 backup disconnected",
        entity: { type: "integration", id: "aws" },
      })
    }
    return toStatus(undefined)
  },

  /** One step of a backup. Call with the returned cursor until `done`. */
  async backup(userId: string, cursorValue?: string): Promise<BackupProgress> {
    const started = Date.now()
    const stored = await settingsRepository.get(userId, "AWS_BACKUP")
    if (!stored) throw new ConflictError("Connect your S3 bucket first.")
    const client = userClient(stored, decryptSecret(stored.encryptedSecretAccessKey))
    const base = `${stored.prefix}${ROOT}`

    const documents = (await repositories.documents.list(userId))
      .filter((doc) => doc.s3Key)
      .sort((a, b) => a.id.localeCompare(b.id))

    let cursor: Cursor
    if (cursorValue) {
      cursor = decodeCursor(cursorValue)
    } else {
      // First step: write the data export.
      const stamp = new Date()
        .toISOString()
        .replace(/[-:]/g, "")
        .replace(/\.\d+Z$/, "Z")
      const dataKey = `${base}data/knot-${stamp}.json`
      try {
        await client.send(
          new PutObjectCommand({
            Bucket: stored.bucket,
            Key: dataKey,
            Body: JSON.stringify(await exportData(userId), null, 2),
            ContentType: "application/json",
          }),
        )
      } catch (error) {
        explain(error, stored.bucket)
      }
      cursor = { stamp, dataKey, index: 0, copied: 0, bytes: 0, failed: 0, total: documents.length }
    }

    const knotBucket = getConfig().bucketName
    while (cursor.index < documents.length && Date.now() - started < STEP_BUDGET_MS) {
      const doc = documents[cursor.index]
      cursor.index++
      if (!doc?.s3Key) continue
      const key = `${base}documents/${doc.id}/${safeName(doc.name)}`
      try {
        const existing = await client
          .send(new HeadObjectCommand({ Bucket: stored.bucket, Key: key }))
          .catch(() => undefined)
        if (existing?.ContentLength === doc.sizeBytes) {
          cursor.copied++
          continue
        }
        const object = await getS3Client().send(
          new GetObjectCommand({ Bucket: knotBucket, Key: doc.s3Key }),
        )
        if (!object.Body) throw new Error("Empty object body")
        const body = await object.Body.transformToByteArray()
        await client.send(
          new PutObjectCommand({
            Bucket: stored.bucket,
            Key: key,
            Body: body,
            ContentType: doc.mimeType ?? object.ContentType ?? "application/octet-stream",
          }),
        )
        cursor.copied++
        cursor.bytes += body.byteLength
      } catch (error) {
        if (
          error instanceof S3ServiceException &&
          ["InvalidAccessKeyId", "SignatureDoesNotMatch", "AccessDenied", "NoSuchBucket"].includes(
            error.name,
          )
        ) {
          explain(error, stored.bucket)
        }
        logger.warn("Backup: document copy failed", { id: doc.id, error: serializeError(error) })
        cursor.failed++
      }
    }

    const progress = {
      copied: cursor.copied,
      total: documents.length,
      bytes: cursor.bytes,
      failed: cursor.failed,
      dataKey: cursor.dataKey,
    }
    if (cursor.index < documents.length) {
      return { done: false, cursor: encodeCursor(cursor), ...progress }
    }

    const summary: BackupSummary = {
      at: nowIso(),
      dataKey: cursor.dataKey,
      documents: cursor.copied,
      bytes: cursor.bytes,
      failed: cursor.failed,
    }
    const latest = await settingsRepository.get(userId, "AWS_BACKUP")
    if (latest)
      await settingsRepository.put(userId, "AWS_BACKUP", { ...latest, lastBackup: summary })
    await activitiesService.record(userId, {
      type: "integration_synced",
      title: "Backed up to S3",
      description: `${summary.documents} document${summary.documents === 1 ? "" : "s"}${summary.failed ? `, ${summary.failed} failed` : ""}`,
      entity: { type: "integration", id: "aws" },
    })
    return { done: true, ...progress, summary }
  },
}
