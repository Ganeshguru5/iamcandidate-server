import { AppError } from "../lib/errors"
import { clean, parseDocument } from "../lib/job-page"
import { fetchPublic, publicHttpUrl, type FetchedPage, type FetchOptions } from "../lib/network"

/**
 * Reads a person from a profile link, for the chat's "add contact" cards.
 * GitHub profiles come from GitHub's public API; LinkedIn and other pages from
 * their schema.org `Person` data, then the page title. LinkedIn often refuses
 * logged-out requests (status 999) — the chat then lets the user fill it in.
 */

export interface ExtractedContactFields {
  name: string
  role: string
  company: string
  location: string
  email: string
  phone: string
  linkedin: string
  website: string
  /** Short bio / headline, for the contact's notes. */
  about: string
}

export interface ContactExtraction {
  url: string
  /** "profile" when a person was recognised. */
  kind: "profile" | "unknown"
  /** "LinkedIn", "GitHub" or "" (any other page). */
  site: string
  contact: ExtractedContactFields
}

type Fetcher = (url: string, options?: FetchOptions) => Promise<FetchedPage>
type Json = Record<string, unknown>

const emptyContact = (): ExtractedContactFields => ({
  name: "",
  role: "",
  company: "",
  location: "",
  email: "",
  phone: "",
  linkedin: "",
  website: "",
  about: "",
})

const str = (value: unknown) =>
  typeof value === "string" || typeof value === "number" ? clean(value) : ""
const first = (value: unknown) => (Array.isArray(value) ? value[0] : value)

/** Splits a headline like "Senior Recruiter at Acme | Hiring" into role and company. */
export function fromHeadline(headline: string): { role: string; company: string } {
  const main = clean(headline.split(/\s[|•·]\s/)[0])
  const at = main.match(/^(.+?)\s+(?:at|@)\s+(.+)$/i)
  if (at) return { role: clean(at[1]), company: clean(at[2]) }
  return { role: main, company: "" }
}

/** LinkedIn profile slug from /in/<slug>, or "". */
export function linkedInSlug(url: URL): string {
  if (!url.hostname.replace(/^www\./, "").endsWith("linkedin.com")) return ""
  return decodeURIComponent(url.pathname.match(/^\/in\/([^/]+)/)?.[1] ?? "")
}

/** GitHub user from github.com/<user> (not repos or site pages), or "". */
export function gitHubUser(url: URL): string {
  if (url.hostname.replace(/^www\./, "") !== "github.com") return ""
  const segments = url.pathname.split("/").filter(Boolean)
  const user = segments[0] ?? ""
  const reserved =
    /^(orgs|topics|features|pricing|about|enterprise|marketplace|explore|settings|login|join|sponsors|collections|trending|search|issues|pulls|notifications|apps|site|security|customer-stories|readme|team|contact)$/i
  return segments.length === 1 && /^[a-z\d](?:[a-z\d-]{0,38})$/i.test(user) && !reserved.test(user)
    ? user
    : ""
}

function findPerson(html: string): Json | undefined {
  const document = parseDocument(html)
  const found: Json[] = []
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return
    if (Array.isArray(node)) return node.forEach(visit)
    const type = (node as Json)["@type"]
    if (type === "Person" || (Array.isArray(type) && type.includes("Person")))
      found.push(node as Json)
    if ((node as Json)["@graph"]) visit((node as Json)["@graph"])
    // ProfilePage wraps the person in mainEntity.
    if ((node as Json).mainEntity) visit((node as Json).mainEntity)
  }
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      visit(JSON.parse(script.textContent ?? ""))
    } catch {
      // Ignore malformed blocks.
    }
  }
  return found.find((person) => str(person.name))
}

