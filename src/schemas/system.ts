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

const yesNo = z.enum(["yes", "no", ""])

/** The text fields of an autofill profile (everything but the answers). */
const autofillFields = {
  firstName: shortText(100),
  lastName: shortText(100),
  preferredName: shortText(100),
  email: z.union([z.literal(""), z.email()]),
  phone: shortText(50),
  pronouns: shortText(50),
  addressLine: shortText(),
  city: shortText(100),
  state: shortText(100),
  postalCode: shortText(20),
  country: shortText(100),
  linkedin: urlText,
  github: urlText,
  portfolio: urlText,
  currentTitle: shortText(),
  currentCompany: shortText(),
  experienceYears: shortText(20),
  noticePeriod: shortText(100),
  currentSalary: shortText(100),
  expectedSalary: shortText(100),
  workAuthorization: yesNo,
  needsSponsorship: yesNo,
  willingToRelocate: yesNo,
  school: shortText(),
  degree: shortText(),
  fieldOfStudy: shortText(),
  graduationYear: shortText(10),
  gender: shortText(100),
  ethnicity: shortText(100),
  disability: shortText(100),
  veteran: shortText(100),
  summary: longText(5000),
  coverLetter: longText(20_000),
}

const autofillAnswer = z.strictObject({
  id: z.string().max(128).optional(),
  question: requiredText(500),
  answer: longText(5000),
})

const yearMonth = z.union([z.literal(""), z.string().regex(/^(19|20)\d{2}-(0[1-9]|1[0-2])$/, "Use YYYY-MM")])

const autofillJob = z.strictObject({
  title: shortText(),
  company: shortText(),
  location: shortText(),
  startDate: yearMonth,
  endDate: yearMonth,
  current: z.boolean(),
  description: longText(5000),
})

export const autofillProfileInput = z.strictObject({
  ...autofillFields,
  experience: z.array(autofillJob).max(30).default([]),
  answers: z.array(autofillAnswer).max(500),
})

/** What the extension learned from a form: details only fill empty fields; answers are upserted by question. */
export const autofillLearnInput = z.strictObject({
  details: z.strictObject(autofillFields).partial().default({}),
  answers: z
    .array(z.strictObject({ question: requiredText(500), answer: longText(5000) }))
    .max(100)
    .default([]),
})

export const notificationPreferencesInput = z.strictObject({
  emailNotifications: z.boolean(),
  interviewReminders: z.boolean(),
  taskReminders: z.boolean(),
  followUpReminders: z.boolean(),
  weeklyDigest: z.boolean(),
})
