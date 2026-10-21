import { createId, nowIso } from "../lib/ids"
import { logger, serializeError } from "../lib/logger"
import type { EmailTemplate } from "../models"
import { repositories } from "../repositories/dynamodb"
import type { TemplateInput } from "../schemas/communication"
import { byDateDesc, createCrudService } from "./crud"

const repo = repositories.templates

const crud = createCrudService<EmailTemplate, TemplateInput>(repo, {
  idPrefix: "tpl",
  build: (input, id, now) => ({ ...input, id, usageCount: 0, createdAt: now, updatedAt: now }),
  touch: (now) => ({ updatedAt: now }),
  sort: byDateDesc("updatedAt"),
})

export const templatesService = {
  ...crud,

  async duplicate(userId: string, id: string): Promise<EmailTemplate> {
    const existing = await repo.getOrThrow(userId, id)
    const now = nowIso()
    return repo.create(userId, {
      ...existing,
      id: createId("tpl"),
      name: `${existing.name} (copy)`,
      usageCount: 0,
      createdAt: now,
      updatedAt: now,
    })
  },

  /** Best-effort counter; a failure never fails the send. */
  async recordUse(userId: string, id: string): Promise<void> {
    try {
      const template = await repo.get(userId, id)
      if (template) await repo.replace(userId, { ...template, usageCount: template.usageCount + 1 })
    } catch (error) {
      logger.error("Failed to update template usage", { error: serializeError(error) })
    }
  },
}
