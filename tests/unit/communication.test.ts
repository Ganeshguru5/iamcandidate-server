import type { AddressInfo } from "node:net"

import { SMTPServer } from "smtp-server"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"

import { handler } from "../../src/functions/communication"
import { resetConfig } from "../../src/lib/config"
import type { Application, Contact, Email, EmailTemplate, SmtpSettings } from "../../src/models"
import { activityRepository, repositories } from "../../src/repositories/dynamodb"
import { call } from "../support/http"
import { testState } from "../support/setup"

/* A real SMTP server on localhost that accepts one account and records mail. */
const received: Array<{ from: string; to: string[]; raw: string }> = []
let port = 0
const smtp = new SMTPServer({
  authOptional: false,
  allowInsecureAuth: true,
  disabledCommands: ["STARTTLS"],
  logger: false,
  onAuth(auth, _session, callback) {
    if (auth.username === "me@example.com" && auth.password === "app-password-123") {
      return callback(null, { user: auth.username })
    }
    return callback(new Error("Invalid username or password"))
  },
  onData(stream, session, callback) {
    let raw = ""
    stream.on("data", (chunk: Buffer) => (raw += chunk.toString("utf8")))
    stream.on("end", () => {
      received.push({
        from: session.envelope.mailFrom ? session.envelope.mailFrom.address : "",
        to: session.envelope.rcptTo.map((r) => r.address),
        raw,
      })
      callback()
    })
  },
})

beforeAll(async () => {
  await new Promise<void>((resolve) => smtp.listen(0, "127.0.0.1", resolve))
  port = (smtp.server.address() as AddressInfo).port
})
afterAll(() => new Promise<void>((resolve) => smtp.close(() => resolve())))
afterEach(() => {
  received.length = 0
  process.env.ALLOW_PRIVATE_SMTP_HOSTS = "true"
  resetConfig()
})

function settings(overrides: Partial<SmtpSettings> = {}) {
  return {
    host: "localhost",
    port,
    username: "me@example.com",
    password: "app-password-123",
    encryption: "none",
    senderName: "Alex Morgan",
    senderEmail: "me@example.com",
    ...overrides,
  }
}

const compose = (overrides: Record<string, unknown> = {}) => ({
  to: ["Recruiter@Acme.example"],
  cc: [],
  subject: "Following up",
  body: "Hi Maya,\n\nThanks for your time.",
  ...overrides,
})

describe("SMTP settings", () => {
  it("encrypts the password at rest and never returns it", async () => {
    const res = await call<SmtpSettings>(handler, "PUT", "/settings/smtp", { body: settings() })
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ host: "localhost", password: "", hasPassword: true })

    const stored = testState.db.items.get("USER#usr_test|SETTINGS#SMTP")
    expect(JSON.stringify(stored)).not.toContain("app-password-123")
    expect(stored?.encryptedPassword).toMatch(/^v1\./)

    const get = await call<SmtpSettings>(handler, "GET", "/settings/smtp")
    expect(get.body.data?.password).toBe("")
  })

  it("keeps the stored password when saving with an empty one", async () => {
    await call(handler, "PUT", "/settings/smtp", { body: settings() })
    await call(handler, "PUT", "/settings/smtp", {
      body: settings({ password: "", senderName: "G" }),
    })
    const test = await call(handler, "POST", "/settings/smtp/test", {
      body: settings({ password: "" }),
    })
    expect(test.status).toBe(200)
  })

  it("requires a password the first time", async () => {
    const res = await call(handler, "PUT", "/settings/smtp", { body: settings({ password: "" }) })
    expect(res.status).toBe(400)
  })

  it("tests the real connection and explains auth failures", async () => {
    const ok = await call<{ ok: boolean; latencyMs: number }>(
      handler,
      "POST",
      "/settings/smtp/test",
      {
        body: settings(),
      },
    )
    expect(ok.status).toBe(200)
    expect(ok.body.data?.ok).toBe(true)

    const bad = await call(handler, "POST", "/settings/smtp/test", {
      body: settings({ password: "wrong" }),
    })
    expect(bad.status).toBe(502)
    expect(bad.body.error?.code).toBe("SMTP_ERROR")
    expect(bad.body.error?.message).toContain("app password")
    expect(bad.body.error?.message).not.toContain("wrong")
  })

  it("refuses private hosts unless explicitly allowed", async () => {
    process.env.ALLOW_PRIVATE_SMTP_HOSTS = "false"
    resetConfig()
    const res = await call(handler, "PUT", "/settings/smtp", { body: settings() })
    expect(res.status).toBe(400)
    expect(res.body.error?.message).toContain("public mail server")
  })
})

