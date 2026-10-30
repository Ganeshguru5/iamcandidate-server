import { z } from "zod"

import type { ISODate } from "../models"
import { longText, requiredText, shortText, stringList, urlText } from "../lib/validation"

/** A key/value row: the hero readout and agent-skill spec sheets. */
const pair = z.strictObject({ key: shortText(60), value: shortText(200) })

const profile = z.strictObject({
  name: requiredText(100),
  role: shortText(100),
  availability: shortText(120),
  intro: longText(2_000),
  aiHeading: shortText(100),
  aiBlurb: longText(2_000),
  aiSkills: stringList(30, 80),
  about: z.array(longText(3_000)).max(10),
  readout: z.array(pair).max(12),
  email: shortText(200),
  phone: shortText(40),
  location: shortText(100),
  resumeUrl: urlText,
  photo: urlText,
  socials: z.array(z.strictObject({ label: shortText(40), href: urlText })).max(12),
  education: z.strictObject({
    degree: shortText(150),
    school: shortText(150),
    years: shortText(60),
    grade: shortText(60),
  }),
  contactTitle: shortText(150),
  contactBody: longText(2_000),
})

const experience = z.strictObject({
  title: requiredText(120),
  company: shortText(120),
  location: shortText(100),
  exp: shortText(60),
  description: longText(3_000),
  image: urlText,
  skills: stringList(40, 80),
  current: z.boolean().optional(),
})

const project = z.strictObject({
  slug: z
    .string()
    .trim()
    .regex(/^[a-z0-9-]{1,80}$/, "Use lowercase letters, numbers and dashes"),
  title: requiredText(150),
  description: longText(1_000),
  detail: z.array(longText(3_000)).max(10),
  highlights: stringList(15, 300),
  image: urlText,
  href: urlText,
  meta: shortText(60),
  tags: stringList(20, 60),
  span: z.enum(["md:col-span-2", "md:col-span-4", "md:col-span-6"]),
  feature: z.boolean().optional(),
})

const agentSkill = z.strictObject({
  name: requiredText(100),
  tagline: shortText(200),
  description: longText(3_000),
  repo: urlText,
  install: shortText(300),
  version: shortText(30),
  license: shortText(40),
  spec: z.array(pair).max(12),
  tags: stringList(20, 60),
})

const testimonial = z.strictObject({
  quote: longText(2_000),
  name: requiredText(100),
  designation: shortText(200),
  src: urlText,
  linkedin: urlText,
})

/** Images people actually use on a web page; SVG is left out (it can carry scripts). */
export const PORTFOLIO_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/avif",
] as const

export const MAX_PORTFOLIO_IMAGE_BYTES = 5 * 1024 * 1024

export const imageUploadInput = z.strictObject({
  fileName: requiredText(255),
  contentType: z.enum(PORTFOLIO_IMAGE_TYPES),
  sizeBytes: z
    .number()
    .int()
    .positive()
    .max(MAX_PORTFOLIO_IMAGE_BYTES, "Images must be 5 MB or smaller"),
})
export type ImageUploadInput = z.output<typeof imageUploadInput>

/** Picks the iamcandidate resume whose saved PDF the site's download links serve. */
export const resumeSyncInput = z.strictObject({ resumeId: requiredText(128) })
export type ResumeSyncInput = z.output<typeof resumeSyncInput>

export const portfolioInput = z
  .strictObject({
    profile,
    experience: z.array(experience).max(30),
    projects: z.array(project).max(40),
    agentSkills: z.array(agentSkill).max(20),
    toolkit: z
      .array(z.strictObject({ group: requiredText(80), items: stringList(40, 80) }))
      .max(15),
    testimonials: z.array(testimonial).max(20),
  })
  .refine((value) => new Set(value.projects.map((p) => p.slug)).size === value.projects.length, {
    message: "Project slugs must be unique",
    path: ["projects"],
  })
export type PortfolioInput = z.output<typeof portfolioInput>

/** Which iamcandidate resume `profile.resumeUrl` was synced from; the site ignores it. */
export interface PortfolioResumeLink {
  resumeId: string
  title: string
  version: string
  syncedAt: ISODate
}

/** What is stored and served. Mirrors `PortfolioContent` in ganesh-portfolio/src/const.ts. */
export type PortfolioContent = PortfolioInput & { updatedAt?: ISODate; resume?: PortfolioResumeLink }
