import { describe, expect, it } from "vitest"

import { handler } from "../../src/functions/career"
import type { FetchedPage } from "../../src/lib/network"
import {
  createContactExtractor,
  extractContactFromHtml,
  fromHeadline,
  gitHubUser,
} from "../../src/services/contact-extract.service"
import { call } from "../support/http"

function fakeFetch(routes: Record<string, Partial<FetchedPage>>) {
  const calls: string[] = []
  const fetcher = async (url: string): Promise<FetchedPage> => {
    calls.push(url)
    const route = routes[url] ?? { status: 404 }
    return {
      url: route.url ?? url,
      status: route.status ?? 200,
      contentType: "text/html",
      body: route.body ?? "",
    }
  }
  return { fetcher, calls }
}

const linkedInProfile = `<html><head>
  <meta property="og:title" content="Priya Raman - Senior Technical Recruiter at Brightwave | LinkedIn">
  <script type="application/ld+json">${JSON.stringify({
    "@context": "http://schema.org",
    "@graph": [
      {
        "@type": "Person",
        name: "Priya Raman",
        jobTitle: ["Senior Technical Recruiter", "Recruiter"],
        worksFor: [
          { "@type": "Organization", name: "OldCo", member: { endDate: 2021 } },
          { "@type": "Organization", name: "Brightwave ", member: { startDate: 2021 } },
        ],
        address: { addressLocality: "Chennai, Tamil Nadu, India" },
      },
    ],
  })}</script></head><body></body></html>`

describe("contact link extraction", () => {
  it("reads LinkedIn profiles from their Person data, on the www host", async () => {
    const { fetcher, calls } = fakeFetch({
      "https://www.linkedin.com/in/priya-raman/": { body: linkedInProfile },
    })
    const result = await createContactExtractor(fetcher).extract(
      "https://in.linkedin.com/in/priya-raman?trk=public",
    )
    expect(calls).toEqual(["https://www.linkedin.com/in/priya-raman/"])
    expect(result).toMatchObject({ kind: "profile", site: "LinkedIn" })
    expect(result.contact).toMatchObject({
      name: "Priya Raman",
      role: "Senior Technical Recruiter",
      company: "Brightwave",
      location: "Chennai, Tamil Nadu, India",
      linkedin: "https://www.linkedin.com/in/priya-raman/",
    })
  })

  it("falls back to the LinkedIn page title", () => {
    const result = extractContactFromHtml(
      `<html><head><meta property="og:title" content="Arun Kumar - Engineering Manager @ DashCart | Hiring | LinkedIn"></head></html>`,
      "https://www.linkedin.com/in/arun-kumar/",
    )
    expect(result.contact).toMatchObject({
      name: "Arun Kumar",
      role: "Engineering Manager",
      company: "DashCart",
    })
  })

  it("explains when LinkedIn refuses or shows the sign-in wall", async () => {
    const blocked = fakeFetch({ "https://www.linkedin.com/in/someone/": { status: 999 } })
    await expect(
      createContactExtractor(blocked.fetcher).extract("https://www.linkedin.com/in/someone"),
    ).rejects.toThrow(/didn't share that profile/)

    const wall = fakeFetch({
      "https://www.linkedin.com/in/someone/": {
        url: "https://www.linkedin.com/authwall?trk=x",
        body: "<html></html>",
      },
    })
    await expect(
      createContactExtractor(wall.fetcher).extract("https://www.linkedin.com/in/someone/"),
    ).rejects.toThrow(/didn't share that profile/)
  })

  it("reads GitHub profiles from the API", async () => {
    const { fetcher, calls } = fakeFetch({
      "https://api.github.com/users/octo-dev": {
        body: JSON.stringify({
          login: "octo-dev",
          name: "Octo Dev",
          company: "@cobaltcloud",
          location: "Bengaluru",
          email: "octo@example.com",
          blog: "octo.dev",
          bio: "Platform engineer",
        }),
      },
    })
    const result = await createContactExtractor(fetcher).extract("https://github.com/octo-dev")
    expect(calls).toEqual(["https://api.github.com/users/octo-dev"])
    expect(result).toMatchObject({ kind: "profile", site: "GitHub" })
    expect(result.contact).toMatchObject({
      name: "Octo Dev",
      company: "cobaltcloud",
      email: "octo@example.com",
      website: "https://octo.dev",
      about: "Platform engineer",
    })
  })

  it("only treats single-segment GitHub paths as profiles", () => {
    expect(gitHubUser(new URL("https://github.com/torvalds"))).toBe("torvalds")
    expect(gitHubUser(new URL("https://github.com/torvalds/linux"))).toBe("")
    expect(gitHubUser(new URL("https://github.com/pricing"))).toBe("")
  })

  it("ignores other pages' titles when there's no Person data", () => {
    const result = extractContactFromHtml(
      "<html><head><title>Acme - Careers</title></head></html>",
      "https://acme.example.com/",
    )
    expect(result).toMatchObject({ kind: "unknown", contact: { name: "", role: "", company: "" } })
  })

  it("splits headlines into role and company", () => {
    expect(fromHeadline("Senior Recruiter at Acme | Hiring")).toEqual({
      role: "Senior Recruiter",
      company: "Acme",
    })
    expect(fromHeadline("Founder")).toEqual({ role: "Founder", company: "" })
  })

  it("rejects private links through the API", async () => {
    const res = await call(handler, "POST", "/contacts/extract", {
      body: { url: "http://10.0.0.5/admin" },
    })
    expect(res.status).toBe(400)
  })
})
