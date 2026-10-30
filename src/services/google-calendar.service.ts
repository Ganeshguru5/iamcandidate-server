import { createHash } from "node:crypto"

import { getConfig } from "../lib/config"
import { AppError, BadRequestError, ConflictError } from "../lib/errors"
import {
  authorizationUrl,
  CALENDAR_SCOPES,
  createState,
  deleteCalendarEvent,
  exchangeCode,
  fetchUserEmail,
  revokeToken,
  upsertCalendarEvent,
  verifyState,
  type CalendarEvent,
} from "../lib/google"
import { nowIso } from "../lib/ids"
import { decryptSecret, encryptSecret } from "../lib/secrets"
import type { CalendarSyncSummary, GoogleCalendarStatus, StoredGoogleCalendar } from "../models"
import { INTERVIEW_TYPE_LABELS } from "../models/labels"
import { repositories, settingsRepository } from "../repositories/dynamodb"
import { activitiesService } from "./activities.service"
import { withGoogle } from "./google-tokens"

const DAY = 24 * 60 * 60 * 1000
/** Keeps a sync inside API Gateway's 30-second limit. */
const MAX_EVENTS = 150
const CONCURRENCY = 5
const FOOTER = "Added by IamCandidate. Changes made here are overwritten on the next sync."

/**
 * Stable event id per IamCandidate item. Google allows base32hex characters
 * (0-9, a-v); a hex digest fits, so syncing again updates instead of duplicating.
 */
export function calendarEventId(userId: string, kind: string, id: string): string {
  return `knot${createHash("sha256").update(`${userId}:${kind}:${id}`).digest("hex").slice(0, 40)}`
}

/** `YYYY-MM-DD` of an instant in the user's time zone (`tzOffset` as from getTimezoneOffset). */
function localDate(iso: string, tzOffset: number): string {
  return new Date(new Date(iso).getTime() - tzOffset * 60_000).toISOString().slice(0, 10)
}

function allDay(iso: string, tzOffset: number): Pick<CalendarEvent, "start" | "end"> {
  const date = localDate(iso, tzOffset)
  const next = new Date(`${date}T00:00:00Z`)
  next.setUTCDate(next.getUTCDate() + 1)
  return { start: { date }, end: { date: next.toISOString().slice(0, 10) } }
}

const lines = (...parts: Array<string | undefined | false>) => parts.filter(Boolean).join("\n")

interface Planned {
  id: string
  kind: keyof Omit<CalendarSyncSummary, "synced" | "removed">
  sortKey: string
  event: CalendarEvent
}

