import { z } from "zod"

import { BadRequestError, ValidationError } from "./errors"

/** Parses `value` with `schema`, throwing a 400 VALIDATION_ERROR on failure. */
export function validate<S extends z.ZodType>(
  schema: S,
  value: unknown,
  where: string,
): z.output<S> {
  const result = schema.safeParse(value)
  if (result.success) return result.data
  const issues = result.error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }))
  throw new ValidationError(`Invalid ${where}`, issues)
}

/** Parses a JSON request body (base64-aware). */
export function parseJsonBody(body: string | undefined, isBase64Encoded = false): unknown {
  if (!body) return undefined
  const text = isBase64Encoded ? Buffer.from(body, "base64").toString("utf8") : body
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new BadRequestError("Request body must be valid JSON")
  }
}

/** A PATCH body: every field optional; `null` clears an optional field. */
export type Patch<T> = { [K in keyof T]?: undefined extends T[K] ? T[K] | null : T[K] }

/**
 * Turns an object schema into a PATCH schema: every field becomes optional and
 * fields that are optional on the entity also accept `null`, meaning "clear it".
 * Unknown fields are rejected so typos don't silently do nothing.
 */
export function patchSchema<T extends z.ZodObject>(schema: T): z.ZodType<Patch<z.output<T>>> {
  const shape: Record<string, z.ZodType> = {}
  for (const [key, field] of Object.entries(schema.shape) as Array<[string, z.ZodType]>) {
    shape[key] = field.safeParse(undefined).success ? field.nullable().optional() : field.optional()
  }
  return z
    .strictObject(shape)
    .refine(
      (value) => Object.keys(value).length > 0,
      "Provide at least one field to update",
    ) as z.ZodType<Patch<z.output<T>>>
}

/** Applies a validated patch: `null` removes the key, `undefined` leaves it untouched. */
export function applyPatch<T extends object>(item: T, patch: object): T {
  const next = { ...item } as Record<string, unknown>
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    if (value === null) delete next[key]
    else next[key] = value
  }
  return next as T
}

/* ------------------------------------------------------------------ */
/* Shared field schemas                                                */
/* ------------------------------------------------------------------ */

export const idParam = z.object({ id: z.string().trim().min(1).max(128) })

/** ISO-8601 date-time, with `Z` or an offset. */
export const isoDate = z.iso.datetime({ offset: true })

export const shortText = (max = 200) => z.string().trim().max(max)
export const longText = (max = 20_000) => z.string().max(max)
export const requiredText = (max = 200) => z.string().trim().min(1, "Required").max(max)
export const urlText = z.string().trim().max(2048)
export const stringList = (maxItems = 50, maxLength = 100) =>
  z.array(z.string().trim().min(1).max(maxLength)).max(maxItems)
