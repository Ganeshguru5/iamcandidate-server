import { DynamoDBClient } from "@aws-sdk/client-dynamodb"
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb"

import { getConfig } from "./config"

let client: DynamoDBDocumentClient | undefined

/**
 * Shared DynamoDB document client. Uses `DYNAMODB_ENDPOINT` when set (DynamoDB
 * Local) and the regional AWS endpoint otherwise. Created lazily and reused
 * across warm Lambda invocations.
 */
export function getDocumentClient(): DynamoDBDocumentClient {
  if (client) return client
  const { region, dynamodbEndpoint } = getConfig()
  const base = new DynamoDBClient({
    region,
    // DynamoDB Local accepts any credentials. Fixed ones keep the Lambda
    // containers, scripts and tests pointed at the same local database.
    ...(dynamodbEndpoint
      ? {
          endpoint: dynamodbEndpoint,
          credentials: { accessKeyId: "local", secretAccessKey: "local" },
        }
      : {}),
  })
  client = DynamoDBDocumentClient.from(base, {
    marshallOptions: { removeUndefinedValues: true },
  })
  return client
}

/** Test hook: swap the client for a fake. */
export function setDocumentClient(next: DynamoDBDocumentClient | undefined) {
  client = next
}
