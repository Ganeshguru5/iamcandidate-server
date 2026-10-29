import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { handler as users } from "../../src/functions/users"
import { handler as workspace } from "../../src/functions/workspace"
import { resetConfig } from "../../src/lib/config"
import { hashPassword } from "../../src/lib/passwords"
import { createToken, verifyToken } from "../../src/lib/tokens"
import type { Task, UserAccount } from "../../src/models"
import { repositories, usersRepository } from "../../src/repositories/dynamodb"
import { call } from "../support/http"

const SECRET = "test-secret-that-is-long-enough-for-hmac-signing"

async function addAccount(id: string, email: string, password: string, role: "admin" | "user") {
  await usersRepository.upsert({
    id,
    email,
    name: id,
    role,
    disabled: false,
    passwordHash: await hashPassword(password),
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  })
}

async function login(email: string, password: string) {
  return call<{ token: string; user: UserAccount }>(users, "POST", "/auth/login", {
    body: { email, password },
  })
}

async function tokenFor(email: string, password: string) {
  return (await login(email, password)).body.data?.token as string
}

beforeEach(async () => {
  process.env.AUTH_SECRET = SECRET
  resetConfig()
  await addAccount("usr_admin", "admin@example.com", "admin-pass-1", "admin")
  await addAccount("usr_bob", "bob@example.com", "bob-pass-12", "user")
})

afterEach(() => {
  delete process.env.AUTH_SECRET
  resetConfig()
})

describe("login", () => {
  it("returns a token and the public user (no password hash)", async () => {
    const res = await login("Admin@Example.com ", "admin-pass-1")
    expect(res.status).toBe(200)
    expect(res.body.data?.user).toMatchObject({ id: "usr_admin", role: "admin" })
    expect(res.body.data?.user).not.toHaveProperty("passwordHash")
    expect(res.body.data?.user.lastLoginAt).toBeDefined()
    expect(verifyToken(res.body.data?.token as string, SECRET)?.sub).toBe("usr_admin")
  })

  it("gives the same 401 for a wrong password and an unknown email", async () => {
    const wrong = await login("admin@example.com", "nope")
    const unknown = await login("ghost@example.com", "nope")
    expect(wrong.status).toBe(401)
    expect(unknown.status).toBe(401)
    expect(wrong.body.error?.message).toBe(unknown.body.error?.message)
  })

  it("rejects disabled accounts", async () => {
    const bob = (await usersRepository.get("usr_bob"))!
    await usersRepository.replace({ ...bob, disabled: true })
    expect((await login("bob@example.com", "bob-pass-12")).status).toBe(401)
  })
})

describe("session checks", () => {
  it("requires a valid token on every non-public route", async () => {
    expect((await call(workspace, "GET", "/tasks")).status).toBe(401)
    expect((await call(workspace, "GET", "/tasks", { token: "garbage" })).status).toBe(401)

    const forged = createToken("usr_admin", "some-other-secret-of-sufficient-length")
    expect((await call(workspace, "GET", "/tasks", { token: forged })).status).toBe(401)

    const DAY = 24 * 60 * 60 * 1000
    const expired = createToken("usr_admin", SECRET, Date.now() - 366 * DAY)
    expect((await call(workspace, "GET", "/tasks", { token: expired })).status).toBe(401)

    // Tokens outlive the old 12-hour limit.
    const weekOld = createToken("usr_admin", SECRET, Date.now() - 7 * DAY)
    expect((await call(workspace, "GET", "/tasks", { token: weekOld })).status).toBe(200)

    const valid = await tokenFor("admin@example.com", "admin-pass-1")
    expect((await call(workspace, "GET", "/tasks", { token: valid })).status).toBe(200)
  })

  it("refreshes a session with a later expiry", async () => {
    const old = createToken("usr_bob", SECRET, Date.now() - 30 * 24 * 60 * 60 * 1000)
    const res = await call<{ token: string; expiresIn: number; user: UserAccount }>(
      users,
      "POST",
      "/auth/refresh",
      { token: old },
    )
    expect(res.status).toBe(200)
    expect(res.body.data?.user).toMatchObject({ id: "usr_bob" })
    expect(res.body.data?.user).not.toHaveProperty("passwordHash")
    const fresh = verifyToken(res.body.data?.token as string, SECRET)
    expect(fresh?.sub).toBe("usr_bob")
    expect(fresh!.exp).toBeGreaterThan(verifyToken(old, SECRET)!.exp)

    expect((await call(users, "POST", "/auth/refresh")).status).toBe(401)
    const bob = (await usersRepository.get("usr_bob"))!
    await usersRepository.replace({ ...bob, disabled: true })
    expect((await call(users, "POST", "/auth/refresh", { token: old })).status).toBe(401)
  })

  it("keeps each user's data separate", async () => {
    const admin = await tokenFor("admin@example.com", "admin-pass-1")
    const bob = await tokenFor("bob@example.com", "bob-pass-12")
    const body = { title: "Bob's task", description: "", priority: "low", status: "todo" }
    const created = await call<Task>(workspace, "POST", "/tasks", { body, token: bob })

    expect((await call<Task[]>(workspace, "GET", "/tasks", { token: bob })).body.data).toHaveLength(
      1,
    )
    expect(
      (await call<Task[]>(workspace, "GET", "/tasks", { token: admin })).body.data,
    ).toHaveLength(0)
    const path = `/tasks/${created.body.data?.id}`
    expect((await call(workspace, "GET", path, { token: admin })).status).toBe(404)
  })

  it("revokes access immediately when a user is disabled", async () => {
    const admin = await tokenFor("admin@example.com", "admin-pass-1")
    const bob = await tokenFor("bob@example.com", "bob-pass-12")
    await call(users, "PUT", "/users/usr_bob", { body: { disabled: true }, token: admin })
    expect((await call(workspace, "GET", "/tasks", { token: bob })).status).toBe(401)
  })

  it("lets a read-only account read but not change anything", async () => {
    const bob = (await usersRepository.get("usr_bob"))!
    await usersRepository.replace({ ...bob, readOnly: true })
    const token = await tokenFor("bob@example.com", "bob-pass-12")
    const body = { title: "Demo task", description: "", priority: "low", status: "todo" }

    expect((await call(workspace, "GET", "/tasks", { token })).status).toBe(200)
    const created = await call(workspace, "POST", "/tasks", { body, token })
    expect(created.status).toBe(403)
    expect(created.body.error?.code).toBe("READ_ONLY")
    expect((await call(users, "PUT", "/auth/password", { body: {}, token })).status).toBe(403)
    expect((await call(users, "POST", "/auth/refresh", { token })).status).toBe(200)
    expect(await repositories.tasks.list("usr_bob")).toHaveLength(0)
  })
})

