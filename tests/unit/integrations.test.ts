import { GetObjectCommand, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { handler } from "../../src/functions/integrations"
import { resetConfig } from "../../src/lib/config"
import { parseCsv } from "../../src/lib/csv"
import { parseRepo } from "../../src/lib/github"
import { createState } from "../../src/lib/google"
import type {
  Application,
  AwsBackupStatus,
  BackupProgress,
  Contact,
  GitHubActivity,
  GitHubRepo,
  GitHubStatus,
  GoogleCalendarStatus,
  IntegrationsOverview,
  LinkedInImportResult,
  Project,
} from "../../src/models"
import { repositories, settingsRepository } from "../../src/repositories/dynamodb"
import { setBackupClientFactory } from "../../src/services/aws-backup.service"
import { calendarEventId, googleCalendarService } from "../../src/services/google-calendar.service"
import { parseLinkedInDate } from "../../src/services/linkedin.service"
import { call } from "../support/http"
import { testState } from "../support/setup"

const USER = "usr_test"
const DAY = 24 * 60 * 60 * 1000

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function urlOf(input: string | URL | Request) {
  return new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url)
}

beforeEach(() => {
  Object.assign(process.env, {
    GOOGLE_CLIENT_ID: "client-123.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: "client-secret",
    GOOGLE_REDIRECT_URI: "http://localhost:3000/integrations/google-drive/callback",
    AUTH_SECRET: "",
  })
  resetConfig()
})