describe("sending", () => {
  it("asks for setup before the first send", async () => {
    const res = await call(handler, "POST", "/emails/send", { body: compose() })
    expect(res.status).toBe(400)
    expect(res.body.error?.message).toContain("Settings")
  })

  it("delivers through the user's SMTP account and tracks the email", async () => {
    await call(handler, "PUT", "/settings/smtp", { body: settings() })
    const contact: Contact = {
      id: "ct_maya",
      name: "Maya Patel",
      role: "Recruiter",
      email: "recruiter@acme.example",
      relationship: "recruiter",
      notes: "",
      createdAt: "2026-10-01T00:00:00.000Z",
    }
    const application: Application = {
      id: "app_acme",
      companyId: "cmp_acme",
      role: "Frontend Engineer",
      location: "",
      workMode: "remote",
      status: "applied",
      priority: "high",
      notes: "",
      timeline: [],
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    }
    const template: EmailTemplate = {
      id: "tpl_follow",
      name: "Follow-up",
      category: "follow_up",
      subject: "Following up",
      body: "",
      usageCount: 2,
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    }
    await repositories.contacts.putMany("usr_test", [contact])
    await repositories.applications.putMany("usr_test", [application])
    await repositories.templates.putMany("usr_test", [template])

    const res = await call<Email>(handler, "POST", "/emails/send", {
      body: compose({
        cc: ["boss@acme.example"],
        applicationId: "app_acme",
        templateId: "tpl_follow",
      }),
    })
    expect(res.status).toBe(201)
    expect(res.body.data).toMatchObject({
      folder: "sent",
      from: { name: "Alex Morgan", email: "me@example.com" },
      to: ["recruiter@acme.example"],
      applicationId: "app_acme",
    })
    expect(res.body.data?.messageId).toBeTruthy()

    // Actually delivered.
    expect(received).toHaveLength(1)
    expect(received[0]?.from).toBe("me@example.com")
    expect(received[0]?.to).toEqual(["recruiter@acme.example", "boss@acme.example"])
    expect(received[0]?.raw).toContain("Subject: Following up")
    expect(received[0]?.raw).toContain("Thanks for your time.")

    // Tracked.
    const sent = await call<Email[]>(handler, "GET", "/emails", { query: { folder: "sent" } })
    expect(sent.body.data).toHaveLength(1)
    expect((await repositories.contacts.get("usr_test", "ct_maya"))?.lastContacted).toBe(
      res.body.data?.date,
    )
    const timeline = (await repositories.applications.get("usr_test", "app_acme"))?.timeline ?? []
    expect(timeline.at(-1)).toMatchObject({ type: "email", title: "Email sent: Following up" })
    expect((await repositories.templates.get("usr_test", "tpl_follow"))?.usageCount).toBe(3)
    const feed = await activityRepository.list("usr_test", { limit: 5 })
    expect(feed.items[0]).toMatchObject({ type: "email_sent", title: "Email sent to Maya Patel" })
  })

  it("reports SMTP failures without storing the email", async () => {
    // Nothing listens on port 1, so the connection is refused.
    await call(handler, "PUT", "/settings/smtp", { body: settings({ port: 1 }) })
    const res = await call(handler, "POST", "/emails/send", { body: compose() })
    expect(res.status).toBe(502)
    expect(res.body.error?.message).toContain("Couldn't connect to localhost:1")
    expect((await call<Email[]>(handler, "GET", "/emails")).body.data).toEqual([])
  })

  it("validates recipients", async () => {
    expect(
      (await call(handler, "POST", "/emails/send", { body: compose({ to: [] }) })).status,
    ).toBe(400)
    expect(
      (await call(handler, "POST", "/emails/send", { body: compose({ to: ["not-an-email"] }) }))
        .status,
    ).toBe(400)
  })
})

describe("drafts and mailbox actions", () => {
  it("creates and updates drafts, stars and deletes", async () => {
    const draft = await call<Email>(handler, "POST", "/emails/drafts", {
      body: compose({ to: [] }),
    })
    expect(draft.status).toBe(201)
    expect(draft.body.data?.folder).toBe("drafts")
    const id = draft.body.data?.id as string

    const updated = await call<Email>(handler, "PUT", `/emails/drafts/${id}`, {
      body: compose({ subject: "v2" }),
    })
    expect(updated.body.data).toMatchObject({ id, subject: "v2", folder: "drafts" })

    const starred = await call<Email>(handler, "PUT", `/emails/${id}`, { body: { starred: true } })
    expect(starred.body.data?.starred).toBe(true)

    expect((await call(handler, "DELETE", `/emails/${id}`)).status).toBe(204)
    expect((await call(handler, "GET", `/emails/${id}`)).status).toBe(404)
  })
})

describe("templates", () => {
  it("supports CRUD and duplicate", async () => {
    const created = await call<EmailTemplate>(handler, "POST", "/templates", {
      body: {
        name: "Referral ask",
        category: "referral",
        subject: "Referral?",
        body: "Hi {{name}}",
      },
    })
    expect(created.body.data).toMatchObject({ usageCount: 0 })
    const copy = await call<EmailTemplate>(
      handler,
      "POST",
      `/templates/${created.body.data?.id}/duplicate`,
    )
    expect(copy.body.data?.name).toBe("Referral ask (copy)")
    const list = (await call<EmailTemplate[]>(handler, "GET", "/templates")).body.data ?? []
    // The two created here, plus the default templates seeded on first list.
    expect(list.filter((t) => !t.id.startsWith("tpl_default_"))).toHaveLength(2)
  })
})
