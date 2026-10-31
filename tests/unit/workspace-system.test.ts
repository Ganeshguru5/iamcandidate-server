import { describe, expect, it } from "vitest"

import { handler as system } from "../../src/functions/system"
import { handler as workspace } from "../../src/functions/workspace"
import type { Activity, AppNotification, Board, Task } from "../../src/models"
import { repositories, settingsRepository } from "../../src/repositories/dynamodb"
import { call } from "../support/http"

describe("tasks", () => {
  const body = { title: "Prep system design", description: "", priority: "high", status: "todo" }

  it("toggles completion and records task_completed", async () => {
    const created = (await call<Task>(workspace, "POST", "/tasks", { body })).body.data as Task
    const done = await call<Task>(workspace, "POST", `/tasks/${created.id}/toggle`)
    expect(done.body.data).toMatchObject({ status: "done" })
    expect(done.body.data?.completedAt).toBeDefined()

    const undone = await call<Task>(workspace, "POST", `/tasks/${created.id}/toggle`)
    expect(undone.body.data?.status).toBe("todo")
    expect(undone.body.data?.completedAt).toBeUndefined()

    const feed = await call<Activity[]>(system, "GET", "/activities")
    expect(feed.body.data?.map((a) => a.type)).toEqual(["task_completed", "task_created"])
    expect(feed.body.meta).toEqual({ nextCursor: null })
  })

  it("filters by status", async () => {
    await call(workspace, "POST", "/tasks", { body })
    await call(workspace, "POST", "/tasks", { body: { ...body, status: "done" } })
    const open = await call<Task[]>(workspace, "GET", "/tasks", { query: { status: "todo" } })
    expect(open.body.data).toHaveLength(1)
  })
})

describe("notes", () => {
  it("filters favorites from the query string", async () => {
    const note = { title: "B-trees", content: "", category: "dsa", tags: ["db"], favorite: true }
    await call(workspace, "POST", "/notes", { body: note })
    await call(workspace, "POST", "/notes", { body: { ...note, favorite: false } })
    const favorites = await call<unknown[]>(workspace, "GET", "/notes", {
      query: { favorite: "true" },
    })
    expect(favorites.body.data).toHaveLength(1)
  })
})

describe("board", () => {
  it("starts empty, saves, and stores the text encrypted", async () => {
    const empty = await call<Board>(workspace, "GET", "/board")
    expect(empty.body.data).toEqual({ content: "", updatedAt: null })

    const saved = await call<Board>(workspace, "PUT", "/board", { body: { content: "sk_live_123" } })
    expect(saved.body.data?.content).toBe("sk_live_123")

    const again = await call<Board>(workspace, "GET", "/board")
    expect(again.body.data).toEqual(saved.body.data)

    const stored = await settingsRepository.get("usr_test", "BOARD")
    expect(stored?.encryptedContent).not.toContain("sk_live_123")
  })

  it("rejects unknown fields", async () => {
    const res = await call(workspace, "PUT", "/board", { body: { content: "", pinned: true } })
    expect(res.status).toBe(400)
  })
})

describe("notifications", () => {
  it("derives reminders and persists read state", async () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString()
    await repositories.tasks.putMany("usr_test", [
      {
        id: "tsk_late",
        title: "Send follow-up",
        description: "",
        priority: "high",
        status: "todo",
        dueDate: yesterday,
        createdAt: yesterday,
      },
    ])

    const list = await call<AppNotification[]>(system, "GET", "/notifications")
    expect(list.body.data).toEqual([
      expect.objectContaining({ id: "task-tsk_late", kind: "task", urgent: true, read: false }),
    ])

    expect((await call(system, "PUT", "/notifications/task-tsk_late/read")).status).toBe(204)
    const after = await call<AppNotification[]>(system, "GET", "/notifications")
    expect(after.body.data?.[0]?.read).toBe(true)
  })

  it("respects notification preferences", async () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString()
    await repositories.tasks.putMany("usr_test", [
      {
        id: "tsk_late",
        title: "x",
        description: "",
        priority: "high",
        status: "todo",
        dueDate: yesterday,
        createdAt: yesterday,
      },
    ])
    await call(system, "PUT", "/settings/notifications", {
      body: {
        emailNotifications: true,
        interviewReminders: true,
        taskReminders: false,
        followUpReminders: true,
        weeklyDigest: false,
      },
    })
    expect((await call<unknown[]>(system, "GET", "/notifications")).body.data).toEqual([])
  })
})

