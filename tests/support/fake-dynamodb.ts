import {
  BatchWriteCommand,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb"

type Item = Record<string, unknown> & { PK: string; SK: string }

function conditionFailed(): Error {
  const error = new Error("The conditional request failed")
  error.name = "ConditionalCheckFailedException"
  return error
}

/**
 * In-memory stand-in for the DynamoDB document client, covering exactly the
 * operations the repositories use. Items are deep-copied in and out, like the
 * real service.
 */
export class FakeDynamoDB {
  readonly items = new Map<string, Item>()
  /** Number of upcoming BatchWrite calls that report everything unprocessed. */
  failNextBatchWrites = 0
  calls: string[] = []

  private id(key: { PK: unknown; SK: unknown }) {
    return `${String(key.PK)}|${String(key.SK)}`
  }

  async send(command: unknown): Promise<unknown> {
    this.calls.push((command as object).constructor.name)
    if (command instanceof GetCommand) {
      const item = this.items.get(this.id(command.input.Key as Item))
      return { Item: item ? structuredClone(item) : undefined }
    }
    if (command instanceof PutCommand) {
      const item = structuredClone(command.input.Item as Item)
      const exists = this.items.has(this.id(item))
      const condition = command.input.ConditionExpression
      if (condition === "attribute_not_exists(PK)" && exists) throw conditionFailed()
      if (condition === "attribute_exists(PK)" && !exists) throw conditionFailed()
      this.items.set(this.id(item), item)
      return {}
    }
    if (command instanceof DeleteCommand) {
      const key = this.id(command.input.Key as Item)
      const old = this.items.get(key)
      this.items.delete(key)
      return { Attributes: old }
    }
    if (command instanceof QueryCommand) return this.query(command)
    if (command instanceof BatchWriteCommand) {
      const [table, requests = []] = Object.entries(command.input.RequestItems ?? {})[0] ?? []
      if (this.failNextBatchWrites > 0) {
        this.failNextBatchWrites--
        return { UnprocessedItems: { [table as string]: requests } }
      }
      for (const request of requests) {
        if (request.PutRequest) {
          const item = structuredClone(request.PutRequest.Item as Item)
          this.items.set(this.id(item), item)
        } else if (request.DeleteRequest) {
          this.items.delete(this.id(request.DeleteRequest.Key as Item))
        }
      }
      return { UnprocessedItems: {} }
    }
    throw new Error(`FakeDynamoDB: unsupported command ${(command as object).constructor.name}`)
  }

  private query(command: QueryCommand) {
    const {
      ExpressionAttributeValues: values = {},
      Limit,
      ExclusiveStartKey,
      ScanIndexForward,
    } = command.input
    const pk = values[":pk"] as string
    const prefix = (values[":prefix"] as string | undefined) ?? ""
    let matches = [...this.items.values()]
      .filter((item) => item.PK === pk && item.SK.startsWith(prefix))
      .sort((a, b) => a.SK.localeCompare(b.SK))
    if (ScanIndexForward === false) matches.reverse()
    if (ExclusiveStartKey) {
      const index = matches.findIndex((item) => item.SK === ExclusiveStartKey.SK)
      matches = matches.slice(index + 1)
    }
    const page = Limit ? matches.slice(0, Limit) : matches
    const more = Limit !== undefined && matches.length > Limit
    const last = page.at(-1)
    return {
      Items: page.map((item) => structuredClone(item)),
      LastEvaluatedKey: more && last ? { PK: last.PK, SK: last.SK } : undefined,
    }
  }

  asClient(): DynamoDBDocumentClient {
    return this as unknown as DynamoDBDocumentClient
  }
}
