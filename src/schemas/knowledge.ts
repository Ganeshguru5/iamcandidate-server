import { z } from "zod"

import {
  isoDate,
  patchSchema,
  requiredText,
  shortText,
  stringList,
  urlText,
} from "../lib/validation"
import { LINK_CATEGORIES, SKILL_GROUPS } from "../models"

export const skillInput = z.strictObject({
  name: requiredText(100),
  group: z.enum(SKILL_GROUPS),
  proficiency: z.number().min(0).max(100),
  years: z.number().min(0).max(60),
})
export type SkillInput = z.output<typeof skillInput>
export const skillPatch = patchSchema(skillInput)

export const certificationInput = z.strictObject({
  name: requiredText(),
  issuer: shortText(),
  issueDate: isoDate,
  expiryDate: isoDate.optional(),
  credentialId: shortText(),
  credentialUrl: urlText,
  documentId: z.string().min(1).max(128).optional(),
  skills: stringList(),
})
export type CertificationInput = z.output<typeof certificationInput>
export const certificationPatch = patchSchema(certificationInput)

export const linkInput = z.strictObject({
  title: requiredText(300),
  url: z.url().max(2048),
  description: shortText(2000),
  tags: stringList(),
  category: z.enum(LINK_CATEGORIES),
  favorite: z.boolean(),
})
export type LinkInput = z.output<typeof linkInput>
export const linkPatch = patchSchema(linkInput)

export const linkQuery = z.object({ category: z.enum(LINK_CATEGORIES).optional() })
