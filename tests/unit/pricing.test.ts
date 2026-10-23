import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { handler } from "../../src/functions/users"
import { resetConfig } from "../../src/lib/config"
import { DEFAULT_PRICING } from "../../src/lib/default-pricing"
import { hashPassword } from "../../src/lib/passwords"
import type { PricingConfig } from "../../src/models"
import { usersRepository } from "../../src/repositories/dynamodb"
import { call } from "../support/http"

const SECRET = "test-secret-that-is-long-enough-for-hmac-signing"

async function addAccount(id: string, email: string, role: "admin" | "user") {
  await usersRepository.upsert({
    id,
    email,
    name: id,
    role,
    disabled: false,
    passwordHash: await hashPassword("password-123"),
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  })
}

async function tokenFor(email: string) {
  const res = await call<{ token: string }>(handler, "POST", "/auth/login", {
    body: { email, password: "password-123" },
  })
  return res.body.data?.token as string
}

const edited: PricingConfig = {
  ...DEFAULT_PRICING,
  currency: "USD",
  plans: [
    { ...DEFAULT_PRICING.plans[0]!, monthlyPrice: 0 },
    { ...DEFAULT_PRICING.plans[1]!, monthlyPrice: 9, yearlyPrice: 7 },
    { ...DEFAULT_PRICING.plans[2]!, visible: false },
  ],
}

beforeEach(async () => {
  process.env.AUTH_SECRET = SECRET
  resetConfig()
  await addAccount("usr_admin", "admin@example.com", "admin")
  await addAccount("usr_bob", "bob@example.com", "user")
})

afterEach(() => {
  delete process.env.AUTH_SECRET
  resetConfig()
})

describe("pricing", () => {
  it("serves the default plans publicly, without signing in", async () => {
    const res = await call<PricingConfig>(handler, "GET", "/pricing")
    expect(res.status).toBe(200)
    expect(res.body.data?.plans.map((p) => p.name)).toEqual(["Free", "Pro", "Coach"])
    expect(res.body.data?.currency).toBe("INR")
  })

  it("lets admins edit plans; hidden plans stay off the public page", async () => {
    const admin = await tokenFor("admin@example.com")
    const saved = await call<PricingConfig>(handler, "PUT", "/admin/pricing", {
      body: edited,
      token: admin,
    })
    expect(saved.status).toBe(200)
    expect(saved.body.data?.updatedAt).toBeDefined()

    const pub = await call<PricingConfig>(handler, "GET", "/pricing")
    expect(pub.body.data?.currency).toBe("USD")
    expect(pub.body.data?.plans.map((p) => p.id)).toEqual(["plan_free", "plan_pro"])
    expect(pub.body.data?.plans[1]?.monthlyPrice).toBe(9)

    const all = await call<PricingConfig>(handler, "GET", "/admin/pricing", { token: admin })
    expect(all.body.data?.plans).toHaveLength(3)

    const reset = await call<PricingConfig>(handler, "POST", "/admin/pricing/reset", {
      token: admin,
    })
    expect(reset.body.data?.currency).toBe("INR")
  })

  it("refuses non-admins and anonymous edits", async () => {
    const bob = await tokenFor("bob@example.com")
    const res = await call(handler, "PUT", "/admin/pricing", { body: edited, token: bob })
    expect(res.status).toBe(403)
    expect(res.body.error?.message).toBe("Only admins can change pricing")
    expect((await call(handler, "GET", "/admin/pricing")).status).toBe(401)
  })

  it("validates plans", async () => {
    const admin = await tokenFor("admin@example.com")
    const bad = (patch: object) =>
      call(handler, "PUT", "/admin/pricing", {
        body: { ...edited, plans: [{ ...edited.plans[0], ...patch }] },
        token: admin,
      })
    expect((await bad({ monthlyPrice: -1 })).status).toBe(400)
    expect((await bad({ ctaHref: "javascript:alert(1)" })).status).toBe(400)
    expect((await bad({ name: "" })).status).toBe(400)
    const dup = await call(handler, "PUT", "/admin/pricing", {
      body: { ...edited, plans: [edited.plans[0], edited.plans[0]] },
      token: admin,
    })
    expect(dup.status).toBe(400)
  })
})