/** Everything that should be on the calendar right now. */
async function planEvents(userId: string, tzOffset: number): Promise<Planned[]> {
  const [interviews, applications, contacts, referrals, tasks, companies] = await Promise.all([
    repositories.interviews.list(userId),
    repositories.applications.list(userId),
    repositories.contacts.list(userId),
    repositories.referrals.list(userId),
    repositories.tasks.list(userId),
    repositories.companies.list(userId),
  ])
  const company = (id?: string) => companies.find((c) => c.id === id)?.name ?? "Unknown company"
  const appById = new Map(applications.map((a) => [a.id, a]))
  const contactById = new Map(contacts.map((c) => [c.id, c]))

  const now = Date.now()
  const today = localDate(new Date(now).toISOString(), tzOffset)
  const upcoming = (iso?: string): iso is string => !!iso && localDate(iso, tzOffset) >= today
  const planned: Planned[] = []

  for (const interview of interviews) {
    if (interview.status !== "scheduled") continue
    const start = new Date(interview.scheduledAt).getTime()
    if (Number.isNaN(start) || start < now - DAY) continue
    const app = appById.get(interview.applicationId)
    const where = app ? `${app.role} at ${company(app.companyId)}` : "Interview"
    planned.push({
      id: calendarEventId(userId, "interview", interview.id),
      kind: "interviews",
      sortKey: interview.scheduledAt,
      event: {
        summary: `${INTERVIEW_TYPE_LABELS[interview.type]} interview — ${where}`,
        ...(interview.meetingUrl ? { location: interview.meetingUrl } : {}),
        description: lines(
          interview.interviewers.length > 0 && `Interviewers: ${interview.interviewers.join(", ")}`,
          interview.meetingUrl && `Join: ${interview.meetingUrl}`,
          interview.notes,
          "",
          FOOTER,
        ),
        start: { dateTime: new Date(start).toISOString() },
        end: { dateTime: new Date(start + interview.durationMinutes * 60_000).toISOString() },
      },
    })
  }

  for (const app of applications) {
    if (!upcoming(app.nextFollowUp) || app.status === "rejected") continue
    planned.push({
      id: calendarEventId(userId, "application", app.id),
      kind: "followUps",
      sortKey: app.nextFollowUp,
      event: {
        summary: `Follow up: ${app.role} at ${company(app.companyId)}`,
        description: lines(app.jobUrl, "", FOOTER),
        ...allDay(app.nextFollowUp, tzOffset),
      },
    })
  }

  for (const contact of contacts) {
    if (!upcoming(contact.nextFollowUp)) continue
    planned.push({
      id: calendarEventId(userId, "contact", contact.id),
      kind: "followUps",
      sortKey: contact.nextFollowUp,
      event: {
        summary: `Follow up with ${contact.name}`,
        description: lines(
          [contact.role, contact.companyId && company(contact.companyId)]
            .filter(Boolean)
            .join(" · "),
          contact.email,
          contact.linkedin,
          "",
          FOOTER,
        ),
        ...allDay(contact.nextFollowUp, tzOffset),
      },
    })
  }

  for (const referral of referrals) {
    const open = ["not_contacted", "request_sent", "no_response"].includes(referral.status)
    if (!open || !upcoming(referral.followUpDate)) continue
    const person = contactById.get(referral.contactId)?.name ?? "your contact"
    planned.push({
      id: calendarEventId(userId, "referral", referral.id),
      kind: "followUps",
      sortKey: referral.followUpDate,
      event: {
        summary: `Referral follow-up: ${person} — ${referral.role} at ${company(referral.companyId)}`,
        description: lines(referral.jobUrl, "", FOOTER),
        ...allDay(referral.followUpDate, tzOffset),
      },
    })
  }

  for (const task of tasks) {
    if (task.status === "done" || !upcoming(task.dueDate)) continue
    planned.push({
      id: calendarEventId(userId, "task", task.id),
      kind: "tasks",
      sortKey: task.dueDate,
      event: {
        summary: `Task: ${task.title}`,
        description: lines(task.description, "", FOOTER),
        ...allDay(task.dueDate, tzOffset),
      },
    })
  }

  return planned.sort((a, b) => a.sortKey.localeCompare(b.sortKey)).slice(0, MAX_EVENTS)
}

/** Runs `work` over `items` with limited parallelism; stops at the first error. */
async function eachLimited<T>(items: T[], limit: number, work: (item: T) => Promise<void>) {
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++] as T
      await work(item)
    }
  })
  await Promise.all(workers)
}

function toStatus(stored: StoredGoogleCalendar | undefined): GoogleCalendarStatus {
  return {
    available: Boolean(getConfig().google),
    connected: Boolean(stored),
    ...(stored
      ? {
          account: stored.email,
          connectedAt: stored.connectedAt,
          ...(stored.lastSyncedAt ? { lastSyncedAt: stored.lastSyncedAt } : {}),
          ...(stored.lastSync ? { lastSync: stored.lastSync } : {}),
        }
      : {}),
  }
}