afterEach(() => {
  vi.unstubAllGlobals()
  setBackupClientFactory(undefined)
  for (const key of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI"])
    delete process.env[key]
  resetConfig()
})

/* ------------------------------------------------------------------ */
/* LinkedIn                                                            */
/* ------------------------------------------------------------------ */

const CONNECTIONS = [
  "Notes:",
  '"When exporting your connection data, you may notice that some of the email addresses are missing."',
  "",
  "First Name,Last Name,URL,Email Address,Company,Position,Connected On",
  "Maya,Sharma,https://www.linkedin.com/in/priya-sharma,priya@example.com,Northwind Labs,Staff Engineer,21 Oct 2026",
  'Dev,Rao,https://www.linkedin.com/in/arjun-rao,,"Contoso, Inc.","Engineering Manager, Payments",03 Jan 2025',
  ",,,,,,",
  "Sam,,https://www.linkedin.com/in/sam,,Northwind Labs,Recruiter,05 May 2024",
].join("\r\n")

const SAVED_JOBS = [
  "Saved Date,Job Url,Job Title,Company Name",
  "10/21/26 3:04 PM,https://www.linkedin.com/jobs/view/4123456789/,Senior Frontend Engineer,Northwind Labs",
  "10/20/26 9:00 AM,https://www.linkedin.com/jobs/view/4000000001/,Platform Engineer,Fabrikam",
].join("\n")

const JOB_APPLICATIONS = [
  "Application Date,Contact Email,Contact Phone Number,Company Name,Job Title,Job Url,Resume Name,Question And Answers",
  "10/15/26 11:30 AM,me@example.com,,Fabrikam,Platform Engineer,https://www.linkedin.com/jobs/view/4000000001/,Resume.pdf,",
].join("\n")

function importCsv(csv: string, dryRun = false) {
  return call<LinkedInImportResult>(handler, "POST", "/integrations/linkedin/import", {
    body: { csv, dryRun },
  })
}

describe("CSV and LinkedIn helpers", () => {
  it("parses quotes, embedded commas, escaped quotes and CRLF", () => {
    expect(parseCsv('a,"b, c","say ""hi"""\r\n1,2,3')).toEqual([
      ["a", "b, c", 'say "hi"'],
      ["1", "2", "3"],
    ])
    expect(parseCsv('﻿x,"multi\nline"')).toEqual([["x", "multi\nline"]])
  })

  it("reads LinkedIn's date formats", () => {
    expect(parseLinkedInDate("21 Oct 2026")).toBe("2026-10-21T12:00:00.000Z")
    expect(parseLinkedInDate("10/21/26 3:04 PM")).toBe("2026-10-21T15:04:00.000Z")
    expect(parseLinkedInDate("10/21/26, 12:15 AM")).toBe("2026-10-21T00:15:00.000Z")
    expect(parseLinkedInDate("")).toBeUndefined()
    expect(parseLinkedInDate("not a date")).toBeUndefined()
  })
})

describe("LinkedIn import", () => {
  it("previews connections without writing anything", async () => {
    const res = await importCsv(CONNECTIONS, true)
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({
      kind: "connections",
      rows: 3,
      created: 3,
      invalid: 0,
      companiesCreated: 2,
      dryRun: true,
    })
    expect(res.body.data?.sample[0]).toBe("Maya Sharma — Staff Engineer")
    expect(await repositories.contacts.list(USER)).toHaveLength(0)
  })

  it("imports connections with their companies, and skips them the second time", async () => {
    await repositories.companies.create(USER, {
      id: "cmp_nw",
      name: "Northwind Labs Pvt Ltd",
      industry: "",
      website: "",
      location: "",
      size: "",
      status: "target",
      description: "",
      notes: "",
      createdAt: "2026-10-01T00:00:00.000Z",
    })
    const first = await importCsv(CONNECTIONS)
    expect(first.body.data).toMatchObject({ created: 3, companiesCreated: 1, skipped: 0 })

    const contacts = await repositories.contacts.list(USER)
    const priya = contacts.find((c) => c.name === "Maya Sharma") as Contact
    expect(priya).toMatchObject({
      role: "Staff Engineer",
      companyId: "cmp_nw", // matched despite "Pvt Ltd"
      email: "priya@example.com",
      linkedin: "https://www.linkedin.com/in/priya-sharma",
      relationship: "professional",
    })
    const arjun = contacts.find((c) => c.name === "Dev Rao") as Contact
    expect(arjun.email).toBe("")
    const companies = await repositories.companies.list(USER)
    expect(companies.find((c) => c.id === arjun.companyId)?.name).toBe("Contoso, Inc.")

    const second = await importCsv(CONNECTIONS)
    expect(second.body.data).toMatchObject({ created: 0, skipped: 3 })
    expect(await repositories.contacts.list(USER)).toHaveLength(3)
    expect((await settingsRepository.get(USER, "LINKEDIN"))?.imports.connections?.created).toBe(3)
  })

  it("imports saved jobs as wishlist and applications as applied, without duplicates", async () => {
    const saved = await importCsv(SAVED_JOBS)
    expect(saved.body.data).toMatchObject({ kind: "saved_jobs", created: 2 })
    const applied = await importCsv(JOB_APPLICATIONS)
    // Same job URL as a saved job: skipped.
    expect(applied.body.data).toMatchObject({ kind: "job_applications", created: 0, skipped: 1 })

    const apps = await repositories.applications.list(USER)
    const frontend = apps.find((a) => a.role === "Senior Frontend Engineer") as Application
    expect(frontend).toMatchObject({
      status: "wishlist",
      jobId: "4123456789",
      source: "LinkedIn",
      workMode: "onsite",
    })
    expect(frontend.appliedDate).toBeUndefined()
    expect(frontend.timeline[0]?.title).toBe("Imported from LinkedIn")
  })

  it("records applied dates from the job applications export", async () => {
    const res = await importCsv(JOB_APPLICATIONS)
    expect(res.body.data?.created).toBe(1)
    const [app] = await repositories.applications.list(USER)
    expect(app).toMatchObject({ status: "applied", appliedDate: "2026-10-15T11:30:00.000Z" })
    expect(app?.notes).toContain("Resume: Resume.pdf")
  })

  it("rejects files that aren't a LinkedIn export", async () => {
    const res = await importCsv("name,email\nx,y@example.com")
    expect(res.status).toBe(400)
    expect(res.body.error?.message).toMatch(/LinkedIn export/)
  })
})

/* ------------------------------------------------------------------ */
/* GitHub                                                              */
/* ------------------------------------------------------------------ */

const github = { token: "ghp_validtoken000000000000000000", revoked: false, calls: [] as string[] }

const rawRepo = (name: string, extra: Record<string, unknown> = {}) => ({
  full_name: `octo/${name}`,
  name,
  description: `${name} description`,
  html_url: `https://github.com/octo/${name}`,
  homepage: null,
  private: false,
  fork: false,
  archived: false,
  language: "TypeScript",
  topics: ["nextjs"],
  stargazers_count: 3,
  default_branch: "main",
  pushed_at: "2026-10-20T10:00:00Z",
  created_at: "2025-01-01T00:00:00Z",
  ...extra,
})

async function githubFetch(input: string | URL | Request, init?: RequestInit) {
  const url = urlOf(input)
  github.calls.push(`${url.pathname}${url.search}`)
  if (url.host !== "api.github.com") throw new Error(`Unexpected fetch ${url.href}`)
  const auth = new Headers(init?.headers).get("authorization")
  if (github.revoked || auth !== `Bearer ${github.token}`) {
    return json({ message: "Bad credentials" }, 401)
  }
  switch (url.pathname) {
    case "/user":
      return json({ login: "octo", name: "Octo Cat", avatar_url: "https://avatars.example/octo" })
    case "/user/repos":
      return json([rawRepo("iamcandidate"), rawRepo("blog", { homepage: "https://blog.example" })])
    case "/repos/octo/iamcandidate":
      return json(rawRepo("iamcandidate"))
    case "/repos/octo/iamcandidate/languages":
      return json({ CSS: 10, TypeScript: 900 })
    case "/repos/octo/iamcandidate/commits":
      return json([
        {
          sha: "abcdef1234567",
          html_url: "https://github.com/octo/iamcandidate/commit/abcdef1",
          commit: {
            message: "Add calendar sync\n\nLonger body",
            author: { name: "Octo", date: "2026-10-20T09:00:00Z" },
          },
          author: { login: "octo" },
        },
      ])
    case "/repos/octo/iamcandidate/pulls":
      return json([
        {
          number: 7,
          title: "Calendar sync",
          state: "closed",
          merged_at: "2026-10-20T09:30:00Z",
          updated_at: "2026-10-20T09:30:00Z",
          html_url: "https://github.com/octo/iamcandidate/pull/7",
          user: { login: "octo" },
        },
      ])
    case "/repos/octo/empty/commits":
      return json({ message: "Git Repository is empty." }, 409)
    default:
      return json({ message: "Not Found" }, 404)
  }
}

async function connectGitHub() {
  return call<GitHubStatus>(handler, "PUT", "/integrations/github", {
    body: { token: github.token },
  })
}

describe("GitHub", () => {
  beforeEach(() => {
    github.revoked = false
    github.calls = []
    vi.stubGlobal("fetch", vi.fn(githubFetch))
  })

  it("parses repository URLs", () => {
    expect(parseRepo("https://github.com/octo/iamcandidate")).toBe("octo/iamcandidate")
    expect(parseRepo("https://github.com/octo/iamcandidate.git")).toBe("octo/iamcandidate")
    expect(parseRepo("git@github.com:octo/my.repo.git")).toBe("octo/my.repo")
    expect(parseRepo("https://github.com/octo/iamcandidate/tree/main")).toBe("octo/iamcandidate")
    expect(parseRepo("https://gitlab.com/octo/iamcandidate")).toBeUndefined()
  })

  it("connects with a valid token and stores it encrypted", async () => {
    const res = await connectGitHub()
    expect(res.body.data).toMatchObject({ connected: true, account: "octo", name: "Octo Cat" })
    const stored = await settingsRepository.get(USER, "GITHUB")
    expect(stored?.encryptedToken).toMatch(/^v1\./)
    expect(JSON.stringify(stored)).not.toContain(github.token)
  })

  it("rejects a token GitHub doesn't accept", async () => {
    const res = await call(handler, "PUT", "/integrations/github", {
      body: { token: "ghp_wrongtoken0000000000000000000" },
    })
    expect(res.status).toBe(400)
    expect(await settingsRepository.get(USER, "GITHUB")).toBeUndefined()
  })

  it("lists repositories with the project each one is linked to", async () => {
    await connectGitHub()
    await repositories.projects.create(USER, {
      id: "prj_1",
      name: "iamcandidate",
      description: "",
      status: "development",
      progress: 50,
      technologies: [],
      repository: "https://github.com/Octo/iamcandidate.git",
      startedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    })
    const res = await call<GitHubRepo[]>(handler, "GET", "/integrations/github/repos")
    expect(res.body.data?.map((r) => [r.fullName, r.projectId])).toEqual([
      ["octo/iamcandidate", "prj_1"],
      ["octo/blog", undefined],
    ])
  })

  it("returns recent commits and pull requests", async () => {
    await connectGitHub()
    const res = await call<GitHubActivity>(handler, "GET", "/integrations/github/activity", {
      query: { repo: "octo/iamcandidate" },
    })
    expect(res.status).toBe(200)
    expect(res.body.data?.commits[0]).toMatchObject({
      sha: "abcdef1",
      message: "Add calendar sync",
    })
    expect(res.body.data?.pullRequests[0]).toMatchObject({ number: 7, state: "merged" })
  })

  it("creates a project from a repository once", async () => {
    await connectGitHub()
    const first = await call<Project>(handler, "POST", "/integrations/github/import", {
      body: { repo: "octo/iamcandidate" },
    })
    expect(first.status).toBe(201)
    expect(first.body.data).toMatchObject({
      name: "iamcandidate",
      repository: "https://github.com/octo/iamcandidate",
      technologies: ["TypeScript", "CSS", "nextjs"],
      status: "development",
      startedAt: "2025-01-01T00:00:00Z",
    })
    const again = await call<Project>(handler, "POST", "/integrations/github/import", {
      body: { repo: "octo/iamcandidate" },
    })
    expect(again.body.data?.id).toBe(first.body.data?.id)
    expect(await repositories.projects.list(USER)).toHaveLength(1)
  })

  it("forgets the connection when GitHub revokes the token", async () => {
    await connectGitHub()
    github.revoked = true
    const res = await call(handler, "GET", "/integrations/github/repos")
    expect(res.status).toBe(409)
    expect(await settingsRepository.get(USER, "GITHUB")).toBeUndefined()
  })

  it("validates repository names", async () => {
    await connectGitHub()
    const res = await call(handler, "GET", "/integrations/github/activity", {
      query: { repo: "../../etc" },
    })
    expect(res.status).toBe(400)
  })
})

/* ------------------------------------------------------------------ */
/* Google Calendar                                                     */
/* ------------------------------------------------------------------ */

const calendar = {
  events: new Map<string, Record<string, unknown>>(),
  calls: [] as string[],
  scope: "https://www.googleapis.com/auth/calendar.events openid email",
}

async function calendarFetch(input: string | URL | Request, init?: RequestInit) {
  const url = urlOf(input)
  const method = init?.method ?? "GET"
  calendar.calls.push(`${method} ${url.pathname}`)
  if (url.href.startsWith("https://oauth2.googleapis.com/token")) {
    return json({
      access_token: "at-calendar",
      expires_in: 3600,
      refresh_token: "rt-calendar",
      scope: calendar.scope,
    })
  }
  if (url.href.startsWith("https://oauth2.googleapis.com/revoke"))
    return new Response(null, { status: 200 })
  if (url.host === "openidconnect.googleapis.com") return json({ email: "me@gmail.example" })
  const match = /^\/calendar\/v3\/calendars\/primary\/events(?:\/([^/]+))?$/.exec(url.pathname)
  if (url.host === "www.googleapis.com" && match) {
    const id = match[1] && decodeURIComponent(match[1])
    if (method === "PUT" && id) {
      if (!calendar.events.has(id)) return json({ error: { status: "NOT_FOUND" } }, 404)
      calendar.events.set(id, JSON.parse(String(init?.body)))
      return json({ id })
    }
    if (method === "POST") {
      const body = JSON.parse(String(init?.body)) as { id: string }
      calendar.events.set(body.id, body)
      return json(body)
    }
    if (method === "DELETE" && id) {
      if (!calendar.events.delete(id)) return new Response(null, { status: 410 })
      return new Response(null, { status: 204 })
    }
  }
  throw new Error(`Unexpected fetch ${method} ${url.href}`)
}

async function seedCareer() {
  const soon = new Date(Date.now() + 2 * DAY).toISOString()
  await repositories.companies.create(USER, {
    id: "cmp_nw",
    name: "Northwind",
    industry: "",
    website: "",
    location: "",
    size: "",
    status: "active",
    description: "",
    notes: "",
    createdAt: soon,
  })
  await repositories.applications.create(USER, {
    id: "app_1",
    companyId: "cmp_nw",
    role: "Frontend Engineer",
    location: "",
    workMode: "remote",
    status: "applied",
    priority: "high",
    nextFollowUp: soon,
    notes: "",
    timeline: [],
    createdAt: soon,
    updatedAt: soon,
  })
  await repositories.interviews.create(USER, {
    id: "int_1",
    applicationId: "app_1",
    type: "technical",
    scheduledAt: soon,
    durationMinutes: 45,
    interviewers: ["Ana"],
    meetingUrl: "https://meet.example/abc",
    status: "scheduled",
    notes: "",
    createdAt: soon,
  })
  await repositories.tasks.create(USER, {
    id: "tsk_1",
    title: "Prepare system design",
    description: "",
    priority: "high",
    status: "todo",
    dueDate: soon,
    createdAt: soon,
  })
  await repositories.tasks.create(USER, {
    id: "tsk_done",
    title: "Done already",
    description: "",
    priority: "low",
    status: "done",
    dueDate: soon,
    createdAt: soon,
  })
}

async function connectCalendar() {
  return call<GoogleCalendarStatus>(handler, "POST", "/integrations/google-calendar/connect", {
    body: { code: "good-code", state: createState(USER, "calendar") },
  })
}

describe("Google Calendar", () => {
  beforeEach(() => {
    calendar.events = new Map()
    calendar.calls = []
    calendar.scope = "https://www.googleapis.com/auth/calendar.events openid email"
    vi.stubGlobal("fetch", vi.fn(calendarFetch))
  })

  it("asks Google for calendar event access", async () => {
    const res = await call<{ url: string }>(
      handler,
      "GET",
      "/integrations/google-calendar/auth-url",
    )
    const url = new URL(res.body.data?.url as string)
    expect(url.searchParams.get("scope")).toContain("auth/calendar.events")
    expect(url.searchParams.get("scope")).not.toContain("drive")
  })

  it("won't finish a Drive sign-in as a Calendar connection", async () => {
    const res = await call(handler, "POST", "/integrations/google-calendar/connect", {
      body: { code: "good-code", state: createState(USER, "drive") },
    })
    expect(res.status).toBe(400)
    expect(await settingsRepository.get(USER, "GOOGLE_CALENDAR")).toBeUndefined()
  })

  it("refuses a grant without calendar access", async () => {
    calendar.scope = "openid email"
    const res = await connectCalendar()
    expect(res.status).toBe(400)
  })

  it("syncs interviews, follow-ups and open tasks, then removes what no longer applies", async () => {
    await seedCareer()
    expect((await connectCalendar()).body.data).toMatchObject({
      connected: true,
      account: "me@gmail.example",
    })

    const res = await call<GoogleCalendarStatus>(
      handler,
      "POST",
      "/integrations/google-calendar/sync",
      {
        query: { tzOffset: "-330" },
      },
    )
    expect(res.status).toBe(200)
    expect(res.body.data?.lastSync).toMatchObject({
      synced: 3,
      removed: 0,
      interviews: 1,
      followUps: 1,
      tasks: 1,
    })
    const interviewId = calendarEventId(USER, "interview", "int_1")
    expect(interviewId).toMatch(/^[0-9a-v]{5,1024}$/)
    const event = calendar.events.get(interviewId) as {
      summary: string
      start: { dateTime: string }
      end: { dateTime: string }
      location: string
    }
    expect(event.summary).toBe("Technical interview — Frontend Engineer at Northwind")
    expect(event.location).toBe("https://meet.example/abc")
    expect(Date.parse(event.end.dateTime) - Date.parse(event.start.dateTime)).toBe(45 * 60_000)
    const followUp = calendar.events.get(calendarEventId(USER, "application", "app_1")) as {
      start: { date: string }
      end: { date: string }
    }
    expect(followUp.start.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(calendar.events.has(calendarEventId(USER, "task", "tsk_done"))).toBe(false)

    // Syncing again updates the same events instead of duplicating them.
    await googleCalendarService.sync(USER, -330)
    expect(calendar.events.size).toBe(3)

    // A cancelled interview disappears from the calendar on the next sync.
    const interview = await repositories.interviews.getOrThrow(USER, "int_1")
    await repositories.interviews.replace(USER, { ...interview, status: "cancelled" })
    const after = await googleCalendarService.sync(USER, -330)
    expect(after.lastSync).toMatchObject({ synced: 2, removed: 1 })
    expect(calendar.events.has(interviewId)).toBe(false)
  })

  it("can remove its events when disconnecting", async () => {
    await seedCareer()
    await connectCalendar()
    await googleCalendarService.sync(USER, 0)
    const res = await call<GoogleCalendarStatus>(
      handler,
      "DELETE",
      "/integrations/google-calendar",
      {
        query: { removeEvents: "true" },
      },
    )
    expect(res.body.data?.connected).toBe(false)
    expect(calendar.events.size).toBe(0)
    expect(await settingsRepository.get(USER, "GOOGLE_CALENDAR")).toBeUndefined()
  })
})

/* ------------------------------------------------------------------ */
/* AWS S3 backup                                                       */
/* ------------------------------------------------------------------ */

const bucket = {
  objects: new Map<string, { body: string; size: number }>(),
  reject: undefined as string | undefined,
  credentials: [] as string[],
}

function fakeBucket() {
  setBackupClientFactory((stored, secret) => {
    bucket.credentials.push(`${stored.accessKeyId}:${secret}`)
    return {
      send: (async (command: unknown) => {
        if (bucket.reject) throw Object.assign(new Error(bucket.reject), { name: bucket.reject })
        if (command instanceof PutObjectCommand) {
          const body = command.input.Body
          const text =
            typeof body === "string" ? body : new TextDecoder().decode(body as Uint8Array)
          bucket.objects.set(command.input.Key as string, { body: text, size: text.length })
          return {}
        }
        if (command instanceof HeadObjectCommand) {
          const object = bucket.objects.get(command.input.Key as string)
          if (!object) throw Object.assign(new Error("NotFound"), { name: "NotFound" })
          return { ContentLength: object.size }
        }
        throw new Error("unexpected command")
      }) as never,
    }
  })
}

const awsBody = {
  bucket: "my-iamcandidate-backups",
  region: "ap-south-1",
  prefix: "personal/",
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "secret/example+key",
}

describe("AWS S3 backup", () => {
  beforeEach(() => {
    bucket.objects = new Map()
    bucket.reject = undefined
    bucket.credentials = []
    fakeBucket()
  })

  it("checks it can write to the bucket before saving the key", async () => {
    const res = await call<AwsBackupStatus>(handler, "PUT", "/integrations/aws-s3", {
      body: awsBody,
    })
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({
      connected: true,
      bucket: "my-iamcandidate-backups",
      prefix: "personal/",
      accessKeyId: "…MPLE",
    })
    expect([...bucket.objects.keys()]).toEqual(["personal/iamcandidate-backup/connection-check.txt"])
    const stored = await settingsRepository.get(USER, "AWS_BACKUP")
    expect(JSON.stringify(stored)).not.toContain(awsBody.secretAccessKey)
  })

  it("explains bad credentials and doesn't save them", async () => {
    bucket.reject = "InvalidAccessKeyId"
    const res = await call(handler, "PUT", "/integrations/aws-s3", { body: awsBody })
    expect(res.status).toBe(400)
    expect(res.body.error?.message).toMatch(/access key/)
    expect(await settingsRepository.get(USER, "AWS_BACKUP")).toBeUndefined()
  })

  it("keeps the saved secret when it's left empty", async () => {
    await call(handler, "PUT", "/integrations/aws-s3", { body: awsBody })
    const res = await call(handler, "PUT", "/integrations/aws-s3", {
      body: { ...awsBody, prefix: "other", secretAccessKey: "" },
    })
    expect(res.status).toBe(200)
    expect(bucket.credentials.at(-1)).toBe(`${awsBody.accessKeyId}:${awsBody.secretAccessKey}`)
  })

  it("writes a data export and copies document files, skipping unchanged ones", async () => {
    await call(handler, "PUT", "/integrations/aws-s3", { body: awsBody })
    await repositories.documents.create(USER, {
      id: "doc_1",
      name: "Resume 2026.pdf",
      category: "resume",
      kind: "pdf",
      sizeBytes: 11,
      starred: false,
      source: "local",
      mimeType: "application/pdf",
      s3Key: "users/usr_test/documents/doc_1/Resume 2026.pdf",
      uploadedAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    })
    await repositories.documents.create(USER, {
      id: "doc_seed",
      name: "No file.pdf",
      category: "other",
      kind: "pdf",
      sizeBytes: 5,
      starred: false,
      source: "local",
      uploadedAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    })
    await settingsRepository.put(USER, "GITHUB", {
      login: "octo",
      encryptedToken: "v1.secret",
      connectedAt: "2026-10-01T00:00:00.000Z",
    })
    const reads: string[] = []
    testState.s3Send = async (command) => {
      if (command instanceof GetObjectCommand) {
        reads.push(command.input.Key as string)
        return {
          ContentType: "application/pdf",
          Body: { transformToByteArray: async () => new TextEncoder().encode("%PDF resume") },
        }
      }
      return {}
    }

    const res = await call<BackupProgress>(handler, "POST", "/integrations/aws-s3/backup", {
      body: {},
    })
    expect(res.body.data).toMatchObject({ done: true, copied: 1, total: 1, failed: 0 })
    expect(reads).toEqual(["users/usr_test/documents/doc_1/Resume 2026.pdf"])
    expect(bucket.objects.get("personal/iamcandidate-backup/documents/doc_1/Resume 2026.pdf")?.body).toBe(
      "%PDF resume",
    )
    const dataKey = res.body.data?.dataKey as string
    expect(dataKey).toMatch(/^personal\/iamcandidate-backup\/data\/iamcandidate-\d{8}T\d{6}Z\.json$/)
    const exported = JSON.parse(bucket.objects.get(dataKey)?.body ?? "{}") as Record<
      string,
      unknown
    >
    expect(exported).toMatchObject({ format: "iamcandidate-backup", userId: USER })
    expect((exported.documents as unknown[]).length).toBe(2)
    const text = JSON.stringify(exported)
    expect(text).not.toContain("s3Key")
    expect(text).not.toContain("encryptedToken")
    expect((await settingsRepository.get(USER, "AWS_BACKUP"))?.lastBackup?.documents).toBe(1)

    // Second run: the file is already there with the same size.
    reads.length = 0
    const again = await call<BackupProgress>(handler, "POST", "/integrations/aws-s3/backup", {
      body: {},
    })
    expect(again.body.data).toMatchObject({ done: true, copied: 1, bytes: 0 })
    expect(reads).toEqual([])
  })

  it("rejects a tampered cursor", async () => {
    await call(handler, "PUT", "/integrations/aws-s3", { body: awsBody })
    const res = await call(handler, "POST", "/integrations/aws-s3/backup", {
      body: { cursor: "bm90LWEtY3Vyc29y" },
    })
    expect(res.status).toBe(400)
  })
})

describe("overview", () => {
  it("returns every integration's status in one call", async () => {
    vi.stubGlobal("fetch", vi.fn(githubFetch))
    await connectGitHub()
    const res = await call<IntegrationsOverview>(handler, "GET", "/integrations")
    expect(res.body.data).toMatchObject({
      googleDrive: { connected: false, available: true },
      googleCalendar: { connected: false, available: true },
      github: { connected: true, account: "octo" },
      linkedin: { imports: {} },
      aws: { connected: false },
    })
  })
})
