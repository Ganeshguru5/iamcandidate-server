/**
 * Runs the repositories against a real DynamoDB Local instance.
 * Opt-in because it needs Docker:
 *
 *   docker compose up -d dynamodb
 *   RUN_INTEGRATION=1 npm test
 */
import { CreateTableCommand, DeleteTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { resetConfig } from "../../src/lib/config"
import { setDocumentClient } from "../../src/lib/dynamodb"
import type { Skill } from "../../src/models"
import { activityRepository, EntityRepository } from "../../src/repositories/dynamodb"

const endpoint = process.env.INTEGRATION_DYNAMODB_ENDPOINT ?? "http://localhost:8000"
const table = `personal-os-it-${Date.now()}`
const admin = new DynamoDBClient({
  region: "ap-south-1",
  endpoint,
  credentials: { accessKeyId: "local", secretAccessKey: "local" },
})

describe.runIf(process.env.RUN_INTEGRATION === "1")("DynamoDB Local", () => {
  beforeAll(async () => {
    await admin.send(
      new CreateTableCommand({
        TableName: table,
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
  })

  beforeEach(() => {
    // Replace the in-memory fake installed by tests/support/setup.ts.
    Object.assign(process.env, { DYNAMODB_TABLE: table, DYNAMODB_ENDPOINT: endpoint })
    resetConfig()
    setDocumentClient(undefined)
  })

  afterAll(async () => {
    await admin.send(new DeleteTableCommand({ TableName: table }))
  })

  it("performs CRUD, conditional writes and paginated queries", async () => {
    const skills = new EntityRepository<Skill>("SKILL", "Skill")
    const skill: Skill = { id: "sk_1", name: "React", group: "frontend", proficiency: 90, years: 5 }

    await skills.create("u1", skill)
    await expect(skills.create("u1", skill)).rejects.toThrow("already exists")
    expect(await skills.get("u1", "sk_1")).toEqual(skill)

    await skills.putMany(
      "u1",
      Array.from({ length: 40 }, (_, i) => ({ ...skill, id: `sk_bulk_${i}` })),
    )
    expect(await skills.list("u1")).toHaveLength(41)

    await skills.delete("u1", "sk_1")
    expect(await skills.get("u1", "sk_1")).toBeUndefined()

    await activityRepository.add("u1", { type: "note_created", title: "first" })
    await new Promise((resolve) => setTimeout(resolve, 5))
    await activityRepository.add("u1", { type: "note_created", title: "second" })
    const page = await activityRepository.list("u1", { limit: 1 })
    expect(page.items[0]?.title).toBe("second")
    expect(page.nextCursor).toBeDefined()
  })
})
