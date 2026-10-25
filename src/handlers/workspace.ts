import { ok } from "../lib/response"
import type { BoardItem } from "../models"
import type { Routes } from "../lib/router"
import {
  boardItemInput,
  boardItemPatch,
  boardQuery,
  noteInput,
  notePatch,
  noteQuery,
  projectInput,
  projectPatch,
  projectQuery,
  taskInput,
  taskPatch,
  taskQuery,
} from "../schemas/workspace"
import { boardService } from "../services/board.service"
import { filterItems } from "../services/crud"
import { notesService } from "../services/notes.service"
import { projectsService } from "../services/projects.service"
import { tasksService } from "../services/tasks.service"
import { crudRoutes, pathId } from "./crud"

export const projectRoutes = crudRoutes(
  "/projects",
  {
    ...projectsService,
    list: async (userId: string, filters: { status?: string }) =>
      filterItems(await projectsService.list(userId), filters),
  },
  { input: projectInput, patch: projectPatch, query: projectQuery },
)

export const taskRoutes: Routes = {
  ...crudRoutes("/tasks", tasksService, { input: taskInput, patch: taskPatch, query: taskQuery }),
  "POST /tasks/{id}/toggle": async (ctx) =>
    ok(await tasksService.toggleComplete(ctx.userId, pathId(ctx))),
}

export const noteRoutes: Routes = crudRoutes(
  "/notes",
  {
    ...notesService,
    list: async (userId: string, query: { category?: string; favorite?: "true" | "false" }) =>
      filterItems(await notesService.list(userId), {
        category: query.category,
        favorite: query.favorite === undefined ? undefined : query.favorite === "true",
      }),
  },
  { input: noteInput, patch: notePatch, query: noteQuery },
)

export const boardRoutes: Routes = crudRoutes(
  "/board",
  {
    ...boardService,
    list: async (userId: string, query: { kind?: BoardItem["kind"]; pinned?: "true" | "false" }) =>
      filterItems(await boardService.list(userId), {
        kind: query.kind,
        pinned: query.pinned === undefined ? undefined : query.pinned === "true",
      }),
  },
  { input: boardItemInput, patch: boardItemPatch, query: boardQuery },
)
