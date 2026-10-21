import { randomUUID } from "node:crypto"

/** `prefix_<16 hex chars>` — same shape as the frontend's mock ids. */
export function createId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`
}

export function nowIso(): string {
  return new Date().toISOString()
}
