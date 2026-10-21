import { describe, expect, it } from "vitest"

import { handler } from "../../src/functions/career"
import type { Activity, Application, Company } from "../../src/models"
import { activityRepository } from "../../src/repositories/dynamodb"
import { call } from "../support/http"

const validApplication = {
  companyId: "cmp_acme",
  role: "Frontend Engineer",
  location: "Chennai",
  workMode: "remote",
  status: "applied",
  priority: "high",
  notes: "",
}

async function createCompany() {
  const res = await call<Company>(handler, "POST", "/companies", {
    body: {
      name: "Acme",
      industry: "SaaS",
      website: "https://acme.example",
      location: "Remote",
      size: "50-200",
      status: "target",
      description: "",
      notes: "",
    },
  })
  return res.body.data as Company
}

async function createApplication(overrides: Record<string, unknown> = {}) {
  const res = await call<Application>(handler, "POST", "/applications", {
    body: { ...validApplication, ...overrides },
  })
  expect(res.status).toBe(201)
  return res.body.data as Application
}

async function activities(): Promise<Activity[]> {
  return (await activityRepository.list("usr_test", { limit: 50 })).items
}

describe("applications API", () => {
  it("creates an application with timeline, appliedDate and an activity", async () => {
    const company = await createCompany()
    const app = await createApplication({ companyId: company.id })

    expect(app.id).toMatch(/^app_[a-f0-9]{16}$/)
    expect(app.timeline.map((e) => e.title)).toEqual([
      "Application created",
      "Status set to Applied",
    ])
    expect(app.appliedDate).toBeDefined()
    expect(app.createdAt).toBe(app.updatedAt)
    expect((await activities())[0]).toMatchObject({
      type: "application_created",
      title: "Applied to Acme — Frontend Engineer",
      entity: { type: "application", id: app.id },
    })
  })

  it("does not set appliedDate for wishlist items", async () => {
    const app = await createApplication({ status: "wishlist" })
    expect(app.appliedDate).toBeUndefined()
    expect(app.timeline).toHaveLength(1)
  })

  it("lists applications and filters by status", async () => {
    await createApplication({ status: "applied" })
    await createApplication({ status: "offer" })

    const all = await call<Application[]>(handler, "GET", "/applications")
    expect(all.status).toBe(200)
    expect(all.body).toMatchObject({ success: true })
    expect(all.body.data).toHaveLength(2)

    const offers = await call<Application[]>(handler, "GET", "/applications", {
      query: { status: "offer" },
    })
    expect(offers.body.data?.map((a) => a.status)).toEqual(["offer"])
  })

  it("gets one application by id", async () => {
    const app = await createApplication()
    const res = await call<Application>(handler, "GET", `/applications/${app.id}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual(app)
  })

  it("updates fields, appends a status timeline event and clears fields set to null", async () => {
    const app = await createApplication({
      salary: "₹30L",
      nextFollowUp: "2026-10-20T06:30:00.000Z",
    })

    const res = await call<Application>(handler, "PUT", `/applications/${app.id}`, {
      body: { status: "recruiter", salary: null, notes: "Recruiter reached out" },
    })

    expect(res.status).toBe(200)
    const updated = res.body.data as Application
    expect(updated.status).toBe("recruiter")
    expect(updated.salary).toBeUndefined()
    expect(updated.nextFollowUp).toBe("2026-10-20T06:30:00.000Z")
    expect(updated.notes).toBe("Recruiter reached out")
    expect(updated.timeline.at(-1)?.title).toBe("Moved to Recruiter")
    expect(updated.createdAt).toBe(app.createdAt)
    expect((await activities())[0]?.type).toBe("application_status_changed")
  })

  it("changes status via the status endpoint", async () => {
    const app = await createApplication({ status: "wishlist" })
    const res = await call<Application>(handler, "PUT", `/applications/${app.id}/status`, {
      body: { status: "applied" },
    })
    expect(res.body.data?.status).toBe("applied")
    expect(res.body.data?.appliedDate).toBeDefined()
  })

  it("adds a timeline event", async () => {
    const app = await createApplication()
    const res = await call<Application>(handler, "POST", `/applications/${app.id}/timeline`, {
      body: { date: "2026-10-19T10:00:00.000Z", title: "Sent thank-you note", type: "email" },
    })
    expect(res.status).toBe(201)
    expect(res.body.data?.timeline.at(-1)).toMatchObject({
      title: "Sent thank-you note",
      type: "email",
    })
  })

  it("deletes an application (204) and records an activity", async () => {
    const app = await createApplication()
    const res = await call(handler, "DELETE", `/applications/${app.id}`)
    expect(res.status).toBe(204)
    expect((await call(handler, "GET", `/applications/${app.id}`)).status).toBe(404)
    expect((await activities())[0]?.type).toBe("application_deleted")
  })

  describe("validation", () => {
    it("rejects a body missing required fields", async () => {
      const res = await call(handler, "POST", "/applications", { body: { role: "x" } })
      expect(res.status).toBe(400)
      expect(res.body).toMatchObject({ success: false, error: { code: "VALIDATION_ERROR" } })
      const paths = (res.body.error?.details as Array<{ path: string }>).map((d) => d.path)
      expect(paths).toEqual(expect.arrayContaining(["companyId", "workMode", "status", "priority"]))
    })

    it("rejects unknown enum values and unknown fields", async () => {
      const badStatus = await call(handler, "POST", "/applications", {
        body: { ...validApplication, status: "ghosted" },
      })
      expect(badStatus.status).toBe(400)
      const extra = await call(handler, "POST", "/applications", {
        body: { ...validApplication, isAdmin: true },
      })
      expect(extra.status).toBe(400)
    })

    it("rejects invalid dates and malformed JSON", async () => {
      const badDate = await call(handler, "POST", "/applications", {
        body: { ...validApplication, appliedDate: "yesterday" },
      })
      expect(badDate.status).toBe(400)

      const malformed = await handler({
        ...(await import("../support/http")).makeEvent("POST", "/applications"),
        body: "{not json",
      })
      expect(malformed.statusCode).toBe(400)
      expect(JSON.parse(malformed.body ?? "{}")).toMatchObject({ error: { code: "BAD_REQUEST" } })
    })

    it("rejects an empty update and nulls on required fields", async () => {
      const app = await createApplication()
      expect((await call(handler, "PUT", `/applications/${app.id}`, { body: {} })).status).toBe(400)
      expect(
        (await call(handler, "PUT", `/applications/${app.id}`, { body: { role: null } })).status,
      ).toBe(400)
    })

    it("rejects invalid query parameters", async () => {
      const res = await call(handler, "GET", "/applications", { query: { status: "nope" } })
      expect(res.status).toBe(400)
    })
  })

  describe("not found", () => {
    it("returns 404 for unknown ids on get, update, status and delete", async () => {
      for (const [method, path, body] of [
        ["GET", "/applications/app_missing", undefined],
        ["PUT", "/applications/app_missing", { notes: "x" }],
        ["PUT", "/applications/app_missing/status", { status: "offer" }],
        ["DELETE", "/applications/app_missing", undefined],
      ] as const) {
        const res = await call(handler, method, path, { body })
        expect(res.status, `${method} ${path}`).toBe(404)
        expect(res.body).toMatchObject({ success: false, error: { code: "NOT_FOUND" } })
      }
    })

    it("returns ROUTE_NOT_FOUND for unknown routes", async () => {
      const res = await call(handler, "PATCH", "/applications/x")
      expect(res.status).toBe(404)
      expect(res.body.error?.code).toBe("ROUTE_NOT_FOUND")
    })
  })

  describe("errors and CORS", () => {
    it("hides internal errors behind a generic 500", async () => {
      const { testState } = await import("../support/setup")
      testState.db.send = async () => {
        throw new Error("AccessDeniedException: arn:aws:dynamodb:secret-table")
      }
      const res = await call(handler, "GET", "/applications")
      expect(res.status).toBe(500)
      expect(res.body).toEqual({
        success: false,
        error: { code: "INTERNAL_ERROR", message: "Something went wrong" },
      })
    })

    it("echoes only allowed origins", async () => {
      const allowed = await call(handler, "GET", "/applications", {
        origin: "http://localhost:3000",
      })
      expect(allowed.headers["access-control-allow-origin"]).toBe("http://localhost:3000")
      const denied = await call(handler, "GET", "/applications", { origin: "https://evil.example" })
      expect(denied.headers["access-control-allow-origin"]).toBeUndefined()
    })
  })
})
