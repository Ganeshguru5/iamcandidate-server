import { PutObjectCommand } from "@aws-sdk/client-s3"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { handler } from "../../src/functions/integrations"
import { resetConfig } from "../../src/lib/config"
import { createState } from "../../src/lib/google"
import type { DocumentFile, DriveItem, GoogleDriveStatus } from "../../src/models"
import { settingsRepository } from "../../src/repositories/dynamodb"
import { call } from "../support/http"
import { testState } from "../support/setup"

/* A fake of the Google endpoints the integration uses. */
const google = {
  calls: [] as string[],
  revokedGrant: false,
  accessTokens: 0,
  files: {
    fld_jobs: {
      id: "fld_jobs",
      name: "Job search",
      mimeType: "application/vnd.google-apps.folder",
    },
    pdf_cv: { id: "pdf_cv", name: "Resume 2026.pdf", mimeType: "application/pdf", size: "11" },
    doc_cover: {
      id: "doc_cover",
      name: "Cover letter",
      mimeType: "application/vnd.google-apps.document",
    },
    big_zip: {
      id: "big_zip",
      name: "archive.zip",
      mimeType: "application/zip",
      size: String(30 * 1024 * 1024),
    },
  } as Record<string, { id: string; name: string; mimeType: string; size?: string }>,
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

async function fakeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url)
  const auth = new Headers(init?.headers).get("authorization")
  google.calls.push(`${init?.method ?? "GET"} ${url.host}${url.pathname}`)

  if (url.href.startsWith("https://oauth2.googleapis.com/token")) {
    const form = new URLSearchParams(String(init?.body))
    if (form.get("grant_type") === "authorization_code") {
      if (form.get("code") !== "good-code") return json({ error: "invalid_grant" }, 400)
      return json({
        access_token: `at${++google.accessTokens}`,
        expires_in: 3600,
        refresh_token: "rt-secret",
        scope: "drive.readonly",
      })
    }
    if (google.revokedGrant) return json({ error: "invalid_grant" }, 400)
    return json({
      access_token: `at${++google.accessTokens}`,
      expires_in: 3600,
      scope: "drive.readonly",
    })
  }
  if (url.href.startsWith("https://oauth2.googleapis.com/revoke"))
    return new Response(null, { status: 200 })
  if (url.host === "openidconnect.googleapis.com") return json({ email: "candidate@gmail.example" })

  if (url.host === "www.googleapis.com") {
    if (!auth?.startsWith("Bearer at")) return json({ error: { status: "UNAUTHENTICATED" } }, 401)
    const match = /^\/drive\/v3\/files(?:\/([^/]+))?(\/export)?$/.exec(url.pathname)
    const id = match?.[1] && decodeURIComponent(match[1])
    if (!id) {
      const q = url.searchParams.get("q") ?? ""
      if (q.startsWith("'root'"))
        return json({
          files: [google.files.fld_jobs, google.files.pdf_cv].map((f) => ({
            ...f,
            modifiedTime: "2026-10-01T00:00:00.000Z",
          })),
        })
      if (q.startsWith("'fld_jobs'"))
        return json({
          files: [{ ...google.files.doc_cover, modifiedTime: "2026-10-02T00:00:00.000Z" }],
        })
      return json({ files: [] })
    }
    const file = google.files[id]
    if (!file) return json({ error: { status: "NOT_FOUND" } }, 404)
    if (match?.[2]) return new Response("%PDF exported", { status: 200 })
    if (url.searchParams.get("alt") === "media") return new Response("%PDF resume", { status: 200 })
    return json({ ...file, modifiedTime: "2026-10-01T00:00:00.000Z" })
  }
  throw new Error(`Unexpected fetch ${url.href}`)
}

async function connect() {
  const res = await call<GoogleDriveStatus>(handler, "POST", "/integrations/google-drive/connect", {
    body: { code: "good-code", state: createState("usr_test") },
  })
  expect(res.status).toBe(200)
  return res
}

beforeEach(() => {
  Object.assign(process.env, {
    GOOGLE_CLIENT_ID: "client-123.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: "client-secret",
    GOOGLE_REDIRECT_URI: "http://localhost:3000/integrations/google-drive/callback",
    AUTH_SECRET: "",
  })
  resetConfig()
  google.calls = []
  google.revokedGrant = false
  google.accessTokens = 0
  vi.stubGlobal("fetch", vi.fn(fakeFetch))
})

