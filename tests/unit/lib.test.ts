import { z } from "zod"
import { describe, expect, it } from "vitest"

import { LocalClock } from "../../src/lib/time"
import { applyPatch, patchSchema } from "../../src/lib/validation"
import { bumpVersion } from "../../src/services/resumes.service"

describe("patchSchema / applyPatch", () => {
  const schema = patchSchema(z.object({ name: z.string(), nickname: z.string().optional() }))

  it("allows null only for optional fields", () => {
    expect(schema.safeParse({ nickname: null }).success).toBe(true)
    expect(schema.safeParse({ name: null }).success).toBe(false)
    expect(schema.safeParse({}).success).toBe(false)
    expect(schema.safeParse({ unknown: 1 }).success).toBe(false)
  })

  it("removes null fields and keeps untouched ones", () => {
    expect(applyPatch({ name: "a", nickname: "b" }, { nickname: null })).toEqual({ name: "a" })
    expect(applyPatch({ name: "a" }, { name: "c", nickname: undefined })).toEqual({ name: "c" })
  })
})

describe("LocalClock", () => {
  it("uses the caller's calendar day", () => {
    // 2026-10-20T20:00Z is already Oct 21 in IST.
    const clock = new LocalClock(Date.parse("2026-10-20T20:00:00Z"), -330)
    expect(clock.isToday("2026-10-21T05:00:00Z")).toBe(true)
    expect(clock.isOverdue("2026-10-20T10:00:00Z")).toBe(true)
    expect(clock.dateKey(clock.startOfWeek(clock.now))).toBe("2026-10-19")
  })
})

describe("bumpVersion", () => {
  it("increments the minor version", () => {
    expect(bumpVersion("v3.2")).toBe("v3.3")
    expect(bumpVersion("draft")).toBe("draft")
  })
})
