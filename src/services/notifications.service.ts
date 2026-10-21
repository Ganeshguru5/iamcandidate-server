import { LocalClock } from "../lib/time"
import type { AppNotification } from "../models"
import { INTERVIEW_TYPE_LABELS } from "../models/labels"
import { notificationReadRepository, repositories } from "../repositories/dynamodb"
import { settingsService } from "./settings.service"

/**
 * Notifications are reminders derived on read from interviews, follow-ups and
 * tasks — nothing is pushed or emailed. Only the per-user "read" markers are
 * stored. Mirrors the frontend's original `useNotices` rules.
 */
async function derive(userId: string, clock: LocalClock): Promise<AppNotification[]> {
  const [interviews, applications, tasks, companies, prefs, readIds] = await Promise.all([
    repositories.interviews.list(userId),
    repositories.applications.list(userId),
    repositories.tasks.list(userId),
    repositories.companies.list(userId),
    settingsService.getNotificationPreferences(userId),
    notificationReadRepository.listReadIds(userId),
  ])
  const companyName = new Map(companies.map((company) => [company.id, company.name]))
  const applicationById = new Map(applications.map((app) => [app.id, app]))
  const notices: Array<Omit<AppNotification, "read">> = []

  if (prefs.interviewReminders) {
    for (const interview of interviews) {
      if (interview.status !== "scheduled" || !clock.isWithinDays(interview.scheduledAt, 3))
        continue
      const app = applicationById.get(interview.applicationId)
      notices.push({
        id: `int-${interview.id}`,
        kind: "interview",
        title: `${INTERVIEW_TYPE_LABELS[interview.type]} · ${app ? (companyName.get(app.companyId) ?? "") : ""}`,
        date: interview.scheduledAt,
        href: "/career/interviews",
        urgent: clock.isToday(interview.scheduledAt),
      })
    }
  }

  if (prefs.followUpReminders) {
    for (const app of applications) {
      if (!app.nextFollowUp || app.status === "rejected") continue
      if (!clock.isToday(app.nextFollowUp) && !clock.isOverdue(app.nextFollowUp)) continue
      notices.push({
        id: `fu-${app.id}`,
        kind: "follow_up",
        title: `Follow up with ${companyName.get(app.companyId) ?? "company"}`,
        subtitle: app.role,
        date: app.nextFollowUp,
        href: `/career/applications/${app.id}`,
        urgent: clock.isOverdue(app.nextFollowUp),
      })
    }
  }

  if (prefs.taskReminders) {
    for (const task of tasks) {
      if (task.status === "done" || !task.dueDate) continue
      if (!clock.isOverdue(task.dueDate) && !clock.isToday(task.dueDate)) continue
      notices.push({
        id: `task-${task.id}`,
        kind: "task",
        title: task.title,
        date: task.dueDate,
        href: "/workspace/tasks",
        urgent: clock.isOverdue(task.dueDate),
      })
    }
  }

  return notices.map((notice) => ({ ...notice, read: readIds.has(notice.id) }))
}

export const notificationsService = {
  list(userId: string, tzOffset: number): Promise<AppNotification[]> {
    return derive(userId, new LocalClock(Date.now(), tzOffset))
  },

  async markRead(userId: string, id: string): Promise<void> {
    await notificationReadRepository.markRead(userId, [id])
  },

  /** Marks every current reminder read and returns the updated list. */
  async markAllRead(userId: string, tzOffset: number): Promise<AppNotification[]> {
    const notices = await this.list(userId, tzOffset)
    const unread = notices.filter((notice) => !notice.read).map((notice) => notice.id)
    if (unread.length > 0) await notificationReadRepository.markRead(userId, unread)
    return notices.map((notice) => ({ ...notice, read: true }))
  },
}
