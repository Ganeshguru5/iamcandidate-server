import { BadRequestError } from "../../lib/errors"
import { createId } from "../../lib/ids"
import type { Activity, NewActivity } from "../../models"
import { batchPut, putItem, queryPage, stripKeys, userPk, type StoredItem } from "./table"

/** Activities expire after a year (DynamoDB TTL on the `ttl` attribute). */
const RETENTION_SECONDS = 365 * 24 * 60 * 60

function toItem(userId: string, activity: Activity): StoredItem {
  return {
    ...activity,
    PK: userPk(userId),
    // ISO dates sort lexicographically, so the SK orders the feed by time.
    SK: `ACTIVITY#${activity.date}#${activity.id}`,
    entityType: "ACTIVITY",
    userId,
    ttl: Math.floor(Date.parse(activity.date) / 1000) + RETENTION_SECONDS,
  }
}

/**
 * The feed is ordered by date, so two events in the same millisecond (e.g.
 * create then delete) would tie and sort randomly by id. Keep dates strictly
 * increasing within a process.
 */
let lastActivityMs = 0
function nextActivityDate(): string {
  lastActivityMs = Math.max(Date.now(), lastActivityMs + 1)
  return new Date(lastActivityMs).toISOString()
}

function encodeCursor(key: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(key)).toString("base64url")
}

function decodeCursor(cursor: string, userId: string): Record<string, unknown> {
  try {
    const key = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >
    if (key.PK === userPk(userId) && typeof key.SK === "string" && key.SK.startsWith("ACTIVITY#")) {
      return key
    }
  } catch {
    // fall through
  }
  throw new BadRequestError("Invalid cursor")
}

export const activityRepository = {
  async add(userId: string, entry: NewActivity): Promise<Activity> {
    const activity: Activity = { ...entry, id: createId("act"), date: nextActivityDate() }
    await putItem(toItem(userId, activity))
    return activity
  },

  async putMany(userId: string, activities: Activity[]): Promise<void> {
    await batchPut(activities.map((activity) => toItem(userId, activity)))
  },

  /** Newest first, paginated with an opaque cursor. */
  async list(
    userId: string,
    options: { limit: number; cursor?: string },
  ): Promise<{ items: Activity[]; nextCursor?: string }> {
    const page = await queryPage(userPk(userId), "ACTIVITY#", {
      limit: options.limit,
      newestFirst: true,
      ...(options.cursor ? { startKey: decodeCursor(options.cursor, userId) } : {}),
    })
    return {
      items: page.items.map((item) => stripKeys<Activity>(item)),
      ...(page.lastKey ? { nextCursor: encodeCursor(page.lastKey) } : {}),
    }
  },
}
