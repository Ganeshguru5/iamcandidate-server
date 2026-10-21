import { describe, expect, it } from "vitest"

import { handler } from "../../src/functions/dashboard"
import { LocalClock } from "../../src/lib/time"
import type { Activity, Application, DocumentFile, Interview, Task } from "../../src/models"
import { activityRepository, repositories } from "../../src/repositories/dynamodb"
import { buildDashboard, type DashboardSummary } from "../../src/services/dashboard.service"
import { call } from "../support/http"

// Wednesday 2026-10-21 12:00 IST (06:30Z); IST offset = -330.
const NOW = Date.parse("2026-10-21T06:30:00.000Z")
const IST = -330
const clock = new LocalClock(NOW, IST)
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString()

function app(
  id: string,
  status: Application["status"],
  appliedDaysAgo?: number,
  timeline: string[] = [],
): Application {
  return {
    id,
    companyId: "cmp",
    role: "Engineer",
    location: "",
    workMode: "remote",
    status,
    priority: "medium",
    ...(appliedDaysAgo === undefined ? {} : { appliedDate: daysAgo(appliedDaysAgo) }),
    notes: "",
    timeline: timeline.map((title, i) => ({
      id: `e${i}`,
      date: daysAgo(1),
      title,
      type: "status",
    })),
    createdAt: daysAgo(30),
    updatedAt: daysAgo(1),
  }
}

const interview = (
  id: string,
  applicationId: string,
  scheduledAt: string,
  status: Interview["status"] = "scheduled",
): Interview => ({
  id,
  applicationId,
  type: "technical",
  scheduledAt,
  durationMinutes: 60,
  interviewers: [],
  status,
  notes: "",
  createdAt: daysAgo(5),
})

const task = (id: string, status: Task["status"], dueDate?: string): Task => ({
  id,
  title: id,
  description: "",
  priority: "medium",
  status,
  ...(dueDate ? { dueDate } : {}),
  createdAt: daysAgo(3),
})

const doc = (id: string, category: DocumentFile["category"], starred: boolean): DocumentFile => ({
  id,
  name: id,
  category,
  kind: "pdf",
  sizeBytes: 1,
  starred,
  source: "local",
  uploadedAt: daysAgo(2),
  updatedAt: daysAgo(2),
})

const fixture = {
  applications: [
    app("a1", "wishlist"),
    app("a2", "applied", 2),
    app("a3", "recruiter", 10),
    app("a4", "technical", 20),
    app("a5", "offer", 40),
    app("a6", "rejected", 15, ["Recruiter contacted"]),
    app("a7", "rejected", 16),
  ],
  interviews: [
    interview("i1", "a4", new Date(NOW + 2 * 3_600_000).toISOString()),
    interview("i2", "a3", new Date(NOW + 3 * 86_400_000).toISOString()),
    interview("i3", "a2", daysAgo(1), "completed"),
  ],
  tasks: [
    task("t1", "todo", "2026-10-21T15:00:00.000Z"), // due today (IST)
    task("t2", "in_progress", daysAgo(2)), // overdue
    task("t3", "done", daysAgo(2)),
    task("t4", "todo"),
  ],
  documents: [doc("d1", "resume", true), doc("d2", "resume", false), doc("d3", "other", true)],
  recentActivity: [] as Activity[],
}

describe("buildDashboard", () => {
  const summary = buildDashboard(fixture, clock)

  it("counts applications", () => {
    expect(summary.applications).toMatchObject({
      total: 7,
      active: 4,
      appliedThisWeek: 1,
      awaitingReply: 1,
    })
    expect(summary.applications.byStatus).toEqual([
      { status: "wishlist", count: 1 },
      { status: "applied", count: 1 },
      { status: "recruiter", count: 1 },
      { status: "technical", count: 1 },
      { status: "hr", count: 0 },
      { status: "offer", count: 1 },
      { status: "rejected", count: 2 },
    ])
  })

  it("buckets submissions into 10 local (Monday-based) weeks", () => {
    const { overTime } = summary.applications
    expect(overTime).toHaveLength(10)
    expect(overTime.at(-1)).toEqual({ weekStart: "2026-10-19", applications: 1 })
    expect(overTime[0]?.weekStart).toBe("2026-08-17")
    // a5 was applied 40 days ago → 6 weeks back.
    expect(overTime.reduce((sum, p) => sum + p.applications, 0)).toBe(6)
  })

  it("computes the conversion funnel", () => {
    // submitted: a2..a7 (6); responded: a3,a4,a5 + a6 (reached recruiter) = 4;
    // interviewed: a4,a5 (stage) + a3,a2 (have interviews) = 4; offers: 1
    expect(summary.applications.funnel.stages.map((s) => s.count)).toEqual([6, 4, 4, 1])
    expect(summary.applications.funnel.responseRate).toBeCloseTo(4 / 6)
    expect(summary.applications.funnel.offerRate).toBeCloseTo(1 / 4)
  })

  it("summarizes interviews, tasks and documents", () => {
    expect(summary.interviews.upcoming).toBe(2)
    expect(summary.interviews.next?.id).toBe("i1")
    expect(summary.tasks).toEqual({ open: 3, dueToday: 1, overdue: 1 })
    expect(summary.documents).toEqual({ total: 3, resumes: 2, starred: 2 })
  })
})

describe("GET /dashboard", () => {
  it("aggregates the user's data in one response", async () => {
    await repositories.applications.putMany("usr_test", fixture.applications)
    await repositories.interviews.putMany("usr_test", fixture.interviews)
    await repositories.tasks.putMany("usr_test", fixture.tasks)
    await repositories.documents.putMany("usr_test", [
      { ...fixture.documents[0]!, s3Key: "users/usr_test/documents/x/y" },
    ])
    await activityRepository.add("usr_test", { type: "note_created", title: "Note created" })

    const res = await call<DashboardSummary>(handler, "GET", "/dashboard", {
      query: { tzOffset: "-330" },
    })
    expect(res.status).toBe(200)
    const data = res.body.data as DashboardSummary
    expect(data.applications.total).toBe(7)
    expect(data.documents.total).toBe(1)
    expect(data.recentActivity.map((a) => a.title)).toEqual(["Note created"])
    expect(JSON.stringify(data)).not.toContain("s3Key")
  })

  it("validates tzOffset", async () => {
    const res = await call(handler, "GET", "/dashboard", { query: { tzOffset: "9999" } })
    expect(res.status).toBe(400)
  })
})
