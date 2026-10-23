import { z } from "zod"

import { created, ok } from "../lib/response"
import type { Routes } from "../lib/router"
import { validate } from "../lib/validation"
import { DOCUMENT_CATEGORIES, type IntegrationsOverview } from "../models"
import { awsBackupService } from "../services/aws-backup.service"
import { githubService } from "../services/github.service"
import { googleCalendarService } from "../services/google-calendar.service"
import { googleDriveService } from "../services/google-drive.service"
import { linkedinService } from "../services/linkedin.service"

const connectInput = z.strictObject({
  code: z.string().min(1).max(2048),
  state: z.string().min(1).max(1024),
})

const filesQuery = z.object({
  parentId: z
    .string()
    .regex(/^[\w-]{1,200}$/, "Invalid folder id")
    .optional(),
})

const importInput = z.strictObject({
  fileId: z.string().regex(/^[\w-]{1,200}$/, "Invalid file id"),
  category: z.enum(DOCUMENT_CATEGORIES).optional(),
})

export const googleDriveRoutes: Routes = {
  "GET /integrations/google-drive": async (ctx) => ok(await googleDriveService.status(ctx.userId)),
  "GET /integrations/google-drive/auth-url": async (ctx) =>
    ok(googleDriveService.authUrl(ctx.userId)),
  "POST /integrations/google-drive/connect": async (ctx) => {
    const { code, state } = validate(connectInput, ctx.body, "request body")
    return ok(await googleDriveService.connect(ctx.userId, code, state))
  },
  "DELETE /integrations/google-drive": async (ctx) =>
    ok(await googleDriveService.disconnect(ctx.userId)),
  "GET /integrations/google-drive/files": async (ctx) => {
    const { parentId } = validate(filesQuery, ctx.query, "query parameters")
    return ok(await googleDriveService.list(ctx.userId, parentId))
  },
  "POST /integrations/google-drive/import": async (ctx) => {
    const { fileId, category } = validate(importInput, ctx.body, "request body")
    return created(await googleDriveService.import(ctx.userId, fileId, category))
  },
}

/* Google Calendar --------------------------------------------------- */

const tzQuery = z.object({
  tzOffset: z.coerce.number().int().min(-840).max(840).default(0),
})

const calendarDisconnectQuery = z.object({
  removeEvents: z.enum(["true", "false"]).default("false"),
})

export const googleCalendarRoutes: Routes = {
  "GET /integrations/google-calendar": async (ctx) =>
    ok(await googleCalendarService.status(ctx.userId)),
  "GET /integrations/google-calendar/auth-url": async (ctx) =>
    ok(googleCalendarService.authUrl(ctx.userId)),
  "POST /integrations/google-calendar/connect": async (ctx) => {
    const { code, state } = validate(connectInput, ctx.body, "request body")
    return ok(await googleCalendarService.connect(ctx.userId, code, state))
  },
  "POST /integrations/google-calendar/sync": async (ctx) => {
    const { tzOffset } = validate(tzQuery, ctx.query, "query parameters")
    return ok(await googleCalendarService.sync(ctx.userId, tzOffset))
  },
  "DELETE /integrations/google-calendar": async (ctx) => {
    const { removeEvents } = validate(calendarDisconnectQuery, ctx.query, "query parameters")
    return ok(await googleCalendarService.disconnect(ctx.userId, removeEvents === "true"))
  },
}

/* GitHub ------------------------------------------------------------ */

const githubConnectInput = z.strictObject({
  token: z
    .string()
    .trim()
    .min(20, "That doesn't look like a GitHub token")
    .max(255)
    .regex(/^[\w-]+$/, "That doesn't look like a GitHub token"),
})

const repoName = z
  .string()
  .trim()
  .regex(/^[\w.-]{1,100}\/[\w.-]{1,100}$/, "Use the repository as owner/name")

