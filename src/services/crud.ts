import { createId, nowIso } from "../lib/ids"
import { applyPatch, type Patch } from "../lib/validation"
import type { Entity } from "../models"
import type { EntityRepository } from "../repositories/dynamodb"

export interface CrudOptions<T extends Entity, TInput> {
  idPrefix: string
  build: (input: TInput, id: string, now: string) => T
  /** Fields refreshed on every update (e.g. `updatedAt`). */
  touch?: (now: string) => Partial<T>
  /** Order returned by `list`; defaults to the repository order. */
  sort?: (a: T, b: T) => number
}

/** Newest-first comparator on an ISO date field. */
export function byDateDesc<T>(field: keyof T) {
  return (a: T, b: T) => String(b[field] ?? "").localeCompare(String(a[field] ?? ""))
}

/** Keeps items whose fields equal every provided (defined) filter value. */
export function filterItems<T>(items: T[], filters: Partial<Record<keyof T, unknown>>): T[] {
  const active = Object.entries(filters).filter(([, value]) => value !== undefined)
  if (active.length === 0) return items
  return items.filter((item) =>
    active.every(([key, value]) => (item as Record<string, unknown>)[key] === value),
  )
}

/** Plain CRUD over one entity type, used directly by the simpler resources. */
export function createCrudService<T extends Entity, TInput>(
  repository: EntityRepository<T>,
  options: CrudOptions<T, TInput>,
) {
  return {
    async list(userId: string): Promise<T[]> {
      const items = await repository.list(userId)
      return options.sort ? items.sort(options.sort) : items
    },

    get(userId: string, id: string): Promise<T> {
      return repository.getOrThrow(userId, id)
    },

    create(userId: string, input: TInput): Promise<T> {
      return repository.create(userId, options.build(input, createId(options.idPrefix), nowIso()))
    },

    async update(userId: string, id: string, patch: Patch<Partial<TInput>>): Promise<T> {
      const existing = await repository.getOrThrow(userId, id)
      const next = { ...applyPatch(existing, patch), ...options.touch?.(nowIso()), id }
      return repository.replace(userId, next)
    },

    async remove(userId: string, id: string): Promise<T> {
      return repository.delete(userId, id)
    },
  }
}
