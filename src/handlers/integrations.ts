import { z } from "zod"

import { created, ok } from "../lib/response"
import type { Routes } from "../lib/router"
import { validate } from "../lib/validation"
import { DOCUMENT_CATEGORIES } from "../models"
import { googleDriveService } from "../services/google-drive.service"

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
