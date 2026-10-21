import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  UpdateTimeToLiveCommand,
} from "@aws-sdk/client-dynamodb"

import type { Config } from "../src/lib/config"

/**
 * Creates the single table in a local DynamoDB (DynamoDB Local or dynalite)
 * with the same keys as template.yaml. Never used against AWS.
 */
export async function ensureLocalTable(config: Config): Promise<"created" | "exists"> {
  if (!config.dynamodbEndpoint) throw new Error("ensureLocalTable only targets a local endpoint")
  const client = new DynamoDBClient({
    region: config.region,
    endpoint: config.dynamodbEndpoint,
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  })
  try {
    await client.send(new DescribeTableCommand({ TableName: config.tableName }))
    return "exists"
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "ResourceNotFoundException") throw error
  }
  await client.send(
    new CreateTableCommand({
      TableName: config.tableName,
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [
        { AttributeName: "PK", AttributeType: "S" },
        { AttributeName: "SK", AttributeType: "S" },
      ],
      KeySchema: [
        { AttributeName: "PK", KeyType: "HASH" },
        { AttributeName: "SK", KeyType: "RANGE" },
      ],
    }),
  )
  try {
    await client.send(
      new UpdateTimeToLiveCommand({
        TableName: config.tableName,
        TimeToLiveSpecification: { AttributeName: "ttl", Enabled: true },
      }),
    )
  } catch {
    // Local emulators may not implement TTL; it only matters in AWS.
  }
  return "created"
}
