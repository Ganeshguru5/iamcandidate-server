import { createId, nowIso } from "../lib/ids"
import { applyPatch, type Patch } from "../lib/validation"
import type { Task } from "../models"
import { repositories } from "../repositories/dynamodb"
import type { TaskInput } from "../schemas/workspace"
import { activitiesService } from "./activities.service"
import { byDateDesc } from "./crud"

const repo = repositories.tasks

async function recordCompleted(userId: string, task: Task) {
  await activitiesService.record(userId, {
    type: "task_completed",
    title: "Task completed",
    description: task.title,
    entity: { type: "task", id: task.id },
  })
}

export const tasksService = {
  async list(
    userId: string,
    filters: {
      status?: Task["status"]
      priority?: Task["priority"]
      relatedType?: string
      relatedId?: string
    },
  ): Promise<Task[]> {
    const items = await repo.list(userId)
    return items
      .filter((task) => !filters.status || task.status === filters.status)
      .filter((task) => !filters.priority || task.priority === filters.priority)
      .filter((task) => !filters.relatedType || task.related?.type === filters.relatedType)
      .filter((task) => !filters.relatedId || task.related?.id === filters.relatedId)
      .sort(byDateDesc("createdAt"))
  },

  get(userId: string, id: string): Promise<Task> {
    return repo.getOrThrow(userId, id)
  },

  async create(userId: string, input: TaskInput): Promise<Task> {
    const now = nowIso()
    const task: Task = {
      ...input,
      id: createId("tsk"),
      createdAt: now,
      ...(input.status === "done" ? { completedAt: now } : {}),
    }
    await repo.create(userId, task)
    await activitiesService.record(userId, {
      type: "task_created",
      title: "Task created",
      description: task.title,
      entity: { type: "task", id: task.id },
    })
    return task
  },

  /** `completedAt` follows `status`: set when it becomes done, cleared otherwise. */
  async update(userId: string, id: string, patch: Patch<Partial<TaskInput>>): Promise<Task> {
    const existing = await repo.getOrThrow(userId, id)
    const next: Task = { ...applyPatch(existing, patch), id }
    if (patch.status === "done") next.completedAt = existing.completedAt ?? nowIso()
    else if (patch.status) delete next.completedAt
    await repo.replace(userId, next)
    if (patch.status === "done" && existing.status !== "done") await recordCompleted(userId, next)
    return next
  },

  async toggleComplete(userId: string, id: string): Promise<Task> {
    const existing = await repo.getOrThrow(userId, id)
    const done = existing.status !== "done"
    const { completedAt: _completedAt, ...rest } = existing
    const next: Task = done
      ? { ...rest, status: "done", completedAt: nowIso() }
      : { ...rest, status: "todo" }
    await repo.replace(userId, next)
    if (done) await recordCompleted(userId, next)
    return next
  },

  async remove(userId: string, id: string): Promise<void> {
    await repo.delete(userId, id)
  },
}
