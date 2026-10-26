import { parseHTML } from "linkedom"

/**
 * Reads job details from a job posting's HTML. A server-side port of the job
 * half of knot-extension's `src/lib/extract.js` — keep the site rules of the
 * two in step.
 *
 * Strategy, most to least specific: site rules (LinkedIn, Naukri, Indeed,
 * Lever, Greenhouse, Ashby, Workday) → schema.org `JobPosting` JSON-LD (most
 * career sites and ATSs) → generic meta tags / `<h1>`. Anything still empty
 * is left blank for the user to fill in.
 */

export type WorkModeGuess = "remote" | "hybrid" | "onsite" | ""

export interface ExtractedJobFields {
  role: string
  company: string
  location: string
  workMode: WorkModeGuess
  salary: string
  jobId: string
  jobUrl: string
  source: string
  description: string
}

export interface PageExtraction {
  /** "job" when the page is recognisably a job posting. */
  kind: "job" | "unknown"
  /** Job board / ATS the link belongs to ("" when unknown). */
  site: string
  job: ExtractedJobFields
}

/* The few DOM members used here (the project doesn't load the DOM types). */
interface DomElement {
  textContent: string | null
  innerHTML: string
  getAttribute(name: string): string | null
  querySelector(selector: string): DomElement | null
  querySelectorAll(selector: string): Iterable<DomElement>
}
interface DomDocument extends DomElement {
  title: string
}

export function parseDocument(html: string): DomDocument {
  return parseHTML(html).document as unknown as DomDocument
}

/* ---------------- helpers ---------------- */

export const clean = (value: unknown) =>
  String(value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim()

const text = (el: DomElement | null | undefined) => clean(el?.textContent)

/** Decodes HTML entities (`&amp;`, `&lt;p&gt;`, `&#39;`, …). */
export function decodeEntities(value: string): string {
  const pre = parseDocument(
    `<!doctype html><html><body><pre>${value.replace(/</g, "&lt;")}</pre></body></html>`,
  )
  return pre.querySelector("pre")?.textContent ?? value
}

/** Plain text from an HTML fragment, keeping paragraphs and list items. */
export function htmlToText(html: unknown): string {
  const withBreaks = String(html ?? "")
    .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|ul|ol|section)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
  return decodeEntities(withBreaks)
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

/** "remote" | "hybrid" | "onsite" | "" from a short label (not free text). */
export function workModeFrom(value: unknown): WorkModeGuess {
  const s = String(value ?? "").toLowerCase()
  if (!s) return ""
  if (/\bhybrid\b/.test(s)) return "hybrid"
  if (/\bremote\b|work from home|\bwfh\b|telecommute/.test(s)) return "remote"
  if (/on-?site|in[- ]office|work from office|\bwfo\b/.test(s)) return "onsite"
  return ""
}

const looksLikeSalary = (value: string) =>
  /[₹$€£]|\b(lpa|lakh|lakhs|lacs|crore|inr|usd|eur|gbp|ctc)\b|\/\s?(yr|year|hr|hour|mo|month)\b|\d+\s?k\b/i.test(
    value,
  )

export const emptyJob = (): ExtractedJobFields => ({
  role: "",
  company: "",
  location: "",
  workMode: "",
  salary: "",
  jobId: "",
  jobUrl: "",
  source: "",
  description: "",
})

/** Fills only the fields of `target` that are still empty. */
export function fill(target: ExtractedJobFields, values: Partial<ExtractedJobFields>) {
  for (const [key, value] of Object.entries(values) as [keyof ExtractedJobFields, string][]) {
    if (!target[key] && value) (target as unknown as Record<string, string>)[key] = value.trim()
  }
  return target
}

/** "acme-labs" → "Acme Labs". */
export const titleCase = (slug: string) =>
  slug
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim()

/** Caps fields to what the applications API accepts. */
export function capJob(job: ExtractedJobFields): ExtractedJobFields {
  const cap = (value: string, max: number) => (value.length > max ? value.slice(0, max) : value)
  const out = { ...job }
  for (const key of ["role", "company", "location", "salary", "jobId", "source"] as const) {
    out[key] = cap(clean(out[key]), 200)
  }
  out.jobUrl = cap(out.jobUrl, 2048)
  out.description = cap(out.description, 20000)
  return out
}

/* ---------------- schema.org JobPosting ---------------- */

type Json = Record<string, unknown>

const first = (v: unknown) => (Array.isArray(v) ? v[0] : v) as Json | string | undefined

export function findJobPosting(document: DomDocument): Json | undefined {
  const found: Json[] = []
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return
    if (Array.isArray(node)) return node.forEach(visit)
    const type = (node as Json)["@type"]
    if (type === "JobPosting" || (Array.isArray(type) && type.includes("JobPosting"))) {
      found.push(node as Json)
    }
    if ((node as Json)["@graph"]) visit((node as Json)["@graph"])
  }
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      visit(JSON.parse(script.textContent ?? ""))
    } catch {
      // Ignore malformed blocks.
    }
  }
  return found[0]
}

