import { z } from "zod"

import { requiredText } from "../lib/validation"
import { USER_ROLES } from "../models"

/** New passwords; existing ones are only checked for presence. */
const newPassword = z
  .string()
  .min(8, "Use at least 8 characters")
  .max(200, "Use at most 200 characters")

/** Emails are trimmed and lowercased before validation (logins are case-insensitive). */
const email = z.string().trim().toLowerCase().pipe(z.email().max(254))

export const loginInput = z.strictObject({
  email,
  password: z.string().min(1, "Required").max(200),
})

export const changePasswordInput = z.strictObject({
  currentPassword: z.string().min(1, "Required").max(200),
  newPassword,
})

export const createUserInput = z.strictObject({
  email,
  name: requiredText(100),
  password: newPassword,
  role: z.enum(USER_ROLES),
})
export type CreateUserInput = z.output<typeof createUserInput>

/** Public sign-up form: the password is the one they'll sign in with once granted. */
export const accessRequestInput = z.strictObject({
  email,
  name: requiredText(100),
  password: newPassword,
  message: z.string().trim().max(500).optional(),
})
export type AccessRequestInput = z.output<typeof accessRequestInput>

/** Email is the login id and is not editable; recreate the user to change it. */
export const updateUserInput = z
  .strictObject({
    name: requiredText(100).optional(),
    role: z.enum(USER_ROLES).optional(),
    disabled: z.boolean().optional(),
    password: newPassword.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "Provide at least one field to update")
export type UpdateUserInput = z.output<typeof updateUserInput>
