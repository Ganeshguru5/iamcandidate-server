import {
  DEFAULT_TEMPLATES,
  DEFAULT_TEMPLATES_VERSION,
  type DefaultTemplate,
} from "../lib/default-templates"
import { ConflictError } from "../lib/errors"
import { createId, nowIso } from "../lib/ids"
import { logger, serializeError } from "../lib/logger"
import type { EmailTemplate } from "../models"
import { repositories, settingsRepository } from "../repositories/dynamodb"
import type { TemplateInput } from "../schemas/communication"
import { byDateDesc, createCrudService } from "./crud"

const repo = repositories.templates

const crud = createCrudService<EmailTemplate, TemplateInput>(repo, {
  idPrefix: "tpl",
  build: (input, id, now) => ({
    ...input,
    channel: input.channel ?? "email",
    id,
    usageCount: 0,
    createdAt: now,
    updatedAt: now,
  }),
  touch: (now) => ({ updatedAt: now }),
  sort: byDateDesc("updatedAt"),
})

/** Same channel and name (case-insensitive); templates from before channels are email. */
const nameKey = (t: Pick<EmailTemplate, "channel" | "name">) =>
  `${t.channel ?? "email"}:${t.name.trim().toLowerCase()}`

/**
 * Adds the default templates the account doesn't have yet, matching by id and
 * by channel + name so renamed or hand-made copies aren't doubled. Returns
 * how many were added.
 */
async function addMissingDefaults(
  userId: string,
  existing: EmailTemplate[],
  defaults: DefaultTemplate[] = DEFAULT_TEMPLATES,
): Promise<number> {
  const ids = new Set(existing.map((t) => t.id))
  const names = new Set(existing.map(nameKey))
  const now = nowIso()
  let added = 0
  for (const { since: _since, ...template } of defaults) {
    if (ids.has(template.id) || names.has(nameKey(template))) continue
    try {
      // Conditional create: a parallel request seeding the same id just loses the race.
      await repo.create(userId, { ...template, usageCount: 0, createdAt: now, updatedAt: now })
      added++
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error
    }
  }
  return added
}

export const templatesService = {
  ...crud,

  /**
   * Lists templates, first giving the account any default templates it
   * hasn't received yet. This seeds accounts created before defaults existed;
   * a default the user deleted is not brought back (use `restoreDefaults`).
   */
  async list(userId: string): Promise<EmailTemplate[]> {
    try {
      await this.ensureDefaults(userId)
    } catch (error) {
      // Seeding is a convenience; listing must still work.
      logger.error("Failed to seed default templates", { error: serializeError(error) })
    }
    return crud.list(userId)
  },

  /**
   * Seeds the defaults the account hasn't been offered yet: all of them for a
   * new account, only those added in later versions for an existing one.
   */
  async ensureDefaults(userId: string): Promise<void> {
    const marker = await settingsRepository.get(userId, "TEMPLATE_DEFAULTS")
    const seen = marker?.version ?? 0
    if (seen >= DEFAULT_TEMPLATES_VERSION) return
    await addMissingDefaults(
      userId,
      await repo.list(userId),
      DEFAULT_TEMPLATES.filter((t) => t.since > seen),
    )
    await settingsRepository.put(userId, "TEMPLATE_DEFAULTS", {
      version: DEFAULT_TEMPLATES_VERSION,
      seededAt: nowIso(),
    })
  },

  /** Brings back any default templates that were deleted. Returns the full list. */
  async restoreDefaults(userId: string): Promise<{ added: number; templates: EmailTemplate[] }> {
    const added = await addMissingDefaults(userId, await repo.list(userId))
    await settingsRepository.put(userId, "TEMPLATE_DEFAULTS", {
      version: DEFAULT_TEMPLATES_VERSION,
      seededAt: nowIso(),
    })
    return { added, templates: await crud.list(userId) }
  },

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
