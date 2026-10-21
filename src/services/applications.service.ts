import { createId, nowIso } from "../lib/ids"
import { applyPatch, type Patch } from "../lib/validation"
import type { Application, ApplicationStatus, TimelineEvent } from "../models"
import { APPLICATION_STATUS_LABELS } from "../models/labels"
import { repositories } from "../repositories/dynamodb"
import type { ApplicationInput } from "../schemas/career"
import { activitiesService } from "./activities.service"
import { byDateDesc, filterItems } from "./crud"

const repo = repositories.applications

export function timelineEvent(
  title: string,
  type: TimelineEvent["type"],
  description?: string,
): TimelineEvent {
  return {
    id: createId("evt"),
    date: nowIso(),
    title,
    type,
    ...(description ? { description } : {}),
  }
}

export async function companyName(userId: string, companyId: string | undefined): Promise<string> {
  if (!companyId) return "Unknown company"
  const company = await repositories.companies.get(userId, companyId)
  return company?.name ?? "Unknown company"
}

export const applicationsService = {
  async list(
    userId: string,
    filters: { status?: ApplicationStatus; priority?: Application["priority"]; companyId?: string },
  ): Promise<Application[]> {
    const items = await repo.list(userId)
    return filterItems(items, filters).sort(byDateDesc("createdAt"))
  },

  get(userId: string, id: string): Promise<Application> {
    return repo.getOrThrow(userId, id)
  },

  async create(userId: string, input: ApplicationInput): Promise<Application> {
    const now = nowIso()
    const timeline = [timelineEvent("Application created", "created")]
    if (input.status !== "wishlist") {
      timeline.push(
        timelineEvent(`Status set to ${APPLICATION_STATUS_LABELS[input.status]}`, "status"),
      )
    }
    const application: Application = {
      ...input,
      id: createId("app"),
      ...(input.appliedDate || input.status === "wishlist" ? {} : { appliedDate: now }),
      timeline,
      createdAt: now,
      updatedAt: now,
    }
    await repo.create(userId, application)
    const company = await companyName(userId, application.companyId)
    await activitiesService.record(userId, {
      type: "application_created",
      title: `${input.status === "wishlist" ? "Saved" : "Applied to"} ${company} — ${application.role}`,
      entity: { type: "application", id: application.id },
    })
    return application
  },

  async update(
    userId: string,
    id: string,
    patch: Patch<Partial<ApplicationInput>>,
  ): Promise<Application> {
    const existing = await repo.getOrThrow(userId, id)
    const timeline = [...existing.timeline]
    const statusChanged = patch.status && patch.status !== existing.status
    if (patch.status && statusChanged) {
      timeline.push(timelineEvent(`Moved to ${APPLICATION_STATUS_LABELS[patch.status]}`, "status"))
    }
    if (patch.nextFollowUp && patch.nextFollowUp !== existing.nextFollowUp) {
      timeline.push(timelineEvent("Follow-up scheduled", "followup", patch.nextFollowUp))
    }
    const next: Application = {
      ...applyPatch(existing, patch),
      id,
      timeline,
      updatedAt: nowIso(),
    }
    await repo.replace(userId, next)
    if (patch.status && statusChanged) await this.recordStatusChange(userId, next, patch.status)
    return next
  },

  async changeStatus(userId: string, id: string, status: ApplicationStatus): Promise<Application> {
    const existing = await repo.getOrThrow(userId, id)
    if (existing.status === status) return existing
    const next: Application = {
      ...existing,
      status,
      ...(existing.appliedDate || status === "wishlist" ? {} : { appliedDate: nowIso() }),
      timeline: [
        ...existing.timeline,
        timelineEvent(`Moved to ${APPLICATION_STATUS_LABELS[status]}`, "status"),
      ],
      updatedAt: nowIso(),
    }
    await repo.replace(userId, next)
    await this.recordStatusChange(userId, next, status)
    return next
  },

  async recordStatusChange(userId: string, application: Application, status: ApplicationStatus) {
    const company = await companyName(userId, application.companyId)
    await activitiesService.record(userId, {
      type: "application_status_changed",
      title: `${company} moved to ${APPLICATION_STATUS_LABELS[status]}`,
      description: application.role,
      entity: { type: "application", id: application.id },
    })
  },

  async addTimelineEvent(
    userId: string,
    id: string,
    entry: Omit<TimelineEvent, "id">,
  ): Promise<Application> {
    const existing = await repo.getOrThrow(userId, id)
    const next: Application = {
      ...existing,
      timeline: [...existing.timeline, { ...entry, id: createId("evt") }],
      updatedAt: nowIso(),
    }
    return repo.replace(userId, next)
  },

  async remove(userId: string, id: string): Promise<void> {
    const removed = await repo.delete(userId, id)
    const company = await companyName(userId, removed.companyId)
    await activitiesService.record(userId, {
      type: "application_deleted",
      title: `Removed ${company} — ${removed.role}`,
    })
  },
}
