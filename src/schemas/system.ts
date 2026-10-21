import { z } from "zod"

import { longText, requiredText, shortText, urlText } from "../lib/validation"

export const activityQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  cursor: z.string().max(2048).optional(),
})

/** Minutes, as returned by `Date.prototype.getTimezoneOffset()` (IST = -330). */
const tzOffset = z.coerce
  .number()
  .int()
  .min(-14 * 60)
  .max(14 * 60)
  .default(0)

export const notificationsQuery = z.object({ tzOffset })
export const dashboardQuery = z.object({ tzOffset })

export const notificationIdParam = z.object({ id: z.string().min(1).max(200) })

export const profileInput = z.strictObject({
  name: requiredText(100),
  email: z.union([z.literal(""), z.email()]),
  role: shortText(),
  bio: longText(2000),
  location: shortText(),
  avatarUrl: urlText.optional(),
})

export const notificationPreferencesInput = z.strictObject({
  emailNotifications: z.boolean(),
  interviewReminders: z.boolean(),
  taskReminders: z.boolean(),
  followUpReminders: z.boolean(),
  weeklyDigest: z.boolean(),
})