describe("settings", () => {
  it("returns defaults, then the saved profile", async () => {
    expect((await call(system, "GET", "/settings/profile")).body.data).toMatchObject({ name: "" })
    const profile = {
      name: "Alex Morgan",
      email: "demo@example.com",
      role: "Engineer",
      bio: "",
      location: "Chennai",
    }
    expect((await call(system, "PUT", "/settings/profile", { body: profile })).status).toBe(200)
    expect((await call(system, "GET", "/settings/profile")).body.data).toEqual(profile)
    expect(
      (await call(system, "PUT", "/settings/profile", { body: { ...profile, email: "nope" } }))
        .status,
    ).toBe(400)
  })
})

describe("autofill profile", () => {
  const empty = {
    firstName: "", lastName: "", preferredName: "", email: "", phone: "", pronouns: "",
    addressLine: "", city: "", state: "", postalCode: "", country: "",
    linkedin: "", github: "", portfolio: "",
    currentTitle: "", currentCompany: "", experienceYears: "", noticePeriod: "", currentSalary: "", expectedSalary: "",
    workAuthorization: "", needsSponsorship: "", willingToRelocate: "",
    school: "", degree: "", fieldOfStudy: "", graduationYear: "",
    gender: "", ethnicity: "", disability: "", veteran: "",
    summary: "", coverLetter: "", experience: [], answers: [],
  }

  it("starts from the user's profile before the first save", async () => {
    await call(system, "PUT", "/settings/profile", {
      body: { name: "Alex Morgan", email: "alex@example.com", role: "Engineer", bio: "", location: "Chennai" },
    })
    expect((await call(system, "GET", "/settings/autofill")).body.data).toMatchObject({
      firstName: "Alex",
      lastName: "Morgan",
      email: "alex@example.com",
      city: "Chennai",
      currentTitle: "Engineer",
    })
  })

  it("saves the profile and gives answers ids", async () => {
    const body = { ...empty, firstName: "Alex", workAuthorization: "yes", answers: [{ question: "Why us?", answer: "Mission" }] }
    const saved = await call<{ answers: Array<{ id: string }> }>(system, "PUT", "/settings/autofill", { body })
    expect(saved.status).toBe(200)
    expect(saved.body.data?.answers[0]?.id).toMatch(/^ans_/)
    expect(
      (await call(system, "PUT", "/settings/autofill", { body: { ...body, workAuthorization: "maybe" } })).status,
    ).toBe(400)
  })

  it("saves a work history and rejects malformed dates", async () => {
    const job = { title: "Engineer", company: "Acme", location: "Chennai", startDate: "2021-03", endDate: "", current: true, description: "" }
    const saved = await call<{ experience: unknown[] }>(system, "PUT", "/settings/autofill", {
      body: { ...empty, experience: [job, { ...job, current: false, endDate: "2021-02", startDate: "2019-06" }] },
    })
    expect(saved.status).toBe(200)
    expect(saved.body.data?.experience).toHaveLength(2)
    expect(
      (await call(system, "PUT", "/settings/autofill", { body: { ...empty, experience: [{ ...job, startDate: "March 2021" }] } }))
        .status,
    ).toBe(400)
  })

  it("learns details only into empty fields and upserts answers by question", async () => {
    await call(system, "PUT", "/settings/autofill", {
      body: { ...empty, phone: "+91 90000 00000", answers: [{ question: "Notice period?", answer: "30 days" }] },
    })
    const learned = await call<{ phone: string; noticePeriod: string; answers: Array<{ question: string; answer: string }> }>(
      system,
      "POST",
      "/settings/autofill/learn",
      {
        body: {
          details: { phone: "123", noticePeriod: "15 days" },
          answers: [
            { question: "Notice period? (required)", answer: "15 days" },
            { question: "How did you hear about us?", answer: "LinkedIn" },
          ],
        },
      },
    )
    expect(learned.body.data?.phone).toBe("+91 90000 00000")
    expect(learned.body.data?.noticePeriod).toBe("15 days")
    expect(learned.body.data?.answers.map((a) => [a.question, a.answer])).toEqual([
      ["Notice period?", "15 days"],
      ["How did you hear about us?", "LinkedIn"],
    ])
  })
})