export function fromJobPosting(posting: Json | undefined): Partial<ExtractedJobFields> {
  if (!posting) return {}
  const org = first(posting.hiringOrganization)
  const places = ([] as unknown[]).concat(posting.jobLocation ?? [])
  const location = places
    .map((place) => {
      const address = (place as Json | undefined)?.address ?? {}
      if (typeof address === "string") return address
      const a = address as Json
      const country =
        typeof a.addressCountry === "object"
          ? (a.addressCountry as Json | null)?.name
          : a.addressCountry
      return [a.addressLocality, a.addressRegion, country].filter(Boolean).join(", ")
    })
    .filter(Boolean)
    .slice(0, 3)
    .join(" · ")

  let salary = ""
  const pay = first(posting.baseSalary) ?? first(posting.estimatedSalary)
  if (pay && typeof pay === "object") {
    const value = (pay.value ?? {}) as Json | string | number
    const currency = pay.currency ?? (typeof value === "object" ? value.currency : "") ?? ""
    const unit = String(
      (typeof value === "object" ? value.unitText : undefined) ?? pay.unitText ?? "",
    ).toLowerCase()
    const amount =
      typeof value === "object"
        ? value.minValue && value.maxValue
          ? `${String(value.minValue)}–${String(value.maxValue)}`
          : (value.value ?? value.minValue ?? value.maxValue ?? "")
        : value
    if (amount) salary = clean(`${String(currency)} ${String(amount)}${unit ? ` / ${unit}` : ""}`)
  }

  const types = ([] as unknown[]).concat(posting.jobLocationType ?? []).join(" ")
  const identifier = first(posting.identifier)
  return {
    role: clean(posting.title),
    company: clean(typeof org === "string" ? org : org?.name),
    location,
    workMode: /telecommute/i.test(types) ? "remote" : "",
    salary,
    jobId: clean(typeof identifier === "object" ? identifier?.value : identifier),
    description: htmlToText(posting.description),
  }
}

/* ---------------- site detection ---------------- */

export function siteOf(url: URL): string {
  const host = url.hostname.replace(/^www\./, "")
  if (host.endsWith("linkedin.com")) return "LinkedIn"
  if (host.endsWith("naukri.com")) return "Naukri"
  if (/(^|\.)indeed\./.test(host)) return "Indeed"
  if (host.endsWith("lever.co")) return "Lever"
  if (host.includes("greenhouse.io")) return "Greenhouse"
  if (host.endsWith("ashbyhq.com")) return "Ashby"
  if (host.includes("myworkdayjobs.com")) return "Workday"
  return ""
}

/** LinkedIn job id from a job view or search URL. */
export function linkedInJobId(url: URL): string {
  return (
    url.searchParams.get("currentJobId") ||
    url.pathname.match(/\/jobs\/view\/(?:[^/]*?-)?(\d{6,})/)?.[1] ||
    ""
  )
}

/** Naukri job id: the trailing number of a job-listings slug, or ?jobId=. */
export function naukriJobId(url: URL): string {
  const id =
    url.searchParams.get("jobId") || url.pathname.match(/-(\d{6,})\/?$/)?.[1] || ""
  return /^\d{6,}$/.test(id) ? id : ""
}