/** Contact fields from a page: schema.org Person, then og:title / <title>. */
export function extractContactFromHtml(html: string, link: string): ContactExtraction {
  const url = new URL(link)
  const slug = linkedInSlug(url)
  const site = slug ? "LinkedIn" : ""
  const contact = emptyContact()
  if (slug) contact.linkedin = `https://www.linkedin.com/in/${slug}/`
  else contact.website = link

  const person = findPerson(html)
  if (person) {
    // Current employer: the first one without an end date.
    const employers = ([] as unknown[]).concat(person.worksFor ?? []) as Json[]
    const current =
      employers.find((org) => !(org.member as Json | undefined)?.endDate) ?? employers[0]
    const address = first(person.address) as Json | string | undefined
    contact.name = str(person.name)
    contact.role = str(first(person.jobTitle))
    contact.company = str(typeof current === "string" ? current : current?.name)
    contact.location = typeof address === "string" ? clean(address) : str(address?.addressLocality)
    contact.email = str(person.email).replace(/^mailto:/i, "")
    contact.phone = str(person.telephone)
    contact.about = str(person.description).slice(0, 500)
  }

  // "Name - Headline | LinkedIn", "Name – Role at Company"
  const document = parseDocument(html)
  const title = clean(
    document.querySelector('meta[property="og:title"]')?.getAttribute("content") ?? document.title,
  ).replace(/\s*\|\s*LinkedIn\s*$/i, "")
  const [titleName, ...rest] = title.split(/\s[-–—]\s/)
  if (!contact.name && slug && titleName) contact.name = clean(titleName)
  // Other sites' titles ("Acme - Careers") aren't a person's headline.
  if ((slug || person) && (!contact.role || !contact.company) && rest.length) {
    const headline = fromHeadline(rest.join(" - "))
    if (!contact.role) contact.role = headline.role
    if (!contact.company) contact.company = headline.company
  }

  for (const key of Object.keys(contact) as (keyof ExtractedContactFields)[]) {
    contact[key] = contact[key].slice(0, key === "about" ? 500 : 200)
  }
  return { url: link, kind: contact.name ? "profile" : "unknown", site, contact }
}

function statusError(status: number, host: string): AppError {
  if (status === 404 || status === 410) {
    return new AppError(502, "INTEGRATION_ERROR", "That profile wasn't found.")
  }
  if (status === 401 || status === 403 || status === 429 || status === 999) {
    return new AppError(
      502,
      "INTEGRATION_ERROR",
      `${host} didn't share that profile with knot. Fill in the details yourself, or use the knot browser extension on the profile.`,
    )
  }
  return new AppError(502, "INTEGRATION_ERROR", `${host} answered with an error (${status})`)
}

export function createContactExtractor(fetcher: Fetcher = fetchPublic) {
  async function gitHub(user: string, link: string): Promise<ContactExtraction> {
    const page = await fetcher(`https://api.github.com/users/${encodeURIComponent(user)}`, {
      accept: "application/vnd.github+json",
    })
    if (page.status !== 200) throw statusError(page.status, "GitHub")
    const data = JSON.parse(page.body) as Json
    const blog = str(data.blog)
    const contact: ExtractedContactFields = {
      ...emptyContact(),
      name: str(data.name) || str(data.login) || user,
      // "@acme" → "Acme" stays as written, minus the handle sign.
      company: str(data.company).replace(/^@/, ""),
      location: str(data.location),
      email: str(data.email),
      website: blog ? (/^https?:\/\//i.test(blog) ? blog : `https://${blog}`) : link,
      about: str(data.bio).slice(0, 500),
    }
    return { url: link, kind: "profile", site: "GitHub", contact }
  }

  return {
    async extract(raw: string): Promise<ContactExtraction> {
      const url = publicHttpUrl(raw)
      const user = gitHubUser(url)
      if (user) return gitHub(user, url.toString())

      // Regional hosts (in.linkedin.com) are refused far more often than www.
      const slug = linkedInSlug(url)
      const target = slug
        ? `https://www.linkedin.com/in/${encodeURIComponent(slug)}/`
        : url.toString()
      const page = await fetcher(target)
      const host = slug ? "LinkedIn" : url.hostname.replace(/^www\./, "")
      if (page.status >= 400) throw statusError(page.status, host)
      // A logged-out LinkedIn visit can land on the sign-in wall.
      if (slug && /\/(authwall|login|checkpoint)/.test(new URL(page.url).pathname)) {
        throw statusError(999, host)
      }
      return extractContactFromHtml(page.body, slug ? target : page.url)
    },
  }
}

export const contactExtractService = createContactExtractor()
