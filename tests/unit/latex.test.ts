import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { handler as authorizer } from "../../src/functions/authorizer"
import { handler } from "../../src/functions/latex"
import { resetConfig } from "../../src/lib/config"
import { parseTexError } from "../../src/lib/latex"
import { hashPassword } from "../../src/lib/passwords"
import { createToken } from "../../src/lib/tokens"
import { usersRepository } from "../../src/repositories/dynamodb"
import { call, makeEvent } from "../support/http"

const tectonic = resolve(
  ".tools",
  "tectonic",
  process.platform === "win32" ? "tectonic.exe" : "tectonic",
)
const hasTectonic = existsSync(tectonic) || Boolean(process.env.TECTONIC_PATH)
const starter = readFileSync(resolve("latex", "starter-resume.tex"), "utf8")

describe("parseTexError", () => {
  it("extracts the first error and its line", () => {
    const log =
      "(main.tex\n! Undefined control sequence.\nl.7 Hello \\oops\n                world\n"
    expect(parseTexError(log)).toEqual({ message: "Undefined control sequence.", line: 7 })
    expect(parseTexError("no errors here").message).toContain("couldn't compile")
  })
})

describe("POST /latex/compile", () => {
  beforeEach(() => {
    process.env.TECTONIC_PATH = existsSync(tectonic) ? tectonic : (process.env.TECTONIC_PATH ?? "")
  })
  afterEach(() => {
    delete process.env.TECTONIC_PATH
  })

  it("validates the source", async () => {
    expect((await call(handler, "POST", "/latex/compile", { body: { source: "" } })).status).toBe(
      400,
    )
    expect(
      (await call(handler, "POST", "/latex/compile", { body: { source: "x".repeat(200_001) } }))
        .status,
    ).toBe(400)
  })

  it("reports a missing compiler clearly", async () => {
    process.env.TECTONIC_PATH = resolve("does-not-exist", "tectonic")
    const res = await call(handler, "POST", "/latex/compile", { body: { source: starter } })
    expect(res.status).toBe(503)
    expect(res.body.error?.message).toContain("Tectonic")
  })

  describe.runIf(hasTectonic)("with Tectonic installed", () => {
    it("compiles the starter resume to a PDF", async () => {
      const res = await call<{ pdfBase64: string; sizeBytes: number }>(
        handler,
        "POST",
        "/latex/compile",
        {
          body: { source: starter },
        },
      )
      expect(res.status).toBe(200)
      const pdf = Buffer.from(res.body.data?.pdfBase64 as string, "base64")
      expect(pdf.subarray(0, 5).toString()).toBe("%PDF-")
      expect(res.body.data?.sizeBytes).toBe(pdf.byteLength)
    }, 120_000)

    it("returns the LaTeX error with its line number", async () => {
      const source =
        "\\documentclass{article}\n\\begin{document}\nHello \\notacommand\n\\end{document}\n"
      const res = await call(handler, "POST", "/latex/compile", { body: { source } })
      expect(res.status).toBe(400)
      expect(res.body.error?.code).toBe("COMPILE_ERROR")
      expect(res.body.error?.message).toBe("Line 3: Undefined control sequence.")
      expect((res.body.error?.details as { log: string }).log).toContain("notacommand")
    }, 120_000)
  })
})

describe("session authorizer", () => {
  const secret = "authorizer-test-secret-authorizer-test"
  beforeEach(async () => {
    process.env.AUTH_SECRET = secret
    resetConfig()
    await usersRepository.upsert({
      id: "usr_a",
      email: "a@example.com",
      name: "A",
      role: "user",
      disabled: false,
      passwordHash: await hashPassword("password-123"),
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    })
  })
  afterEach(() => {
    delete process.env.AUTH_SECRET
    resetConfig()
  })

  it("allows a valid session and passes the user id", async () => {
    const event = makeEvent("POST", "/latex/compile", { token: createToken("usr_a", secret) })
    expect(await authorizer(event)).toEqual({ isAuthorized: true, context: { userId: "usr_a" } })
  })

  it("rejects missing, forged and disabled sessions", async () => {
    expect((await authorizer(makeEvent("POST", "/latex/compile"))).isAuthorized).toBe(false)
    const forged = createToken("usr_a", "another-secret-another-secret-another")
    expect(
      (await authorizer(makeEvent("POST", "/latex/compile", { token: forged }))).isAuthorized,
    ).toBe(false)
    const account = (await usersRepository.get("usr_a"))!
    await usersRepository.replace({ ...account, disabled: true })
    const token = createToken("usr_a", secret)
    expect((await authorizer(makeEvent("POST", "/latex/compile", { token }))).isAuthorized).toBe(
      false,
    )
  })
})
