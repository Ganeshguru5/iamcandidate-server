import { z } from "zod"

import {
  isoDate,
  longText,
  patchSchema,
  requiredText,
  shortText,
  stringList,
  urlText,
} from "../lib/validation"
import {
  NOTE_CATEGORIES,
  PROJECT_STATUSES,
  RELATED_TYPES,
  TASK_PRIORITIES,
  TASK_STATUSES,
} from "../models"

/* Projects ---------------------------------------------------------- */

export const projectInput = z.strictObject({
  name: requiredText(),
  description: longText(5000),
  status: z.enum(PROJECT_STATUSES),
  progress: z.number().min(0).max(100),
  technologies: stringList(),
  repository: urlText.optional(),
  deployment: urlText.optional(),
  startedAt: isoDate,
})
export type ProjectInput = z.output<typeof projectInput>
export const projectPatch = patchSchema(projectInput)

export const projectQuery = z.object({ status: z.enum(PROJECT_STATUSES).optional() })

/* Tasks ------------------------------------------------------------- */

export const taskInput = z.strictObject({
  title: requiredText(300),
  description: longText(5000),
  priority: z.enum(TASK_PRIORITIES),
  status: z.enum(TASK_STATUSES),
  dueDate: isoDate.optional(),
  related: z
    .strictObject({
      type: z.enum(RELATED_TYPES),
      id: z.string().min(1).max(128),
      label: shortText(),
    })
    .optional(),
})
export type TaskInput = z.output<typeof taskInput>
export const taskPatch = patchSchema(taskInput)

export const taskQuery = z.object({
  status: z.enum(TASK_STATUSES).optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  relatedType: z.enum(RELATED_TYPES).optional(),
  relatedId: z.string().max(128).optional(),
})

/* Notes ------------------------------------------------------------- */

export const noteInput = z.strictObject({
  title: requiredText(300),
  content: longText(100_000),
  category: z.enum(NOTE_CATEGORIES),
  tags: stringList(),
  favorite: z.boolean(),
})
export type NoteInput = z.output<typeof noteInput>
export const notePatch = patchSchema(noteInput)

export const noteQuery = z.object({
  category: z.enum(NOTE_CATEGORIES).optional(),
  favorite: z.enum(["true", "false"]).optional(),
})

/* Board ------------------------------------------------------------- */

export const boardInput = z.strictObject({ content: longText(50_000) })
export type BoardInput = z.output<typeof boardInput>
