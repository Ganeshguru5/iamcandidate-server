import type { z } from "zod"

import { created, noContent, ok } from "../lib/response"
import type { RequestContext, Routes } from "../lib/router"
import { idParam, validate } from "../lib/validation"

interface CrudLike<T, TInput, TPatch, TFilters> {
  list(userId: string, filters: TFilters): Promise<T[]>
  get(userId: string, id: string): Promise<T>
  create(userId: string, input: TInput): Promise<T>
  update(userId: string, id: string, patch: TPatch): Promise<T>
  remove(userId: string, id: string): Promise<unknown>
}

/** Path `id` parameter, validated. */
export function pathId(ctx: RequestContext): string {
  return validate(idParam, ctx.params, "path parameters").id
}

/**
 * The five standard REST routes for a resource:
 * `GET /x`, `POST /x`, `GET /x/{id}`, `PUT /x/{id}` (partial update), `DELETE /x/{id}`.
 */
export function crudRoutes<T, TInput, TPatch, TFilters>(
  base: string,
  service: CrudLike<T, TInput, TPatch, TFilters>,
  schemas: {
    input: z.ZodType<TInput>
    patch: z.ZodType<TPatch>
    query?: z.ZodType<TFilters>
  },
): Routes {
  return {
    [`GET ${base}`]: async (ctx) => {
      const filters = schemas.query
        ? validate(schemas.query, ctx.query, "query parameters")
        : ({} as TFilters)
      return ok(await service.list(ctx.userId, filters))
    },
    [`POST ${base}`]: async (ctx) =>
      created(await service.create(ctx.userId, validate(schemas.input, ctx.body, "request body"))),
    [`GET ${base}/{id}`]: async (ctx) => ok(await service.get(ctx.userId, pathId(ctx))),
    [`PUT ${base}/{id}`]: async (ctx) => {
      const id = pathId(ctx)
      const patch = validate(schemas.patch, ctx.body, "request body")
      return ok(await service.update(ctx.userId, id, patch))
    },
    [`DELETE ${base}/{id}`]: async (ctx) => {
      await service.remove(ctx.userId, pathId(ctx))
      return noContent()
    },
  }
}