export const githubRoutes: Routes = {
  "GET /integrations/github": async (ctx) => ok(await githubService.status(ctx.userId)),
  "PUT /integrations/github": async (ctx) => {
    const { token } = validate(githubConnectInput, ctx.body, "request body")
    return ok(await githubService.connect(ctx.userId, token))
  },
  "DELETE /integrations/github": async (ctx) => ok(await githubService.disconnect(ctx.userId)),
  "GET /integrations/github/repos": async (ctx) => ok(await githubService.repos(ctx.userId)),
  "GET /integrations/github/activity": async (ctx) => {
    const { repo } = validate(z.object({ repo: repoName }), ctx.query, "query parameters")
    return ok(await githubService.activity(ctx.userId, repo))
  },
  "POST /integrations/github/import": async (ctx) => {
    const { repo } = validate(z.strictObject({ repo: repoName }), ctx.body, "request body")
    return created(await githubService.importRepo(ctx.userId, repo))
  },
}

/* LinkedIn ---------------------------------------------------------- */

const linkedinImportInput = z.strictObject({
  csv: z
    .string()
    .min(1, "The file is empty")
    .max(5 * 1024 * 1024, "Files must be 5 MB or smaller"),
  dryRun: z.boolean().default(false),
})

export const linkedinRoutes: Routes = {
  "GET /integrations/linkedin": async (ctx) => ok(await linkedinService.status(ctx.userId)),
  "POST /integrations/linkedin/import": async (ctx) => {
    const { csv, dryRun } = validate(linkedinImportInput, ctx.body, "request body")
    return ok(await linkedinService.import(ctx.userId, csv, dryRun))
  },
}

/* AWS S3 backup ----------------------------------------------------- */

const awsInput = z.strictObject({
  bucket: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, "Enter a valid S3 bucket name"),
  region: z
    .string()
    .trim()
    .regex(/^[a-z]{2}(-gov)?-[a-z]+-\d$/, "Enter an AWS region like ap-south-1"),
  prefix: z
    .string()
    .trim()
    .max(200)
    .regex(/^[\w!.*'()/-]*$/, "Use letters, numbers, / - _ . in the folder")
    .default(""),
  accessKeyId: z
    .string()
    .trim()
    .regex(/^[A-Z0-9]{16,128}$/, "Enter a valid access key ID"),
  secretAccessKey: z.string().trim().max(128).default(""),
})

const backupInput = z.strictObject({
  cursor: z.string().max(2000).optional(),
})

export const awsBackupRoutes: Routes = {
  "GET /integrations/aws-s3": async (ctx) => ok(await awsBackupService.status(ctx.userId)),
  "PUT /integrations/aws-s3": async (ctx) =>
    ok(await awsBackupService.connect(ctx.userId, validate(awsInput, ctx.body, "request body"))),
  "DELETE /integrations/aws-s3": async (ctx) => ok(await awsBackupService.disconnect(ctx.userId)),
  "POST /integrations/aws-s3/backup": async (ctx) => {
    const { cursor } = validate(backupInput, ctx.body ?? {}, "request body")
    return ok(await awsBackupService.backup(ctx.userId, cursor))
  },
}

/* Overview ---------------------------------------------------------- */

export const integrationsOverviewRoutes: Routes = {
  "GET /integrations": async (ctx) => {
    const [googleDrive, googleCalendar, github, linkedin, aws] = await Promise.all([
      googleDriveService.status(ctx.userId),
      googleCalendarService.status(ctx.userId),
      githubService.status(ctx.userId),
      linkedinService.status(ctx.userId),
      awsBackupService.status(ctx.userId),
    ])
    const overview: IntegrationsOverview = { googleDrive, googleCalendar, github, linkedin, aws }
    return ok(overview)
  },
}

/** Every integration route (IntegrationsFunction and the local dev server). */
export const integrationRoutes: Routes = {
  ...integrationsOverviewRoutes,
  ...googleDriveRoutes,
  ...googleCalendarRoutes,
  ...githubRoutes,
  ...linkedinRoutes,
  ...awsBackupRoutes,
}
