import { z } from "zod"

import { longText, patchSchema, requiredText, shortText, stringList } from "../lib/validation"
import { DOCUMENT_CATEGORIES, FILE_KINDS } from "../models"

/** Same limit the compiler enforces. */
export const MAX_LATEX_SOURCE = 200_000

export const compileLatexInput = z.strictObject({
  source: z
    .string()
    .min(1, "The document is empty")
    .max(MAX_LATEX_SOURCE, "The document is too long"),
})

/** Matches the limit the upload dialog advertises. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024

export const ALLOWED_CONTENT_TYPES = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/csv",
  "text/plain",
  "text/markdown",
  "application/zip",
  "application/x-zip-compressed",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "application/octet-stream",
] as const

const fileName = requiredText(255).refine(
  (name) => !/[\\/]/.test(name),
  "File name cannot contain slashes",
)

/* Documents --------------------------------------------------------- */

export const uploadUrlInput = z.strictObject({
  fileName,
  contentType: z.enum(ALLOWED_CONTENT_TYPES),
  sizeBytes: z.number().int().positive().max(MAX_UPLOAD_BYTES, "Files must be 25 MB or smaller"),
})

/** Saves metadata for a file already uploaded with a presigned URL. */
export const documentInput = z.strictObject({
  uploadKey: z.string().min(1).max(1024),
  name: fileName,
  category: z.enum(DOCUMENT_CATEGORIES),
  kind: z.enum(FILE_KINDS),
  sizeBytes: z.number().int().nonnegative(),
  description: shortText(2000).optional(),
})
export type DocumentInput = z.output<typeof documentInput>

export const documentPatch = patchSchema(
  z.object({
    name: fileName,
    category: z.enum(DOCUMENT_CATEGORIES),
    starred: z.boolean(),
    description: shortText(2000).optional(),
  }),
)

export const documentQuery = z.object({
  category: z.enum(DOCUMENT_CATEGORIES).optional(),
  starred: z.enum(["true", "false"]).optional(),
})

/* Resumes ----------------------------------------------------------- */

const experience = z.strictObject({
  id: z.string().min(1).max(64),
  company: shortText(),
  title: shortText(),
  period: shortText(100),
  highlights: z.array(shortText(1000)).max(30),
})

const education = z.strictObject({
  id: z.string().min(1).max(64),
  school: shortText(),
  degree: shortText(),
  period: shortText(100),
})

export const resumeInput = z.strictObject({
  title: requiredText(),
  targetRole: shortText(),
  version: shortText(20),
  isDefault: z.boolean(),
  summary: longText(5000),
  skills: stringList(100),
  experience: z.array(experience).max(30),
  education: z.array(education).max(20),
  format: z.enum(["structured", "latex"]).optional(),
  latexSource: z.string().max(MAX_LATEX_SOURCE).optional(),
  documentId: z.string().min(1).max(128).optional(),
})
export type ResumeInput = z.output<typeof resumeInput>
export const resumePatch = patchSchema(resumeInput)