/* ---------------- page extraction ---------------- */

/**
 * Extracts job fields from `html`, read for the job link `linkUrl`. Site rules
 * go by the link, so `html` may come from another endpoint for the same job
 * (e.g. LinkedIn's guest job page for a linkedin.com/jobs/view link).
 */
export function extractJobFromHtml(html: string, linkUrl: string): PageExtraction {
  const document = parseDocument(html)
  const url = new URL(linkUrl)
  const host = url.hostname.replace(/^www\./, "")
  const path = url.pathname
  const params = url.searchParams

  /** Text of the first element matching any selector. */
  const pick = (selectors: string[], root: DomElement = document) => {
    for (const selector of selectors) {
      let els: Iterable<DomElement>
      try {
        els = root.querySelectorAll(selector)
      } catch {
        continue
      }
      for (const el of els) {
        const value = text(el)
        if (value) return value
      }
    }
    return ""
  }

  /** Multi-line text (keeps paragraphs) for descriptions. */
  const block = (selectors: string[]) => {
    for (const selector of selectors) {
      let el: DomElement | null
      try {
        el = document.querySelector(selector)
      } catch {
        continue
      }
      const value = el ? htmlToText(el.innerHTML) : ""
      if (value.length > 40) return value
    }
    return ""
  }

  const meta = (name: string) =>
    clean(
      document
        .querySelector(`meta[property="${name}"], meta[name="${name}"]`)
        ?.getAttribute("content"),
    )

  const companyFromPath = () => titleCase(path.split("/").filter(Boolean)[0] ?? "")

  const linkedInJob = () => {
    const id = linkedInJobId(url)
    // The details pane on search pages, the main column on /jobs/view.
    const pane =
      document.querySelector(
        ".jobs-search__job-details--container, .jobs-search__job-details, .job-view-layout, .jobs-details",
      ) ?? document

    const job = emptyJob()
    job.source = "LinkedIn"
    job.jobId = id
    job.jobUrl = id ? `https://www.linkedin.com/jobs/view/${id}/` : linkUrl

    job.role = pick(
      [
        ".job-details-jobs-unified-top-card__job-title h1",
        ".job-details-jobs-unified-top-card__job-title",
        ".jobs-unified-top-card__job-title",
        ".jobs-details-top-card__job-title",
        "h1.top-card-layout__title",
        "h2.top-card-layout__title",
        ".topcard__title",
        "h1",
      ],
      pane,
    )
    job.company = pick(
      [
        ".job-details-jobs-unified-top-card__company-name a",
        ".job-details-jobs-unified-top-card__company-name",
        ".jobs-unified-top-card__company-name a",
        ".jobs-unified-top-card__company-name",
        "a.topcard__org-name-link",
        ".topcard__org-name-link",
        'a[href*="/company/"]:not([aria-hidden="true"])',
      ],
      pane,
    )

    const subline = pick(
      [
        ".job-details-jobs-unified-top-card__tertiary-description-container",
        ".job-details-jobs-unified-top-card__primary-description-container",
        ".job-details-jobs-unified-top-card__primary-description",
        ".jobs-unified-top-card__subtitle-primary-grouping",
        ".topcard__flavor-row",
      ],
      pane,
    )
    job.location =
      pick([".jobs-unified-top-card__bullet", ".topcard__flavor--bullet"], pane) ||
      clean(subline.split("·")[0])

    // Preference pills: "Remote", "Full-time", "₹20L/yr - ₹30L/yr", …
    const pills = [
      ...pane.querySelectorAll(
        ".job-details-preferences-and-skills__pill, .job-details-fit-level-preferences button, .jobs-unified-top-card__workplace-type, .job-details-jobs-unified-top-card__job-insight, .ui-label, .compensation__salary",
      ),
    ].map(text)
    for (const pill of pills) {
      if (!job.workMode) job.workMode = workModeFrom(pill)
      if (!job.salary && looksLikeSalary(pill) && pill.length < 80) job.salary = pill
    }
    if (!job.workMode) job.workMode = workModeFrom(job.location)
    if (/^\s*(remote|hybrid|on-?site)\s*$/i.test(job.location)) job.location = ""
    job.location = clean(job.location.replace(/\((remote|hybrid|on-?site)\)/i, ""))

    job.description = block([
      "#job-details",
      ".jobs-description__content .jobs-box__html-content",
      ".jobs-description-content__text",
      ".jobs-description__content",
      ".show-more-less-html__markup",
      ".description__text",
    ]).replace(/^About the job\s*/i, "")

    // /jobs/view titles read "Role | Company | LinkedIn"; guest pages use
    // og:title "Company hiring Role in Location | LinkedIn".
    if (path.startsWith("/jobs/view")) {
      const parts = document.title.replace(/^\(\d+\)\s*/, "").split(" | ")
      if (parts.length >= 3) fill(job, { role: parts[0], company: parts[1] })
    }
    const og = meta("og:title").match(/^(.+?) hiring (.+?) in (.+?) \| LinkedIn/i)
    if (og) fill(job, { company: og[1], role: og[2], location: og[3] })

    return job
  }

  const naukriJob = () => {
    const job = emptyJob()
    job.source = "Naukri"
    job.jobUrl = linkUrl.split("?")[0] ?? linkUrl
    job.jobId = naukriJobId(url)
    job.role = pick(['[class*="jd-header-title"]', ".jd-header-title", "h1"])
    job.company = pick([
      '[class*="jd-header-comp-name"] > a',
      '[class*="jd-header-comp-name"] a',
      '[class*="jd-header-comp-name"]',
    ])
    job.location = pick(['[class*="jhc__location"]', '[class*="jhc__loc"]', '[class*="location"]'])
    const salary = pick(['[class*="jhc__salary"]', '[class*="salary"]'])
    if (salary && !/not disclosed/i.test(salary)) job.salary = salary
    job.workMode =
      workModeFrom(pick(['[class*="jhc__wfhmode"]', '[class*="wfh"]'])) ||
      workModeFrom(job.location)
    job.location = clean(job.location.replace(/^(hybrid|remote|on-?site)\s*-\s*/i, ""))
    job.description = block([
      '[class*="JDC__dang-inner-html"]',
      '[class*="dang-inner-html"]',
      '[class*="job-desc"]',
      ".job-desc",
    ])
    return job
  }

  const indeedJob = () => {
    const job = emptyJob()
    job.source = "Indeed"
    const id = params.get("vjk") || params.get("jk") || ""
    job.jobId = id
    job.jobUrl = id ? `${url.origin}/viewjob?jk=${id}` : linkUrl
    job.role = pick([
      '[data-testid="jobsearch-JobInfoHeader-title"]',
      "h1.jobsearch-JobInfoHeader-title",
      "h2.jobsearch-JobInfoHeader-title",
    ]).replace(/\s*-\s*job post$/i, "")
    job.company = pick([
      '[data-testid="inlineHeader-companyName"]',
      '[data-company-name="true"]',
      ".jobsearch-CompanyInfoContainer a",
    ])
    job.location = pick([
      '[data-testid="inlineHeader-companyLocation"]',
      '[data-testid="job-location"]',
      '[data-testid="jobsearch-JobInfoHeader-companyLocation"]',
    ])
    job.salary = pick(['#salaryInfoAndJobType [class*="salary"]', "#salaryInfoAndJobType span"])
    job.workMode = workModeFrom(job.location)
    job.description = block(["#jobDescriptionText"])
    return job
  }

  const leverJob = () => {
    const job = emptyJob()
    job.source = "Lever"
    job.jobUrl = linkUrl.replace(/\/apply\/?$/, "")
    job.jobId = path.split("/").filter(Boolean)[1] ?? ""
    job.role = pick([".posting-headline h2", "h2"])
    job.location = pick([".posting-categories .location", ".location"])
    job.workMode = workModeFrom(pick([".posting-categories .workplaceTypes", ".workplaceTypes"]))
    job.description = block([".section-wrapper.page-full-width", '[data-qa="job-description"]'])
    job.company =
      clean(meta("og:title").split(" - ")[0]) ||
      clean(document.title.split(" - ")[0]) ||
      companyFromPath()
    return job
  }

  const greenhouseJob = () => {
    const job = emptyJob()
    job.source = "Greenhouse"
    job.jobUrl = linkUrl.split("#")[0] ?? linkUrl
    job.jobId = path.match(/\/jobs\/(\d+)/)?.[1] ?? params.get("gh_jid") ?? ""
    job.role = pick([".job__title h1", ".app-title", "h1"])
    job.location = pick([".job__location", ".location"])
    job.company = pick([".company-name"]).replace(/^at\s+/i, "") || companyFromPath()
    job.description = block([".job__description", "#content"])
    return job
  }

  const ashbyJob = () => {
    const job = emptyJob()
    job.source = "Ashby"
    job.jobUrl = linkUrl.replace(/\/application\/?$/, "")
    job.jobId = path.split("/").filter(Boolean)[1] ?? ""
    job.role = pick(['[class*="_title_"]', "h1"])
    job.company = companyFromPath()
    return job
  }

  const workdayJob = () => {
    const job = emptyJob()
    job.source = "Workday"
    job.jobUrl = linkUrl.split("?")[0] ?? linkUrl
    job.role = pick(['[data-automation-id="jobPostingHeader"]', "h2", "h1"])
    job.location = pick([
      '[data-automation-id="locations"] dd',
      '[data-automation-id="locations"]',
    ]).replace(/^locations\s*/i, "")
    job.workMode = workModeFrom(
      pick(['[data-automation-id="remoteType"] dd', '[data-automation-id="remoteType"]']),
    )
    job.jobId = pick([
      '[data-automation-id="requisitionId"] dd',
      '[data-automation-id="requisitionId"]',
    ]).replace(/^job requisition id\s*/i, "")
    job.description = block(['[data-automation-id="jobPostingDescription"]'])
    // Tenant subdomain: acme.wd5.myworkdayjobs.com → "Acme".
    job.company = titleCase(url.hostname.split(".")[0] ?? "")
    return job
  }

  const site = siteOf(url)
  const segments = path.split("/").filter(Boolean)
  let job: ExtractedJobFields
  let matched = true
  if (site === "LinkedIn" && (path.startsWith("/jobs") || params.has("currentJobId"))) {
    job = linkedInJob()
  } else if (site === "Naukri" && /job-listings|\/job\//.test(path)) {
    job = naukriJob()
  } else if (site === "Indeed" && (params.has("vjk") || params.has("jk") || /viewjob/.test(path))) {
    job = indeedJob()
  } else if (site === "Lever" && segments.length >= 2) {
    job = leverJob()
  } else if (site === "Greenhouse" && /\/jobs\/\d+/.test(path + url.search)) {
    job = greenhouseJob()
  } else if (site === "Ashby" && segments.length >= 2) {
    job = ashbyJob()
  } else if (site === "Workday" && /\/job\//.test(path)) {
    job = workdayJob()
  } else {
    matched = false
    job = emptyJob()
    job.jobUrl = linkUrl.split("#")[0] ?? linkUrl
    job.source = site || clean(meta("og:site_name")) || host
  }

  const posting = findJobPosting(document)
  fill(job, fromJobPosting(posting))

  // Generic fallbacks for career pages without structured data.
  const jobish = /\b(jobs?|careers?|positions?|openings?|vacanc(y|ies)|apply)\b/i.test(
    `${host} ${path}`,
  )
  if (matched || posting || jobish) {
    fill(job, {
      role: pick(["h1"]) || clean(meta("og:title").split(/ [|\-–] /)[0]),
      company: meta("og:site_name"),
    })
  }
  if (!job.workMode) job.workMode = workModeFrom(job.location)

  const kind = matched || posting || (jobish && job.role) ? "job" : "unknown"
  return { kind, site, job: capJob(job) }
}
