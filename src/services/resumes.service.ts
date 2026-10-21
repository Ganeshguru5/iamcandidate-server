import { createId, nowIso } from "../lib/ids"
import { applyPatch, type Patch } from "../lib/validation"
import type { Resume } from "../models"
import { repositories } from "../repositories/dynamodb"
import type { ResumeInput } from "../schemas/documents"
import { activitiesService } from "./activities.service"
import { byDateDesc } from "./crud"

const repo = repositories.resumes

/** `v3.2` → `v3.3`; anything else is left alone. */
export function bumpVersion(version: string): string {
  const match = /^v(\d+)\.(\d+)$/.exec(version)
  if (!match) return version
  return `v${match[1]}.${Number(match[2]) + 1}`
}

/**
 * Resumes are structured documents (summary, experience, …) stored in
 * DynamoDB. An uploaded resume *file* lives in S3 as a Document and is linked
 * through `documentId`.
 */
export const resumesService = {
  async list(userId: string): Promise<Resume[]> {
    return (await repo.list(userId)).sort(byDateDesc("updatedAt"))
  },

  get(userId: string, id: string): Promise<Resume> {
    return repo.getOrThrow(userId, id)
  },

  create(userId: string, input: ResumeInput): Promise<Resume> {
    const now = nowIso()
    return repo.create(userId, { ...input, id: createId("res"), createdAt: now, updatedAt: now })
  },

  /** Every save bumps the minor version unless the client sets one. */
  async update(userId: string, id: string, patch: Patch<Partial<ResumeInput>>): Promise<Resume> {
    const existing = await repo.getOrThrow(userId, id)
    const next: Resume = {
      ...applyPatch(existing, patch),
      id,
      version: patch.version ?? bumpVersion(existing.version),
      updatedAt: nowIso(),
    }
    await repo.replace(userId, next)
    await activitiesService.record(userId, {
      type: "resume_updated",
      title: "Resume updated",
      description: `${next.title} → ${next.version}`,
      entity: { type: "resume", id },
    })
    return next
  },

  async duplicate(userId: string, id: string): Promise<Resume> {
    const existing = await repo.getOrThrow(userId, id)
    const now = nowIso()
    const { documentId: _documentId, ...rest } = existing
    return repo.create(userId, {
      ...rest,
      id: createId("res"),
      title: `${existing.title} (copy)`,
      version: "v1.0",
      isDefault: false,
      createdAt: now,
      updatedAt: now,
    })
  },

  /** Makes one resume the default and clears the flag on the others. */
  async setDefault(userId: string, id: string): Promise<Resume[]> {
    const all = await repo.list(userId)
    if (!all.some((resume) => resume.id === id)) await repo.getOrThrow(userId, id)
    const next = all.map((resume) => ({ ...resume, isDefault: resume.id === id }))
    const changed = next.filter((resume, index) => resume.isDefault !== all[index]?.isDefault)
    await repo.putMany(userId, changed)
    return next.sort(byDateDesc("updatedAt"))
  },

  async remove(userId: string, id: string): Promise<void> {
    await repo.delete(userId, id)
  },
}
