import { created, noContent, ok } from "../lib/response"
import type { Routes } from "../lib/router"
import { validate } from "../lib/validation"
import {
  composeEmailInput,
  emailPatch,
  emailQuery,
  sendEmailInput,
  smtpSettingsInput,
  templateInput,
  templatePatch,
} from "../schemas/communication"
import { emailsService } from "../services/emails.service"
import { smtpService } from "../services/smtp.service"
import { templatesService } from "../services/templates.service"
import { crudRoutes, pathId } from "./crud"

export const emailRoutes: Routes = {
  "GET /emails": async (ctx) =>
    ok(await emailsService.list(ctx.userId, validate(emailQuery, ctx.query, "query parameters"))),
  "GET /emails/{id}": async (ctx) => ok(await emailsService.get(ctx.userId, pathId(ctx))),
  "POST /emails/send": async (ctx) =>
    created(
      await emailsService.send(ctx.userId, validate(sendEmailInput, ctx.body, "request body")),
    ),
  "POST /emails/drafts": async (ctx) =>
    created(
      await emailsService.saveDraft(
        ctx.userId,
        validate(composeEmailInput, ctx.body, "request body"),
      ),
    ),
  "PUT /emails/drafts/{id}": async (ctx) => {
    const id = pathId(ctx)
    const input = validate(composeEmailInput, ctx.body, "request body")
    return ok(await emailsService.saveDraft(ctx.userId, input, id))
  },
  "PUT /emails/{id}": async (ctx) => {
    const id = pathId(ctx)
    return ok(
      await emailsService.update(ctx.userId, id, validate(emailPatch, ctx.body, "request body")),
    )
  },
  "DELETE /emails/{id}": async (ctx) => {
    await emailsService.remove(ctx.userId, pathId(ctx))
    return noContent()
  },
}

export const templateRoutes: Routes = {
  ...crudRoutes("/templates", templatesService, { input: templateInput, patch: templatePatch }),
  "POST /templates/{id}/duplicate": async (ctx) =>
    created(await templatesService.duplicate(ctx.userId, pathId(ctx))),
  /** Re-adds any default templates the user deleted. */
  "POST /templates/defaults": async (ctx) => ok(await templatesService.restoreDefaults(ctx.userId)),
}

export const smtpRoutes: Routes = {
  "GET /settings/smtp": async (ctx) => ok(await smtpService.get(ctx.userId)),
  "PUT /settings/smtp": async (ctx) =>
    ok(await smtpService.save(ctx.userId, validate(smtpSettingsInput, ctx.body, "request body"))),
  "DELETE /settings/smtp": async (ctx) => {
    await smtpService.remove(ctx.userId)
    return noContent()
  },
  "POST /settings/smtp/test": async (ctx) =>
    ok(await smtpService.test(ctx.userId, validate(smtpSettingsInput, ctx.body, "request body"))),
}
