import { DAY_MS, LocalClock } from "../lib/time"
import {
  APPLICATION_STATUSES,
  type Activity,
  type Application,
  type ApplicationStatus,
  type DocumentFile,
  type Interview,
  type Task,
} from "../models"
import { activityRepository, repositories } from "../repositories/dynamodb"

/** Statuses that count as "the company responded" / "reached interviews". */
const RESPONDED: ApplicationStatus[] = ["recruiter", "technical", "hr", "offer"]
const INTERVIEW_STAGE: ApplicationStatus[] = ["technical", "hr", "offer"]
const CHART_WEEKS = 10
const RECENT_ACTIVITY = 7

export interface DashboardSummary {
  applications: {
    total: number
    /** Not wishlist / rejected. */
    active: number
    appliedThisWeek: number
    awaitingReply: number
    byStatus: Array<{ status: ApplicationStatus; count: number }>
    /** Oldest → newest; `weekStart` is the local Monday as `YYYY-MM-DD`. */
    overTime: Array<{ weekStart: string; applications: number }>
    funnel: {
      stages: Array<{ label: string; count: number }>
      responseRate: number
      interviewRate: number
      offerRate: number
    }
  }
  interviews: {
    upcoming: number
    next?: Pick<Interview, "id" | "applicationId" | "type" | "scheduledAt">
  }
  tasks: { open: number; dueToday: number; overdue: number }
  documents: { total: number; resumes: number; starred: number }
  recentActivity: Activity[]
}

export interface DashboardInput {
  applications: Application[]
  interviews: Interview[]
  tasks: Task[]
  documents: DocumentFile[]
  recentActivity: Activity[]
}

function overTime(apps: Application[], clock: LocalClock) {
  const current = clock.startOfWeek(clock.now)
  const points = Array.from({ length: CHART_WEEKS }, (_, i) => ({
    weekStart: clock.dateKey(current - (CHART_WEEKS - 1 - i) * 7 * DAY_MS),
    applications: 0,
  }))
  for (const app of apps) {
    if (!app.appliedDate) continue
    const weeksAgo = Math.round(
      (current - clock.startOfWeek(Date.parse(app.appliedDate))) / (7 * DAY_MS),
    )
    const point = points[CHART_WEEKS - 1 - weeksAgo]
    if (point) point.applications++
  }
  return points
}

function funnel(apps: Application[], interviews: Interview[]) {
  const submitted = apps.filter((a) => a.status !== "wishlist")
  const interviewedIds = new Set(interviews.map((i) => i.applicationId))
  const reachedRecruiter = (a: Application) => a.timeline.some((e) => /recruiter/i.test(e.title))
  const responded = submitted.filter(
    (a) => RESPONDED.includes(a.status) || (a.status === "rejected" && reachedRecruiter(a)),
  )
  const interviewed = submitted.filter(
    (a) => INTERVIEW_STAGE.includes(a.status) || interviewedIds.has(a.id),
  )
  const offers = submitted.filter((a) => a.status === "offer")
  return {
    stages: [
      { label: "Applied", count: submitted.length },
      { label: "Responded", count: responded.length },
      { label: "Interviewed", count: interviewed.length },
      { label: "Offer", count: offers.length },
    ],
    responseRate: submitted.length ? responded.length / submitted.length : 0,
    interviewRate: submitted.length ? interviewed.length / submitted.length : 0,
    offerRate: interviewed.length ? offers.length / interviewed.length : 0,
  }
}

/** Pure aggregation, exported for unit tests. */
export function buildDashboard(input: DashboardInput, clock: LocalClock): DashboardSummary {
  const { applications, interviews, tasks, documents } = input
  const upcoming = interviews
    .filter((i) => i.status === "scheduled" && Date.parse(i.scheduledAt) >= clock.now)
    .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt))
  const next = upcoming[0]
  const openTasks = tasks.filter((t) => t.status !== "done")

  return {
    applications: {
      total: applications.length,
      active: applications.filter((a) => a.status !== "wishlist" && a.status !== "rejected").length,
      appliedThisWeek: applications.filter(
        (a) => a.appliedDate && Date.parse(a.appliedDate) > clock.now - 7 * DAY_MS,
      ).length,
      awaitingReply: applications.filter((a) => a.status === "applied").length,
      byStatus: APPLICATION_STATUSES.map((status) => ({
        status,
        count: applications.filter((a) => a.status === status).length,
      })),
      overTime: overTime(applications, clock),
      funnel: funnel(applications, interviews),
    },
    interviews: {
      upcoming: upcoming.length,
      ...(next
        ? {
            next: {
              id: next.id,
              applicationId: next.applicationId,
              type: next.type,
              scheduledAt: next.scheduledAt,
            },
          }
        : {}),
    },
    tasks: {
      open: openTasks.length,
      dueToday: openTasks.filter((t) => clock.isToday(t.dueDate)).length,
      overdue: openTasks.filter((t) => clock.isOverdue(t.dueDate)).length,
    },
    documents: {
      total: documents.length,
      resumes: documents.filter((d) => d.category === "resume").length,
      starred: documents.filter((d) => d.starred).length,
    },
    recentActivity: input.recentActivity,
  }
}

export const dashboardService = {
  /** One round trip for the dashboard: five parallel partition queries. */
  async getSummary(userId: string, tzOffset: number): Promise<DashboardSummary> {
    const [applications, interviews, tasks, documents, activity] = await Promise.all([
      repositories.applications.list(userId),
      repositories.interviews.list(userId),
      repositories.tasks.list(userId),
      repositories.documents.list(userId),
      activityRepository.list(userId, { limit: RECENT_ACTIVITY }),
    ])
    const docs = documents.map(({ s3Key: _s3Key, ...doc }) => doc)
    return buildDashboard(
      { applications, interviews, tasks, documents: docs, recentActivity: activity.items },
      new LocalClock(Date.now(), tzOffset),
    )
  },
}
