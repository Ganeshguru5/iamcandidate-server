import {
  BatchWriteCommand,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  type QueryCommandInput,
} from "@aws-sdk/lib-dynamodb"

import { getConfig } from "../../lib/config"
import { getDocumentClient } from "../../lib/dynamodb"

/**
 * Low-level single-table helpers. Every item belongs to one user:
 *
 *   PK = USER#<userId>     SK = <TYPE>#<id>
 *
 * See docs/dynamodb-design.md for the full key design.
 */
export type Key = { PK: string; SK: string }
export type StoredItem = Key & Record<string, unknown>

/** Attributes that exist only for DynamoDB and never reach API clients. */
const INTERNAL_ATTRIBUTES = ["PK", "SK", "entityType", "userId", "ttl"] as const

export const userPk = (userId: string) => `USER#${userId}`

export function stripKeys<T>(item: Record<string, unknown>): T {
  const copy: Record<string, unknown> = { ...item }
  for (const attribute of INTERNAL_ATTRIBUTES) delete copy[attribute]
  return copy as T
}

export function isConditionalCheckFailure(error: unknown): boolean {
  return error instanceof Error && error.name === "ConditionalCheckFailedException"
}

const tableName = () => getConfig().tableName

export async function getItem(key: Key): Promise<StoredItem | undefined> {
  const result = await getDocumentClient().send(
    new GetCommand({ TableName: tableName(), Key: key }),
  )
  return result.Item as StoredItem | undefined
}

export async function putItem(
  item: StoredItem,
  condition?: "attribute_not_exists(PK)" | "attribute_exists(PK)",
): Promise<void> {
  await getDocumentClient().send(
    new PutCommand({
      TableName: tableName(),
      Item: item,
      ...(condition ? { ConditionExpression: condition } : {}),
    }),
  )
}

/** Deletes an item and returns what was there (undefined when nothing was). */
export async function deleteItem(key: Key): Promise<StoredItem | undefined> {
  const result = await getDocumentClient().send(
    new DeleteCommand({ TableName: tableName(), Key: key, ReturnValues: "ALL_OLD" }),
  )
  return result.Attributes as StoredItem | undefined
}

/** Reads every item in a user's partition whose SK starts with `prefix`. */
export async function queryAll(pk: string, prefix: string): Promise<StoredItem[]> {
  const items: StoredItem[] = []
  let startKey: QueryCommandInput["ExclusiveStartKey"]
  do {
    const page = await getDocumentClient().send(
      new QueryCommand({
        TableName: tableName(),
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
        ExpressionAttributeValues: { ":pk": pk, ":prefix": prefix },
        ExclusiveStartKey: startKey,
      }),
    )
    items.push(...((page.Items ?? []) as StoredItem[]))
    startKey = page.LastEvaluatedKey
  } while (startKey)
  return items
}

/** Reads every item in a partition (used to delete a user's data). */
export async function queryPartitionKeys(pk: string): Promise<Key[]> {
  const keys: Key[] = []
  let startKey: QueryCommandInput["ExclusiveStartKey"]
  do {
    const page = await getDocumentClient().send(
      new QueryCommand({
        TableName: tableName(),
        KeyConditionExpression: "PK = :pk",
        ExpressionAttributeValues: { ":pk": pk },
        ProjectionExpression: "PK, SK",
        ExclusiveStartKey: startKey,
      }),
    )
    keys.push(...((page.Items ?? []) as Key[]))
    startKey = page.LastEvaluatedKey
  } while (startKey)
  return keys
}

/** Deletes items in batches of 25, retrying unprocessed ones. */
export async function batchDelete(keys: Key[]): Promise<void> {
  for (let start = 0; start < keys.length; start += 25) {
    let requests: Array<{ DeleteRequest: { Key: Key } }> = keys
      .slice(start, start + 25)
      .map((Key) => ({ DeleteRequest: { Key } }))
    for (let attempt = 0; requests.length > 0; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 50))
      if (attempt > 6) throw new Error("BatchWrite did not complete after retries")
      const result = await getDocumentClient().send(
        new BatchWriteCommand({ RequestItems: { [tableName()]: requests } }),
      )
      requests = (result.UnprocessedItems?.[tableName()] ?? []) as typeof requests
    }
  }
}

/** One page of a prefix query, newest-first when SKs sort chronologically. */
export async function queryPage(
  pk: string,
  prefix: string,
  options: { limit: number; startKey?: Record<string, unknown>; newestFirst?: boolean },
): Promise<{ items: StoredItem[]; lastKey?: Record<string, unknown> }> {
  const page = await getDocumentClient().send(
    new QueryCommand({
      TableName: tableName(),
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
      ExpressionAttributeValues: { ":pk": pk, ":prefix": prefix },
      ScanIndexForward: !options.newestFirst,
      Limit: options.limit,
      ExclusiveStartKey: options.startKey,
    }),
  )
  return { items: (page.Items ?? []) as StoredItem[], lastKey: page.LastEvaluatedKey }
}

/** Writes items in batches of 25, retrying unprocessed items with backoff. */
export async function batchPut(items: StoredItem[]): Promise<void> {
  for (let start = 0; start < items.length; start += 25) {
    let requests: Array<{ PutRequest: { Item: StoredItem } }> = items
      .slice(start, start + 25)
      .map((Item) => ({ PutRequest: { Item } }))
    for (let attempt = 0; requests.length > 0; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 50))
      if (attempt > 6) throw new Error("BatchWrite did not complete after retries")
      const result = await getDocumentClient().send(
        new BatchWriteCommand({ RequestItems: { [tableName()]: requests } }),
      )
      requests = (result.UnprocessedItems?.[tableName()] ?? []) as typeof requests
    }
  }
}