export const googleCalendarService = {
  async status(userId: string): Promise<GoogleCalendarStatus> {
    return toStatus(await settingsRepository.get(userId, "GOOGLE_CALENDAR"))
  },

  authUrl(userId: string): { url: string } {
    return { url: authorizationUrl(createState(userId, "calendar"), CALENDAR_SCOPES) }
  },

  async connect(userId: string, code: string, state: string): Promise<GoogleCalendarStatus> {
    if (!verifyState(state, userId, "calendar")) {
      throw new BadRequestError(
        "This Google sign-in has expired or wasn't started here. Connect again.",
      )
    }
    const tokens = await exchangeCode(code, "calendar")
    if (!tokens.refreshToken) {
      throw new AppError(
        502,
        "INTEGRATION_ERROR",
        "Google didn't grant offline access. Remove IamCandidate from your Google account's third-party access and connect again.",
      )
    }
    if (!tokens.scope.includes("calendar")) {
      throw new BadRequestError(
        "Calendar access wasn't granted. Connect again and allow IamCandidate to manage calendar events.",
      )
    }
    const stored: StoredGoogleCalendar = {
      email: await fetchUserEmail(tokens.accessToken),
      encryptedRefreshToken: encryptSecret(tokens.refreshToken),
      encryptedAccessToken: encryptSecret(tokens.accessToken),
      accessTokenExpiresAt: tokens.expiresAt,
      scope: tokens.scope,
      connectedAt: nowIso(),
      syncedEventIds: [],
    }
    await settingsRepository.put(userId, "GOOGLE_CALENDAR", stored)
    await activitiesService.record(userId, {
      type: "integration_connected",
      title: "Google Calendar connected",
      description: stored.email,
      entity: { type: "integration", id: "google_calendar" },
    })
    return toStatus(stored)
  },

  /**
   * Revokes the grant and forgets it. With `removeEvents`, first deletes the
   * events IamCandidate created (best effort).
   */
  async disconnect(userId: string, removeEvents: boolean): Promise<GoogleCalendarStatus> {
    const stored = await settingsRepository.get(userId, "GOOGLE_CALENDAR")
    if (stored) {
      if (removeEvents && stored.syncedEventIds.length > 0) {
        try {
          await withGoogle(userId, "calendar", (token) =>
            eachLimited(stored.syncedEventIds, CONCURRENCY, (id) => deleteCalendarEvent(token, id)),
          )
        } catch {
          // The grant may already be gone; disconnect anyway.
        }
      }
      await revokeToken(decryptSecret(stored.encryptedRefreshToken))
      await settingsRepository.remove(userId, "GOOGLE_CALENDAR")
      await activitiesService.record(userId, {
        type: "integration_disconnected",
        title: "Google Calendar disconnected",
        entity: { type: "integration", id: "google_calendar" },
      })
    }
    return toStatus(undefined)
  },

  /**
   * Puts upcoming interviews, follow-ups and task due dates on the user's
   * primary calendar, and removes events for items that no longer qualify.
   */
  async sync(userId: string, tzOffset: number): Promise<GoogleCalendarStatus> {
    const stored = await settingsRepository.get(userId, "GOOGLE_CALENDAR")
    if (!stored) throw new ConflictError("Connect Google Calendar first.")
    const planned = await planEvents(userId, tzOffset)
    const wanted = new Set(planned.map((p) => p.id))
    const stale = stored.syncedEventIds.filter((id) => !wanted.has(id))

    const synced = new Set<string>()
    const removed = new Set<string>()
    const save = async () => {
      // Keep tracking anything not confirmed removed, so a later sync can clean it up.
      const ids = new Set([...stored.syncedEventIds.filter((id) => !removed.has(id)), ...synced])
      const latest = await settingsRepository.get(userId, "GOOGLE_CALENDAR")
      if (!latest) return undefined
      const summary: CalendarSyncSummary = {
        synced: synced.size,
        removed: removed.size,
        interviews: planned.filter((p) => p.kind === "interviews").length,
        followUps: planned.filter((p) => p.kind === "followUps").length,
        tasks: planned.filter((p) => p.kind === "tasks").length,
      }
      const next: StoredGoogleCalendar = {
        ...latest,
        syncedEventIds: [...ids],
        lastSyncedAt: nowIso(),
        lastSync: summary,
      }
      await settingsRepository.put(userId, "GOOGLE_CALENDAR", next)
      return next
    }

    try {
      await withGoogle(userId, "calendar", async (token) => {
        await eachLimited(planned, CONCURRENCY, async (p) => {
          await upsertCalendarEvent(token, p.id, p.event)
          synced.add(p.id)
        })
        await eachLimited(stale, CONCURRENCY, async (id) => {
          await deleteCalendarEvent(token, id)
          removed.add(id)
        })
      })
    } catch (error) {
      if (synced.size > 0 || removed.size > 0) await save().catch(() => undefined)
      throw error
    }

    const next = await save()
    await activitiesService.record(userId, {
      type: "integration_synced",
      title: "Google Calendar synced",
      description: `${synced.size} event${synced.size === 1 ? "" : "s"} up to date${removed.size ? `, ${removed.size} removed` : ""}`,
      entity: { type: "integration", id: "google_calendar" },
    })
    return toStatus(next)
  },
}
