import { csvRecords } from "../lib/csv"
import { BadRequestError } from "../lib/errors"
import { createId, nowIso } from "../lib/ids"
import type {
  Application,
  Company,
  Contact,
  LinkedInExportKind,
  LinkedInImportResult,
  LinkedInStatus,
} from "../models"
import { repositories, settingsRepository } from "../repositories/dynamodb"
import { activitiesService } from "./activities.service"
import { timelineEvent } from "./applications.service"

/**
 * Imports the CSV files from LinkedIn's "Get a copy of your data" export.
 * LinkedIn's API doesn't let other apps read connections or saved jobs, so
 * the export is the supported way to bring them in.
 *
 * - Connections.csv           → contacts (and their companies)
 * - Saved Jobs.csv            → applications in Wishlist
 * - Job Applications.csv      → applications in Applied
 */
export const MAX_IMPORT_ROWS = 5000

const FORMATS: Record<LinkedInExportKind, string[]> = {
  connections: ["first name", "last name"],
  job_applications: ["application date", "company name", "job title"],
  saved_jobs: ["company name", "job title", "job url"],
}

const LABELS: Record<LinkedInExportKind, string> = {
  connections: "connections",
  saved_jobs: "saved jobs",
  job_applications: "job applications",
}

/** Detects which export a CSV is (job applications first: they also have saved-job columns). */
function detect(text: string) {
  for (const kind of ["connections", "job_applications", "saved_jobs"] as const) {
    const parsed = csvRecords(text, FORMATS[kind])
    if (parsed) return { kind, records: parsed.records }
  }
  throw new BadRequestError(
    "This doesn't look like a LinkedIn export. Upload Connections.csv, Saved Jobs.csv or Job Applications.csv.",
  )
}

const clip = (value: string | undefined, max = 200) => (value ?? "").trim().slice(0, max)