afterEach(() => {
  vi.unstubAllGlobals()
  for (const key of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI"])
    delete process.env[key]
  resetConfig()
})

describe("connecting", () => {
  it("builds a read-only, offline consent URL with a signed state", async () => {
    const res = await call<{ url: string }>(handler, "GET", "/integrations/google-drive/auth-url")
    const url = new URL(res.body.data?.url as string)
    expect(url.host).toBe("accounts.google.com")
    expect(url.searchParams.get("client_id")).toBe("client-123.apps.googleusercontent.com")
    expect(url.searchParams.get("scope")).toContain(
      "https://www.googleapis.com/auth/drive.readonly",
    )
    expect(url.searchParams.get("access_type")).toBe("offline")
    expect(url.searchParams.get("state")).toMatch(/^[\w-]+\.[\w-]+$/)
  })

  it("stores encrypted tokens and reports the Google account", async () => {
    const res = await connect()
    expect(res.body.data).toMatchObject({
      connected: true,
      available: true,
      account: "candidate@gmail.example",
    })
    const stored = testState.db.items.get("USER#usr_test|SETTINGS#GOOGLE_DRIVE")
    expect(JSON.stringify(stored)).not.toContain("rt-secret")
    expect(stored?.encryptedRefreshToken).toMatch(/^v1\./)
  })

  it("rejects a state from another user or a bad code", async () => {
    const otherUser = await call(handler, "POST", "/integrations/google-drive/connect", {
      body: { code: "good-code", state: createState("usr_someone_else") },
    })
    expect(otherUser.status).toBe(400)
    const badCode = await call(handler, "POST", "/integrations/google-drive/connect", {
      body: { code: "bad", state: createState("usr_test") },
    })
    expect(badCode.status).toBe(409)
  })

  it("explains when the server has no Google credentials", async () => {
    delete process.env.GOOGLE_CLIENT_ID
    resetConfig()
    const status = await call<GoogleDriveStatus>(handler, "GET", "/integrations/google-drive")
    expect(status.body.data).toMatchObject({ available: false, connected: false })
    const res = await call(handler, "GET", "/integrations/google-drive/auth-url")
    expect(res.status).toBe(400)
    expect(res.body.error?.message).toContain("GOOGLE_CLIENT_ID")
  })

  it("disconnects by revoking the grant", async () => {
    await connect()
    const res = await call<GoogleDriveStatus>(handler, "DELETE", "/integrations/google-drive")
    expect(res.body.data?.connected).toBe(false)
    expect(google.calls).toContain("POST oauth2.googleapis.com/revoke")
    expect(await settingsRepository.get("usr_test", "GOOGLE_DRIVE")).toBeUndefined()
  })
})

describe("browsing", () => {
  it("lists one folder at a time", async () => {
    await connect()
    const root = await call<DriveItem[]>(handler, "GET", "/integrations/google-drive/files")
    expect(root.body.data).toEqual([
      expect.objectContaining({ id: "fld_jobs", type: "folder", parentId: null }),
      expect.objectContaining({
        id: "pdf_cv",
        type: "file",
        kind: "pdf",
        sizeBytes: 11,
        parentId: null,
      }),
    ])
    const folder = await call<DriveItem[]>(handler, "GET", "/integrations/google-drive/files", {
      query: { parentId: "fld_jobs" },
    })
    expect(folder.body.data).toEqual([
      expect.objectContaining({ id: "doc_cover", parentId: "fld_jobs", kind: "pdf" }),
    ])
  })

  it("requires a connection", async () => {
    const res = await call(handler, "GET", "/integrations/google-drive/files")
    expect(res.status).toBe(409)
  })

  it("refreshes an expired access token", async () => {
    await connect()
    const stored = (await settingsRepository.get("usr_test", "GOOGLE_DRIVE"))!
    await settingsRepository.put("usr_test", "GOOGLE_DRIVE", {
      ...stored,
      accessTokenExpiresAt: Date.now() - 1,
    })
    expect((await call(handler, "GET", "/integrations/google-drive/files")).status).toBe(200)
    expect(google.accessTokens).toBe(2)
  })

  it("drops the connection when Google revoked the grant", async () => {
    await connect()
    const stored = (await settingsRepository.get("usr_test", "GOOGLE_DRIVE"))!
    await settingsRepository.put("usr_test", "GOOGLE_DRIVE", { ...stored, accessTokenExpiresAt: 0 })
    google.revokedGrant = true
    const res = await call(handler, "GET", "/integrations/google-drive/files")
    expect(res.status).toBe(409)
    expect(res.body.error?.message).toContain("Reconnect")
    expect(await settingsRepository.get("usr_test", "GOOGLE_DRIVE")).toBeUndefined()
  })
})

describe("importing", () => {
  function captureS3() {
    const puts: PutObjectCommand[] = []
    testState.s3Send = async (command) => {
      if (command instanceof PutObjectCommand) puts.push(command)
      return {}
    }
    return puts
  }

  it("copies a file into Documents (S3) and marks it as from Drive", async () => {
    await connect()
    const puts = captureS3()
    const res = await call<DocumentFile>(handler, "POST", "/integrations/google-drive/import", {
      body: { fileId: "pdf_cv" },
    })
    expect(res.status).toBe(201)
    expect(res.body.data).toMatchObject({
      name: "Resume 2026.pdf",
      category: "resume",
      kind: "pdf",
      source: "drive",
      driveFileId: "pdf_cv",
      sizeBytes: 11,
    })
    expect(puts).toHaveLength(1)
    expect(puts[0]?.input.Key).toMatch(
      /^users\/usr_test\/documents\/doc_[a-f0-9]{16}\/Resume 2026\.pdf$/,
    )
    expect(puts[0]?.input.ContentType).toBe("application/pdf")
  })

  it("exports Google Docs to PDF", async () => {
    await connect()
    captureS3()
    const res = await call<DocumentFile>(handler, "POST", "/integrations/google-drive/import", {
      body: { fileId: "doc_cover", category: "experience" },
    })
    expect(res.body.data).toMatchObject({
      name: "Cover letter.pdf",
      kind: "pdf",
      category: "experience",
    })
    expect(google.calls).toContain("GET www.googleapis.com/drive/v3/files/doc_cover/export")
  })

  it("rejects folders and files over 25 MB", async () => {
    await connect()
    captureS3()
    const folder = await call(handler, "POST", "/integrations/google-drive/import", {
      body: { fileId: "fld_jobs" },
    })
    expect(folder.status).toBe(400)
    const big = await call(handler, "POST", "/integrations/google-drive/import", {
      body: { fileId: "big_zip" },
    })
    expect(big.status).toBe(400)
    expect(big.body.error?.message).toContain("25 MB")
  })
})
