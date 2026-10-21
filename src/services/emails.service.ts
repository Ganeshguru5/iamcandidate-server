import { NotFoundError } from "../lib/errors"
import { createId, nowIso } from "../lib/ids"
import { logger, serializeError } from "../lib/logger"
import type { Email } from "../models"
import { repositories } from "../repositories/dynamodb"
import type { ComposeEmailInput } from "../schemas/communication"
import { activitiesService } from "./activities.service"
import { timelineEvent } from "./applications.service"
import { byDateDesc, filterItems } from "./crud"
import { smtpService } from "./smtp.service"
import { templatesService } from "./templates.service"

const repo = repositories.emails

/** Optional fields from the compose form, without undefined keys. */
function links(input: ComposeEmailInput) {
  return {
    ...(input.applicationId ? { applicationId: input.applicationId } : {}),
    ...(input.contactId ? { contactId: input.contactId } : {}),
    ...(input.templateId ? { templateId: input.templateId } : {}),
  }
}

/**
 * Records everything the app tracks about a sent email. Best-effort: the email
 * is already delivered, so a failure here is logged rather than reported.
 */
async function track(userId: string, email: Email) {
  try {
    const contacts = await repositories.contacts.list(userId)
    const recipient = contacts.find((c) => c.email.toLowerCase() === email.to[0])
    const contact = email.contactId ? contacts.find((c) => c.id === email.contactId) : recipient
    if (contact) {
      await repositories.contacts.replace(userId, { ...contact, lastContacted: email.date })
    }
    if (email.applicationId) {
      const application = await repositories.applications.get(userId, email.applicationId)
      if (application) {
        await repositories.applications.replace(userId, {
          ...application,
          timeline: [
            ...application.timeline,
            timelineEvent(
              `Email sent: ${email.subject || "(no subject)"}`,
              "email",
              `To ${email.to.join(", ")}`,
            ),
          ],
          updatedAt: nowIso(),
        })
      }
    }
    if (email.templateId) await templatesService.recordUse(userId, email.templateId)
    await activitiesService.record(userId, {
      type: "email_sent",
      title: `Email sent to ${recipient?.name ?? email.to[0]}`,
      description: email.subject,
      entity: { type: "email", id: email.id },
    })
  } catch (error) {
    logger.error("Failed to record email side effects", { error: serializeError(error) })
  }
}

export const emailsService = {
  async list(
    userId: string,
    filters: { folder?: Email["folder"]; applicationId?: string; contactId?: string },
  ): Promise<Email[]> {
    return filterItems(await repo.list(userId), filters).sort(byDateDesc("date"))
  },

  get(userId: string, id: string): Promise<Email> {
    return repo.getOrThrow(userId, id)
  },

  /** Sends through the user's SMTP account, then stores it in "sent". */
  async send(userId: string, input: ComposeEmailInput): Promise<Email> {
    const { from, messageId } = await smtpService.send(userId, {
      to: input.to,
      cc: input.cc,
      subject: input.subject,
      text: input.body,
    })
    const email: Email = {
      id: createId("em"),
      folder: "sent",
      from,
      to: input.to,
      cc: input.cc,
      subject: input.subject,
      body: input.body,
      date: nowIso(),
      read: true,
      starred: false,
      messageId,
      ...links(input),
    }
    await repo.create(userId, email)
    await track(userId, email)
    return email
  },

  /** Creates a draft, or updates `draftId` if it is still a draft. */
  async saveDraft(userId: string, input: ComposeEmailInput, draftId?: string): Promise<Email> {
    const existing = draftId ? await repo.get(userId, draftId) : undefined
    if (draftId && existing?.folder !== "drafts") throw new NotFoundError("Draft", draftId)
    const draft: Email = {
      id: existing?.id ?? createId("em"),
      folder: "drafts",
      from: await smtpService.sender(userId),
      to: input.to,
      cc: input.cc,
      subject: input.subject,
      body: input.body,
      date: nowIso(),
      read: true,
      starred: existing?.starred ?? false,
      ...links(input),
    }
    return existing ? repo.replace(userId, draft) : repo.create(userId, draft)
  },

  async update(userId: string, id: string, patch: { read?: boolean; starred?: boolean }) {
    const existing = await repo.getOrThrow(userId, id)
    return repo.replace(userId, { ...existing, ...patch })
  },

  async remove(userId: string, id: string): Promise<void> {
    await repo.delete(userId, id)
  },
}
