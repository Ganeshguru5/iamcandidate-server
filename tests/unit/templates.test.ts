import { describe, expect, it } from "vitest"

import { handler } from "../../src/functions/communication"
import { DEFAULT_TEMPLATES, LINKEDIN_CONNECTION_NOTE_LIMIT } from "../../src/lib/default-templates"
import type { EmailTemplate } from "../../src/models"
import { repositories, settingsRepository } from "../../src/repositories/dynamodb"
import { usersService } from "../../src/services/users.service"
import { call } from "../support/http"

const USER = "usr_test"
const listTemplates = () => call<EmailTemplate[]>(handler, "GET", "/templates")

describe("default email templates", () => {
  it("only uses variables the composer can fill", () => {
    const allowed = new Set(["name", "company", "role", "jobUrl", "jobId", "senderName"])
    for (const template of DEFAULT_TEMPLATES) {
      const used = [...`${template.subject}\n${template.body}`.matchAll(/\{\{\s*(\w+)\s*\}\}/g)]
      for (const [, variable] of used) expect(allowed).toContain(variable)
    }
    expect(new Set(DEFAULT_TEMPLATES.map((t) => t.id)).size).toBe(DEFAULT_TEMPLATES.length)
  })

  it("seeds an existing account on its first list, once", async () => {
    const first = await listTemplates()
    expect(first.status).toBe(200)
    expect(first.body.data).toHaveLength(DEFAULT_TEMPLATES.length)
    expect(first.body.data?.every((t) => t.usageCount === 0)).toBe(true)

    const again = await listTemplates()
    expect(again.body.data).toHaveLength(DEFAULT_TEMPLATES.length)
    expect((await settingsRepository.get(USER, "TEMPLATE_DEFAULTS"))?.version).toBe(2)
  })

  it("keeps the user's own templates and skips defaults with the same name", async () => {
    await repositories.templates.create(USER, {
      id: "tpl_mine",
      name: "Referral Request",
      category: "referral",
      subject: "Mine",
      body: "My own wording",
      usageCount: 3,
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    })
    const res = await listTemplates()
    // An old template without a channel counts as email; the LinkedIn one has its own name space.
    const emailNames =
      res.body.data
        ?.filter((t) => (t.channel ?? "email") === "email")
        .map((t) => t.name.toLowerCase()) ?? []
    expect(emailNames.filter((n) => n === "referral request")).toHaveLength(1)
    expect(res.body.data).toHaveLength(DEFAULT_TEMPLATES.length) // 1 own + all defaults but one
    expect(res.body.data?.find((t) => t.id === "tpl_mine")?.body).toBe("My own wording")
  })

  it("doesn't bring back a deleted default until restored", async () => {
    await listTemplates()
    const id = DEFAULT_TEMPLATES[0]?.id as string
    expect((await call(handler, "DELETE", `/templates/${id}`)).status).toBe(204)
    expect((await listTemplates()).body.data).toHaveLength(DEFAULT_TEMPLATES.length - 1)

    const restored = await call<{ added: number; templates: EmailTemplate[] }>(
      handler,
      "POST",
      "/templates/defaults",
    )
    expect(restored.status).toBe(200)
    expect(restored.body.data?.added).toBe(1)
    expect(restored.body.data?.templates).toHaveLength(DEFAULT_TEMPLATES.length)

    const twice = await call<{ added: number }>(handler, "POST", "/templates/defaults")
    expect(twice.body.data?.added).toBe(0)
  })

  it("gives new accounts the defaults when they're created", async () => {
    const user = await usersService.create({
      email: "new@example.com",
      name: "New User",
      password: "new-password-1",
      role: "user",
    })
    const templates = await repositories.templates.list(user.id)
    expect(templates).toHaveLength(DEFAULT_TEMPLATES.length)
  })
})

describe("LinkedIn templates", () => {
  const linkedin = DEFAULT_TEMPLATES.filter((t) => t.channel === "linkedin")

  it("has LinkedIn defaults without subjects", () => {
    expect(linkedin.length).toBeGreaterThan(0)
    expect(linkedin.every((t) => t.subject === "")).toBe(true)
  })

  it("keeps connection request notes under LinkedIn's limit with realistic values", () => {
    const values: Record<string, string> = {
      name: "Venkatalakshmi",
      company: "Hindustan Unilever Limited",
      role: "Senior Software Development Engineer",
      jobId: "R-2026-123456",
      jobUrl: "https://www.linkedin.com/jobs/view/4123456789/",
      senderName: "Alex Morgan",
    }
    for (const template of linkedin.filter((t) => t.name.startsWith("Connection request"))) {
      const filled = template.body.replace(
        /\{\{\s*(\w+)\s*\}\}/g,
        (_, key: string) => values[key] ?? "",
      )
      expect(filled.length, template.name).toBeLessThanOrEqual(LINKEDIN_CONNECTION_NOTE_LIMIT)
    }
  })

  it("creates templates as email unless a channel is given", async () => {
    const body = { name: "Mine", category: "other", subject: "Hi", body: "Hello" }
    const email = await call<EmailTemplate>(handler, "POST", "/templates", { body })
    expect(email.body.data?.channel).toBe("email")
    const li = await call<EmailTemplate>(handler, "POST", "/templates", {
      body: { ...body, name: "Mine LI", subject: "", channel: "linkedin" },
    })
    expect(li.body.data?.channel).toBe("linkedin")
    // Editing without a channel keeps it.
    const edited = await call<EmailTemplate>(handler, "PUT", `/templates/${li.body.data?.id}`, {
      body: { body: "Changed" },
    })
    expect(edited.body.data?.channel).toBe("linkedin")
  })

  it("gives accounts seeded before LinkedIn templates only the new ones", async () => {
    // An account from version 1 that deleted one email default.
    const kept = DEFAULT_TEMPLATES.filter((t) => t.channel === "email").slice(1)
    for (const { since: _since, ...t } of kept) {
      await repositories.templates.create(USER, {
        ...t,
        usageCount: 0,
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-01T00:00:00.000Z",
      })
    }
    await settingsRepository.put(USER, "TEMPLATE_DEFAULTS", {
      version: 1,
      seededAt: "2026-10-01T00:00:00.000Z",
    })

    const list = (await listTemplates()).body.data ?? []
    expect(list.filter((t) => t.channel === "linkedin")).toHaveLength(linkedin.length)
    // The deleted email default stays deleted.
    expect(list.some((t) => t.id === DEFAULT_TEMPLATES[0]?.id)).toBe(false)
    expect(list).toHaveLength(kept.length + linkedin.length)
  })
})
