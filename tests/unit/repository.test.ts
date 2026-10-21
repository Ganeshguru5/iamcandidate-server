import { describe, expect, it } from "vitest"

import { ConflictError, NotFoundError } from "../../src/lib/errors"
import type { Activity, Skill } from "../../src/models"
import {
  activityRepository,
  EntityRepository,
  settingsRepository,
} from "../../src/repositories/dynamodb"
import { testState } from "../support/setup"

const skills = new EntityRepository<Skill>("SKILL", "Skill")
const skill = (id: string, name = id): Skill => ({
  id,
  name,
  group: "frontend",
  proficiency: 80,
  years: 3,
})

describe("EntityRepository (single-table)", () => {
  it("stores items under USER#<id> / <TYPE>#<id> and strips keys on read", async () => {
    await skills.create("u1", skill("sk_1", "React"))

    const stored = testState.db.items.get("USER#u1|SKILL#sk_1")
    expect(stored).toMatchObject({
      PK: "USER#u1",
      SK: "SKILL#sk_1",
      entityType: "SKILL",
      userId: "u1",
    })
    expect(await skills.get("u1", "sk_1")).toEqual(skill("sk_1", "React"))
  })

  it("isolates users and entity types", async () => {
    await skills.create("u1", skill("sk_1"))
    await skills.create("u2", skill("sk_2"))
    await new EntityRepository<Skill>("NOTE", "Note").create("u1", skill("note_1"))

    expect((await skills.list("u1")).map((s) => s.id)).toEqual(["sk_1"])
    expect(await skills.get("u2", "sk_1")).toBeUndefined()
  })

  it("refuses to create a duplicate id (409)", async () => {
    await skills.create("u1", skill("sk_1"))
    await expect(skills.create("u1", skill("sk_1"))).rejects.toBeInstanceOf(ConflictError)
  })

  it("replace requires an existing item (404) and delete returns the old item", async () => {
    await expect(skills.replace("u1", skill("sk_x"))).rejects.toBeInstanceOf(NotFoundError)

    await skills.create("u1", skill("sk_1", "React"))
    await skills.replace("u1", { ...skill("sk_1", "React"), proficiency: 95 })
    expect((await skills.get("u1", "sk_1"))?.proficiency).toBe(95)

    expect((await skills.delete("u1", "sk_1")).name).toBe("React")
    await expect(skills.delete("u1", "sk_1")).rejects.toBeInstanceOf(NotFoundError)
  })

  it("putMany batches in 25s and retries unprocessed items", async () => {
    testState.db.failNextBatchWrites = 1
    await skills.putMany(
      "u1",
      Array.from({ length: 30 }, (_, i) => skill(`sk_${String(i).padStart(2, "0")}`)),
    )
    expect(await skills.list("u1")).toHaveLength(30)
    expect(testState.db.calls.filter((c) => c === "BatchWriteCommand")).toHaveLength(3)
  })
})

describe("activityRepository", () => {
  it("returns newest first with cursor pagination", async () => {
    const make = (n: number): Activity => ({
      id: `act_${n}`,
      type: "note_created",
      title: `Note ${n}`,
      date: new Date(Date.UTC(2026, 9, n)).toISOString(),
    })
    await activityRepository.putMany("u1", [1, 2, 3, 4, 5].map(make))

    const first = await activityRepository.list("u1", { limit: 2 })
    expect(first.items.map((a) => a.id)).toEqual(["act_5", "act_4"])
    expect(first.items[0]).not.toHaveProperty("ttl")
    expect(first.nextCursor).toBeDefined()

    const second = await activityRepository.list("u1", {
      limit: 2,
      cursor: first.nextCursor as string,
    })
    expect(second.items.map((a) => a.id)).toEqual(["act_3", "act_2"])
  })

  it("rejects cursors that point into another user's partition", async () => {
    const forged = Buffer.from(
      JSON.stringify({ PK: "USER#someone-else", SK: "ACTIVITY#x" }),
    ).toString("base64url")
    await expect(activityRepository.list("u1", { limit: 5, cursor: forged })).rejects.toThrow(
      "Invalid cursor",
    )
  })
})

describe("settingsRepository", () => {
  it("stores singleton documents per user", async () => {
    expect(await settingsRepository.get("u1", "PROFILE")).toBeUndefined()
    const profile = { name: "Ganeshguru", email: "g@example.com", role: "", bio: "", location: "" }
    await settingsRepository.put("u1", "PROFILE", profile)
    expect(await settingsRepository.get("u1", "PROFILE")).toEqual(profile)
  })
})
