import { AppError } from "../lib/errors"
import {
  capJob,
  clean,
  decodeEntities,
  emptyJob,
  extractJobFromHtml,
  htmlToText,
  linkedInJobId,
  siteOf,
  titleCase,
  workModeFrom,
  type ExtractedJobFields,
  type WorkModeGuess,
} from "../lib/job-page"
import { logger, serializeError } from "../lib/logger"
import { fetchPublic, publicHttpUrl, type FetchedPage, type FetchOptions } from "../lib/network"

/**
 * Reads a job posting from a link, for the "add from link" chat. Applicant
 * tracking systems with public job APIs (Greenhouse, Lever, Ashby, Workday)
 * are read through those — their pages are rendered in the browser and carry
 * little HTML. Everything else is fetched and parsed like the extension does
 * (site rules → JobPosting JSON-LD → meta tags).
 */

export interface JobExtraction {
  /** The link that was read. */
  url: string
  /** "job" when a posting was recognised; "unknown" leaves the user to fill it in. */
  kind: "job" | "unknown"
  /** Job board / ATS ("" when unknown). */
  site: string
  /** "api": the ATS's job API; "page": the page's HTML. */
  via: "api" | "page"
  job: ExtractedJobFields
}

type Fetcher = (url: string, options?: FetchOptions) => Promise<FetchedPage>

type Json = Record<string, unknown>

const str = (value: unknown) =>
  typeof value === "string" || typeof value === "number" ? String(value) : ""

function workModeOf(value: unknown): WorkModeGuess {
  const s = str(value)
    .toLowerCase()
    .replace(/[^a-z]/g, "")
  if (s === "remote") return "remote"
  if (s === "hybrid") return "hybrid"
  if (s === "onsite" || s === "inoffice") return "onsite"
  return ""
}

/** Message for a page that answered with an error status. */
function statusError(status: number, host: string): AppError {
  if (status === 404 || status === 410) {
    return new AppError(
      502,
      "INTEGRATION_ERROR",
      "That job page wasn't found. It may have been taken down.",
    )
  }
  if (status === 401 || status === 403 || status === 429 || status === 999) {
    return new AppError(
      502,
      "INTEGRATION_ERROR",
      `${host} didn't let knot read that page. Fill in the details yourself, or use the knot browser extension on the page.`,
    )
  }
  return new AppError(502, "INTEGRATION_ERROR", `${host} answered with an error (${status})`)
}

/**
 * Workday's hiring organisation is often a legal entity ("IL00 Mellanox
 * Technologies, Ltd." on NVIDIA's site); use it only when it names the tenant.
 */
function workdayCompany(organization: string, tenant: string): string {
  const name = organization.replace(/^[A-Z]{2}\d{2,}\s+/, "")
  return name.toLowerCase().includes(tenant.toLowerCase()) ? name : titleCase(tenant)
}