describe("user management", () => {
  it("is admin-only", async () => {
    const bob = await tokenFor("bob@example.com", "bob-pass-12")
    const res = await call(users, "GET", "/users", { token: bob })
    expect(res.status).toBe(403)
    expect(res.body.error?.code).toBe("FORBIDDEN")
  })

  it("creates a user who can then sign in with a separate profile", async () => {
    const admin = await tokenFor("admin@example.com", "admin-pass-1")
    const res = await call<UserAccount>(users, "POST", "/users", {
      token: admin,
      body: { email: "New@Example.com", name: "New Person", password: "new-pass-12", role: "user" },
    })
    expect(res.status).toBe(201)
    expect(res.body.data).toMatchObject({ email: "new@example.com", role: "user", disabled: false })

    const list = await call<UserAccount[]>(users, "GET", "/users", { token: admin })
    expect(list.body.data?.map((u) => u.email)).toContain("new@example.com")

    const me = await call<UserAccount>(users, "GET", "/auth/me", {
      token: await tokenFor("new@example.com", "new-pass-12"),
    })
    expect(me.body.data?.name).toBe("New Person")
  })

  it("validates input and rejects duplicate emails", async () => {
    const admin = await tokenFor("admin@example.com", "admin-pass-1")
    const weak = await call(users, "POST", "/users", {
      token: admin,
      body: { email: "x@example.com", name: "X", password: "short", role: "user" },
    })
    expect(weak.status).toBe(400)
    const dup = await call(users, "POST", "/users", {
      token: admin,
      body: { email: "bob@example.com", name: "Bob 2", password: "long-enough-1", role: "user" },
    })
    expect(dup.status).toBe(409)
  })

  it("resets a password", async () => {
    const admin = await tokenFor("admin@example.com", "admin-pass-1")
    await call(users, "PUT", "/users/usr_bob", {
      token: admin,
      body: { password: "reset-pass-99" },
    })
    expect((await login("bob@example.com", "bob-pass-12")).status).toBe(401)
    expect((await login("bob@example.com", "reset-pass-99")).status).toBe(200)
  })

  it("protects the admin from locking themselves out", async () => {
    const admin = await tokenFor("admin@example.com", "admin-pass-1")
    expect((await call(users, "DELETE", "/users/usr_admin", { token: admin })).status).toBe(400)
    expect(
      (await call(users, "PUT", "/users/usr_admin", { token: admin, body: { role: "user" } }))
        .status,
    ).toBe(400)
  })

  it("requires at least one active admin", async () => {
    await addAccount("usr_admin2", "admin2@example.com", "admin-pass-2", "admin")
    const admin2 = await tokenFor("admin2@example.com", "admin-pass-2")
    // admin2 demotes admin1: allowed while admin2 stays an admin…
    const demote = await call(users, "PUT", "/users/usr_admin", {
      token: admin2,
      body: { role: "user" },
    })
    expect(demote.status).toBe(200)
    // …but nobody can remove the last one (admin2 can't demote itself either).
    const self = await call(users, "PUT", "/users/usr_admin2", {
      token: admin2,
      body: { disabled: true },
    })
    expect(self.status).toBe(400)
  })

  it("deletes a user with all their data", async () => {
    const admin = await tokenFor("admin@example.com", "admin-pass-1")
    const bob = await tokenFor("bob@example.com", "bob-pass-12")
    await call(workspace, "POST", "/tasks", {
      token: bob,
      body: { title: "x", description: "", priority: "low", status: "todo" },
    })
    expect((await call(users, "DELETE", "/users/usr_bob", { token: admin })).status).toBe(204)
    expect(await usersRepository.get("usr_bob")).toBeUndefined()
    expect(await repositories.tasks.list("usr_bob")).toEqual([])
    expect((await login("bob@example.com", "bob-pass-12")).status).toBe(401)
  })
})

describe("own password", () => {
  it("changes the password after checking the current one", async () => {
    const bob = await tokenFor("bob@example.com", "bob-pass-12")
    const wrong = await call(users, "PUT", "/auth/password", {
      token: bob,
      body: { currentPassword: "nope", newPassword: "brand-new-pass" },
    })
    expect(wrong.status).toBe(400)
    const ok = await call(users, "PUT", "/auth/password", {
      token: bob,
      body: { currentPassword: "bob-pass-12", newPassword: "brand-new-pass" },
    })
    expect(ok.status).toBe(204)
    expect((await login("bob@example.com", "brand-new-pass")).status).toBe(200)
  })
})
