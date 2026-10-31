import type { z } from "zod"

import { createId, nowIso } from "../lib/ids"
import type { AutofillAnswer, AutofillProfile } from "../models"
import { settingsRepository } from "../repositories/dynamodb"
import type { autofillLearnInput, autofillProfileInput } from "../schemas/system"
import { activitiesService } from "./activities.service"

type ProfileInput = z.infer<typeof autofillProfileInput>
type LearnInput = z.infer<typeof autofillLearnInput>

export const EMPTY_AUTOFILL: AutofillProfile = {
  firstName: "",
  lastName: "",
  preferredName: "",
  email: "",
  phone: "",
  pronouns: "",
  addressLine: "",
  city: "",
  state: "",
  postalCode: "",
  country: "",
  linkedin: "",
  github: "",
  portfolio: "",
  currentTitle: "",
  currentCompany: "",
  experienceYears: "",
  noticePeriod: "",
  currentSalary: "",
  expectedSalary: "",
  workAuthorization: "",
  needsSponsorship: "",
  willingToRelocate: "",
  school: "",
  degree: "",
  fieldOfStudy: "",
  graduationYear: "",
  gender: "",
  ethnicity: "",
  disability: "",
  veteran: "",
  summary: "",
  coverLetter: "",
  experience: [],
  answers: [],
}

/** Saved answers are matched by the question without case, punctuation or "required" marks. */
export const questionKey = (question: string) =>
  question
    .toLowerCase()
    .replace(/\((required|optional)\)|\brequired\b/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()

export const autofillService = {
  /** The saved profile; before the first save, a start from the user's profile. */
  async get(userId: string): Promise<AutofillProfile> {
    const stored = await settingsRepository.get(userId, "AUTOFILL")
    if (stored) return { ...EMPTY_AUTOFILL, ...stored }
    const profile = await settingsRepository.get(userId, "PROFILE")
    const [firstName = "", ...rest] = (profile?.name ?? "").trim().split(/\s+/)
    return {
      ...EMPTY_AUTOFILL,
      firstName,
      lastName: rest.join(" "),
      email: profile?.email ?? "",
      city: profile?.location ?? "",
      currentTitle: profile?.role ?? "",
      summary: profile?.bio ?? "",
    }
  },

  async update(userId: string, input: ProfileInput): Promise<AutofillProfile> {
    const now = nowIso()
    const previous = await settingsRepository.get(userId, "AUTOFILL")
    const before = new Map((previous?.answers ?? []).map((a) => [a.id, a]))
    const answers: AutofillAnswer[] = input.answers.map((a) => {
      const old = a.id ? before.get(a.id) : undefined
      const unchanged = old && old.question === a.question && old.answer === a.answer
      return { id: old?.id ?? createId("ans"), question: a.question, answer: a.answer, updatedAt: unchanged ? old.updatedAt : now }
    })
    const profile: AutofillProfile = { ...EMPTY_AUTOFILL, ...input, answers, updatedAt: now }
    await settingsRepository.put(userId, "AUTOFILL", profile)
    await activitiesService.record(userId, { type: "settings_updated", title: "Autofill profile updated" })
    return profile
  },

  /**
   * Adds what the extension learned from a form you filled: a detail only
   * fills a field that's still empty (what you type for one job may not suit
   * the next), and an answer replaces the saved answer to the same question.
   */
  async learn(userId: string, input: LearnInput): Promise<AutofillProfile> {
    const current = await this.get(userId)
    const next: AutofillProfile = { ...current, answers: [...current.answers] }
    const details = next as unknown as Record<string, unknown>
    for (const [key, value] of Object.entries(input.details)) {
      if (typeof value === "string" && value.trim() && !String(details[key] ?? "").trim()) details[key] = value
    }
    const now = nowIso()
    for (const { question, answer } of input.answers) {
      const key = questionKey(question)
      if (!key || !answer.trim()) continue
      const index = next.answers.findIndex((a) => questionKey(a.question) === key)
      const existing = next.answers[index]
      if (existing) next.answers[index] = { ...existing, answer, updatedAt: now }
      else next.answers.push({ id: createId("ans"), question, answer, updatedAt: now })
    }
    next.updatedAt = now
    await settingsRepository.put(userId, "AUTOFILL", next)
    return next
  },
}
