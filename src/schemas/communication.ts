import { z } from "zod"

import { longText, patchSchema, requiredText, shortText } from "../lib/validation"
import { SMTP_ENCRYPTIONS, TEMPLATE_CATEGORIES } from "../models"

const entityId = z.string().trim().min(1).max(128)
const address = z.string().trim().toLowerCase().pipe(z.email().max(254))

/* Emails ------------------------------------------------------------ */

export const composeEmailInput = z.strictObject({
  to: z.array(address).max(50),
  cc: z.array(address).max(50),
  subject: shortText(998),
  body: longText(100_000),
  applicationId: entityId.optional(),
  contactId: entityId.optional(),
  templateId: entityId.optional(),
})
export type ComposeEmailInput = z.output<typeof composeEmailInput>

/** Sending needs a recipient; drafts may be incomplete. */
export const sendEmailInput = composeEmailInput.refine((value) => value.to.length > 0, {
  message: "Add at least one recipient",
  path: ["to"],
})

export const emailPatch = z
  .strictObject({ read: z.boolean().optional(), starred: z.boolean().optional() })
  .refine((value) => Object.keys(value).length > 0, "Provide read and/or starred")

export const emailQuery = z.object({
  folder: z.enum(["inbox", "sent", "drafts"]).optional(),
  applicationId: entityId.optional(),
  contactId: entityId.optional(),
})

/* Templates --------------------------------------------------------- */

export const templateInput = z.strictObject({
  name: requiredText(),
  category: z.enum(TEMPLATE_CATEGORIES),
  subject: shortText(998),
  body: longText(50_000),
})
export type TemplateInput = z.output<typeof templateInput>
export const templatePatch = patchSchema(templateInput)

/* SMTP -------------------------------------------------------------- */

/** `password` may be empty to keep the stored one. */
export const smtpSettingsInput = z.strictObject({
  host: z
    .string()
    .trim()
    .min(1, "Host is required")
    .max(253)
    .regex(/^[a-z0-9.-]+$/i, "Enter a host name, e.g. smtp.gmail.com"),
  port: z.number().int().min(1).max(65_535),
  username: requiredText(254),
  password: z.string().max(500),
  encryption: z.enum(SMTP_ENCRYPTIONS),
  senderName: requiredText(100),
  senderEmail: address,
  /** Accepted (and ignored) so clients can send back what they loaded. */
  lastTestedAt: z.string().optional(),
  hasPassword: z.boolean().optional(),
})
export type SmtpSettingsInput = z.output<typeof smtpSettingsInput>