const normName = (value: string) =>
  value
    .toLowerCase()
    .replace(/[.,&()'"]/g, " ")
    .replace(/\b(inc|llc|ltd|limited|pvt|private|corp|corporation|co|gmbh|plc|llp|the)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim()

const linkedInSlug = (value?: string) =>
  value?.match(/linkedin\.com\/in\/([^/?#]+)/i)?.[1]?.toLowerCase()

const normUrl = (value?: string) => {
  if (!value) return ""
  try {
    const url = new URL(value)
    return `${url.hostname.replace(/^www\./, "")}${url.pathname.replace(/\/+$/, "")}`.toLowerCase()
  } catch {
    return ""
  }
}

const isEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]

/** LinkedIn dates: "21 Oct 2026", "10/21/26, 3:04 PM" or anything Date can read. */
export function parseLinkedInDate(value: string | undefined): string | undefined {
  const text = value?.trim()
  if (!text) return undefined
  const named = /^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})$/.exec(text)
  if (named) {
    const [, day, monthName = "", year] = named
    const month = MONTHS.indexOf(monthName.toLowerCase())
    if (month >= 0) return new Date(Date.UTC(Number(year), month, Number(day), 12)).toISOString()
  }
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:,?\s+(\d{1,2}):(\d{2})\s*([AP]M))?/i.exec(text)
  if (us) {
    const [, month, day, rawYear, rawHour, minute, meridiem] = us
    const year = Number(rawYear) < 100 ? 2000 + Number(rawYear) : Number(rawYear)
    let hour = rawHour ? Number(rawHour) % 12 : 12
    if (meridiem?.toUpperCase() === "PM") hour += 12
    return new Date(
      Date.UTC(year, Number(month) - 1, Number(day), hour, minute ? Number(minute) : 0),
    ).toISOString()
  }
  const parsed = Date.parse(text)
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString()
}

/** Finds or plans a company by name; new ones are collected in `created`. */
function companyResolver(existing: Company[]) {
  const byName = new Map(existing.map((c) => [normName(c.name), c]))
  const created: Company[] = []
  return {
    created,
    idFor(name: string): string | undefined {
      const clean = clip(name)
      const key = normName(clean)
      if (!key) return undefined
      let company = byName.get(key)
      if (!company) {
        company = {
          id: createId("cmp"),
          name: clean,
          industry: "",
          website: "",
          location: "",
          size: "",
          status: "researching",
          description: "",
          notes: "Added from a LinkedIn import.",
          createdAt: nowIso(),
        }
        byName.set(key, company)
        created.push(company)
      }
      return company.id
    },
  }
}

async function importConnections(userId: string, records: Array<Record<string, string>>) {
  const [contacts, companies] = await Promise.all([
    repositories.contacts.list(userId),
    repositories.companies.list(userId),
  ])
  const slugs = new Set(contacts.map((c) => linkedInSlug(c.linkedin)).filter(Boolean))
  const names = new Set(contacts.map((c) => c.name.toLowerCase()))
  const resolver = companyResolver(companies)
  const toCreate: Contact[] = []
  let skipped = 0
  let invalid = 0

  for (const row of records) {
    const name = clip(`${row["first name"] ?? ""} ${row["last name"] ?? ""}`.replace(/\s+/g, " "))
    if (!name) {
      invalid++
      continue
    }
    const url = clip(row["url"], 2048)
    const slug = linkedInSlug(url)
    if ((slug && slugs.has(slug)) || names.has(name.toLowerCase())) {
      skipped++
      continue
    }
    if (slug) slugs.add(slug)
    names.add(name.toLowerCase())
    const email = clip(row["email address"], 254)
    const connectedOn = clip(row["connected on"])
    const companyId = resolver.idFor(row["company"] ?? "")
    toCreate.push({
      id: createId("ct"),
      name,
      role: clip(row["position"]),
      ...(companyId ? { companyId } : {}),
      email: isEmail(email) ? email : "",
      ...(url ? { linkedin: url } : {}),
      relationship: "professional",
      notes: connectedOn ? `Connected on LinkedIn on ${connectedOn}.` : "Imported from LinkedIn.",
      createdAt: nowIso(),
    })
  }
  return {
    created: toCreate,
    companies: resolver.created,
    skipped,
    invalid,
    sample: toCreate.slice(0, 5).map((c) => (c.role ? `${c.name} — ${c.role}` : c.name)),
    write: async () => {
      await repositories.companies.putMany(userId, resolver.created)
      await repositories.contacts.putMany(userId, toCreate)
    },
  }
}

async function importJobs(
  userId: string,
  kind: "saved_jobs" | "job_applications",
  records: Array<Record<string, string>>,
) {
  const [applications, companies] = await Promise.all([
    repositories.applications.list(userId),
    repositories.companies.list(userId),
  ])
  const urls = new Set(applications.map((a) => normUrl(a.jobUrl)).filter(Boolean))
  const resolver = companyResolver(companies)
  const roleKey = (companyId: string, role: string) => `${companyId}|${role.toLowerCase()}`
  const roles = new Set(applications.map((a) => roleKey(a.companyId, a.role)))
  const applied = kind === "job_applications"
  const toCreate: Application[] = []
  let skipped = 0
  let invalid = 0

  for (const row of records) {
    const role = clip(row["job title"])
    const companyName = clip(row["company name"])
    if (!role || !companyName) {
      invalid++
      continue
    }
    const jobUrl = clip(row["job url"], 2048)
    const url = normUrl(jobUrl)
    const companyId = resolver.idFor(companyName) as string
    if ((url && urls.has(url)) || roles.has(roleKey(companyId, role))) {
      skipped++
      continue
    }
    if (url) urls.add(url)
    roles.add(roleKey(companyId, role))

    const date = parseLinkedInDate(row[applied ? "application date" : "saved date"])
    const now = nowIso()
    const notes = [
      applied ? "Applied on LinkedIn." : "Saved on LinkedIn.",
      row["resume name"] ? `Resume: ${row["resume name"]}` : "",
      row["contact email"] ? `Contact: ${row["contact email"]}` : "",
    ]
      .filter(Boolean)
      .join("\n")
    const jobId = jobUrl.match(/\/jobs\/view\/(?:[^/]*?-)?(\d{6,})/)?.[1]
    toCreate.push({
      id: createId("app"),
      companyId,
      role,
      location: "",
      // LinkedIn's export doesn't include the work mode; edit it in IamCandidate if it differs.
      workMode: "onsite",
      status: applied ? "applied" : "wishlist",
      priority: "medium",
      ...(applied ? { appliedDate: date ?? now } : {}),
      ...(jobUrl ? { jobUrl } : {}),
      ...(jobId ? { jobId } : {}),
      source: "LinkedIn",
      notes,
      timeline: [
        timelineEvent(
          "Imported from LinkedIn",
          "created",
          date ? `Original date: ${date.slice(0, 10)}` : undefined,
        ),
        ...(applied ? [timelineEvent("Status set to Applied", "status")] : []),
      ],
      createdAt: now,
      updatedAt: now,
    })
  }
  return {
    created: toCreate,
    companies: resolver.created,
    skipped,
    invalid,
    sample: toCreate
      .slice(0, 5)
      .map(
        (a) =>
          `${a.role} — ${resolver.created.find((c) => c.id === a.companyId)?.name ?? companies.find((c) => c.id === a.companyId)?.name ?? ""}`,
      ),
    write: async () => {
      await repositories.companies.putMany(userId, resolver.created)
      await repositories.applications.putMany(userId, toCreate)
    },
  }
}

export const linkedinService = {
  async status(userId: string): Promise<LinkedInStatus> {
    return (await settingsRepository.get(userId, "LINKEDIN")) ?? { imports: {} }
  },

  /** Imports one export file. With `dryRun`, only reports what would happen. */
  async import(userId: string, csv: string, dryRun: boolean): Promise<LinkedInImportResult> {
    const { kind, records } = detect(csv)
    if (records.length > MAX_IMPORT_ROWS) {
      throw new BadRequestError(
        `This file has ${records.length} rows; import at most ${MAX_IMPORT_ROWS} at a time.`,
      )
    }
    const plan =
      kind === "connections"
        ? await importConnections(userId, records)
        : await importJobs(userId, kind, records)

    const result: LinkedInImportResult = {
      kind,
      rows: records.length,
      created: plan.created.length,
      skipped: plan.skipped,
      invalid: plan.invalid,
      companiesCreated: plan.companies.length,
      sample: plan.sample,
      dryRun,
    }
    if (dryRun || plan.created.length === 0) return result

    await plan.write()
    const now = nowIso()
    const status = await this.status(userId)
    await settingsRepository.put(userId, "LINKEDIN", {
      lastImportAt: now,
      imports: { ...status.imports, [kind]: { at: now, created: plan.created.length } },
    })
    await activitiesService.record(userId, {
      type: "data_imported",
      title: `Imported ${plan.created.length} LinkedIn ${LABELS[kind]}`,
      ...(plan.companies.length
        ? {
            description: `${plan.companies.length} new compan${plan.companies.length === 1 ? "y" : "ies"}`,
          }
        : {}),
      entity: { type: "integration", id: "linkedin" },
    })
    return result
  },
}