export function createJobExtractor(fetcher: Fetcher = fetchPublic) {
  async function getJson(url: string, options: FetchOptions = {}): Promise<Json> {
    const page = await fetcher(url, { accept: "application/json", ...options })
    if (page.status !== 200) throw statusError(page.status, new URL(url).hostname)
    try {
      return JSON.parse(page.body) as Json
    } catch {
      throw new AppError(502, "INTEGRATION_ERROR", "The job API answered with something unexpected")
    }
  }

  /** boards.greenhouse.io/acme/jobs/123, job-boards.greenhouse.io/acme/jobs/123, …/embed/job_app?for=acme&token=123 */
  async function greenhouse(url: URL) {
    const segments = url.pathname.split("/").filter(Boolean)
    const board = url.searchParams.get("for") ?? (segments[0] !== "embed" ? segments[0] : undefined)
    const id =
      url.pathname.match(/\/jobs\/(\d+)/)?.[1] ??
      url.searchParams.get("token") ??
      url.searchParams.get("gh_jid")
    if (!board || !id || !/^\d+$/.test(id)) return undefined
    const data = await getJson(
      `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board)}/jobs/${id}`,
    )
    const location = str((data.location as Json | undefined)?.name)
    return {
      ...emptyJob(),
      source: "Greenhouse",
      role: str(data.title),
      company: str(data.company_name) || titleCase(board),
      location,
      workMode: workModeFrom(location),
      jobId: str(data.id) || id,
      jobUrl: str(data.absolute_url) || url.toString(),
      // `content` is HTML, entity-escaped once more.
      description: htmlToText(decodeEntities(str(data.content))),
    }
  }

  /** jobs.lever.co/acme/<uuid> (or jobs.eu.lever.co) */
  async function lever(url: URL) {
    const [org, id] = url.pathname.split("/").filter(Boolean)
    if (!org || !id) return undefined
    const apiHost = url.hostname.includes(".eu.") ? "api.eu.lever.co" : "api.lever.co"
    const data = await getJson(
      `https://${apiHost}/v0/postings/${encodeURIComponent(org)}/${encodeURIComponent(id)}`,
    )
    const categories = (data.categories ?? {}) as Json
    const location = str(categories.location)
    const lists = Array.isArray(data.lists) ? (data.lists as Json[]) : []
    const range = (data.salaryRange ?? {}) as Json
    const interval = str(range.interval)
      .replace(/^per-/, "")
      .replace(/-salary$/, "")
    const salary =
      range.min && range.max
        ? clean(
            `${str(range.currency)} ${str(range.min)}–${str(range.max)}${interval ? ` / ${interval}` : ""}`,
          )
        : ""
    const description = [
      htmlToText(data.description) || str(data.descriptionPlain),
      ...lists.map((list) => `${str(list.text)}\n${htmlToText(list.content)}`),
      str(data.additionalPlain),
    ]
      .map((part) => part.trim())
      .filter(Boolean)
      .join("\n\n")
    return {
      ...emptyJob(),
      source: "Lever",
      role: str(data.text),
      company: titleCase(org),
      location,
      workMode: workModeOf(data.workplaceType) || workModeFrom(location),
      salary,
      jobId: str(data.id) || id,
      jobUrl: str(data.hostedUrl) || url.toString().replace(/\/apply\/?$/, ""),
      description,
    }
  }

  /** jobs.ashbyhq.com/acme/<uuid> */
  async function ashby(url: URL) {
    const [org, id] = url.pathname.split("/").filter(Boolean)
    if (!org || !id) return undefined
    const data = await getJson(
      `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(org)}?includeCompensation=true`,
      // The board API returns every posting with its description; big boards run to megabytes.
      { maxBytes: 30 * 1024 * 1024, timeoutMs: 12_000 },
    )
    const jobs = Array.isArray(data.jobs) ? (data.jobs as Json[]) : []
    const posting = jobs.find((job) => job.id === id)
    if (!posting) {
      throw new AppError(
        502,
        "INTEGRATION_ERROR",
        "That job is no longer listed on the company's job board.",
      )
    }
    const location = str(posting.location)
    const compensation = (posting.compensation ?? {}) as Json
    return {
      ...emptyJob(),
      source: "Ashby",
      role: str(posting.title),
      company: titleCase(org),
      location,
      workMode:
        workModeOf(posting.workplaceType) || (posting.isRemote ? "remote" : workModeFrom(location)),
      salary:
        str(compensation.scrapeableCompensationSalarySummary) ||
        str(compensation.compensationTierSummary),
      jobId: id,
      jobUrl: str(posting.jobUrl) || `https://jobs.ashbyhq.com/${org}/${id}`,
      description: htmlToText(posting.descriptionHtml) || str(posting.descriptionPlain),
    }
  }

  /** acme.wd5.myworkdayjobs.com/[en-US/]External/job/Location/Title_R123 */
  async function workday(url: URL) {
    const segments = url.pathname.split("/").filter(Boolean)
    const at = segments.indexOf("job")
    const site = segments[at - 1]
    const tenant = url.hostname.split(".")[0]
    if (at < 1 || !site || !tenant || at === segments.length - 1) return undefined
    const rest = segments.slice(at + 1).join("/")
    const data = await getJson(`https://${url.hostname}/wday/cxs/${tenant}/${site}/job/${rest}`)
    const info = (data.jobPostingInfo ?? {}) as Json
    const location = str(info.location)
    return {
      ...emptyJob(),
      source: "Workday",
      role: str(info.title),
      company: workdayCompany(str((data.hiringOrganization as Json | undefined)?.name), tenant),
      location,
      workMode: workModeFrom(str(info.remoteType)) || workModeFrom(location),
      jobId: str(info.jobReqId),
      jobUrl: str(info.externalUrl) || `${url.origin}${url.pathname}`,
      description: htmlToText(info.jobDescription),
    }
  }

  const ATS_APIS: Record<string, (url: URL) => Promise<ExtractedJobFields | undefined>> = {
    Greenhouse: greenhouse,
    Lever: lever,
    Ashby: ashby,
    Workday: workday,
  }

  async function readPage(url: URL): Promise<JobExtraction> {
    // LinkedIn serves logged-out visitors a lighter job page with the same details.
    const linkedInId = siteOf(url) === "LinkedIn" ? linkedInJobId(url) : ""
    const target = linkedInId
      ? `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${linkedInId}`
      : url.toString()
    const page = await fetcher(target)
    if (page.status >= 400) throw statusError(page.status, url.hostname.replace(/^www\./, ""))
    if (page.contentType && !/html|xml/i.test(page.contentType)) {
      throw new AppError(502, "INTEGRATION_ERROR", "That link isn't a web page")
    }
    // Follow redirects (short links etc.) for the site rules, except LinkedIn's
    // guest endpoint, which stands in for the job's own link.
    const link = linkedInId ? `https://www.linkedin.com/jobs/view/${linkedInId}/` : page.url
    const result = extractJobFromHtml(page.body, link)
    // Naukri's page is an empty shell without its API; say so rather than show a blank card.
    if (result.site === "Naukri" && !result.job.role) {
      throw new AppError(
        502,
        "INTEGRATION_ERROR",
        "naukri.com didn't let knot read that job. Copy the job's text from the page and paste it here, or fill in the details yourself.",
      )
    }
    return { url: url.toString(), via: "page", ...result }
  }

  return {
    async extract(raw: string): Promise<JobExtraction> {
      const url = publicHttpUrl(raw)
      const site = siteOf(url)
      const api = ATS_APIS[site]
      if (api) {
        try {
          const job = await api(url)
          if (job?.role)
            return { url: url.toString(), kind: "job", site, via: "api", job: capJob(job) }
        } catch (error) {
          // Custom domains, unlisted boards, API changes: fall back to the page.
          logger.warn("Job API lookup failed", { site, error: serializeError(error) })
        }
      }
      return readPage(url)
    },
  }
}

export const jobExtractService = createJobExtractor()
