import { created, noContent, ok } from "../lib/response"
import type { Routes } from "../lib/router"
import { validate } from "../lib/validation"
import {
  documentInput,
  documentPatch,
  documentQuery,
  resumeInput,
  resumePatch,
  uploadUrlInput,
} from "../schemas/documents"
import { documentsService } from "../services/documents.service"
import { resumesService } from "../services/resumes.service"
import { crudRoutes, pathId } from "./crud"

export const documentRoutes: Routes = {
  "GET /documents": async (ctx) => {
    const query = validate(documentQuery, ctx.query, "query parameters")
    return ok(
      await documentsService.list(ctx.userId, {
        ...(query.category ? { category: query.category } : {}),
        ...(query.starred ? { starred: query.starred === "true" } : {}),
      }),
    )
  },
  "POST /documents/upload-url": async (ctx) =>
    created(
      await documentsService.createUploadUrl(
        ctx.userId,
        validate(uploadUrlInput, ctx.body, "request body"),
      ),
    ),
  "POST /documents": async (ctx) =>
    created(
      await documentsService.create(ctx.userId, validate(documentInput, ctx.body, "request body")),
    ),
  "GET /documents/{id}": async (ctx) => ok(await documentsService.get(ctx.userId, pathId(ctx))),
  "GET /documents/{id}/download-url": async (ctx) =>
    ok(await documentsService.createDownloadUrl(ctx.userId, pathId(ctx))),
  "PUT /documents/{id}": async (ctx) => {
    const id = pathId(ctx)
    return ok(
      await documentsService.update(
        ctx.userId,
        id,
        validate(documentPatch, ctx.body, "request body"),
      ),
    )
  },
  "POST /documents/{id}/toggle-star": async (ctx) =>
    ok(await documentsService.toggleStar(ctx.userId, pathId(ctx))),
  "DELETE /documents/{id}": async (ctx) => {
    await documentsService.remove(ctx.userId, pathId(ctx))
    return noContent()
  },
}

export const resumeRoutes: Routes = {
  ...crudRoutes("/resumes", resumesService, { input: resumeInput, patch: resumePatch }),
  "POST /resumes/{id}/duplicate": async (ctx) =>
    created(await resumesService.duplicate(ctx.userId, pathId(ctx))),
  "PUT /resumes/{id}/default": async (ctx) =>
    ok(await resumesService.setDefault(ctx.userId, pathId(ctx))),
}
