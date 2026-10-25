import { describe, expect, it } from "vitest"

import { handler } from "../../src/functions/career"
import { extractJobFromHtml } from "../../src/lib/job-page"
import { isPrivateAddress, publicHttpUrl, type FetchedPage } from "../../src/lib/network"
import { createJobExtractor } from "../../src/services/job-extract.service"
import { call } from "../support/http"

/** Fake fetcher: answers from `routes` by exact URL and records what was asked. */
function fakeFetch(routes: Record<string, Partial<FetchedPage> & { json?: unknown }>) {
  const calls: string[] = []
  const fetcher = async (url: string): Promise<FetchedPage> => {
    calls.push(url)
    const route = routes[url]
    if (!route) return { url, status: 404, contentType: "text/html", body: "" }
    return {
      url: route.url ?? url,
      status: route.status ?? 200,
      contentType: route.contentType ?? (route.json ? "application/json" : "text/html"),
      body: route.json ? JSON.stringify(route.json) : (route.body ?? ""),
    }
  }
  return { fetcher, calls }
}

describe("job link extraction", () => {
  it("reads Greenhouse jobs from the job board API", async () => {
    const { fetcher, calls } = fakeFetch({
      "https://boards-api.greenhouse.io/v1/boards/acme/jobs/4012345": {
        json: {
          id: 4012345,
          title: "Senior Frontend Engineer",
          company_name: "Acme Inc",
          location: { name: "Remote - India" },
          absolute_url: "https://job-boards.greenhouse.io/acme/jobs/4012345",
          content:
            "&lt;p&gt;Build things &amp;amp; ship.&lt;/p&gt;&lt;ul&gt;&lt;li&gt;React&lt;/li&gt;&lt;/ul&gt;",
        },
      },
    })
    const result = await createJobExtractor(fetcher).extract(
      "https://job-boards.greenhouse.io/acme/jobs/4012345?gh_src=abc",
    )
    expect(calls).toEqual(["https://boards-api.greenhouse.io/v1/boards/acme/jobs/4012345"])
    expect(result).toMatchObject({ kind: "job", site: "Greenhouse", via: "api" })
    expect(result.job).toMatchObject({
      role: "Senior Frontend Engineer",
      company: "Acme Inc",
      location: "Remote - India",
      workMode: "remote",
      jobId: "4012345",
      source: "Greenhouse",
      jobUrl: "https://job-boards.greenhouse.io/acme/jobs/4012345",
    })
    expect(result.job.description).toBe("Build things & ship.\n• React")
  })

  it("reads Lever jobs with workplace type and salary", async () => {
    const { fetcher } = fakeFetch({
      "https://api.lever.co/v0/postings/brightwave/0a1b-2c3d": {
        json: {
          id: "0a1b-2c3d",
          text: "Product Designer",
          categories: { location: "Bengaluru" },
          workplaceType: "hybrid",
          description: "<div>Design the product.</div>",
          lists: [{ text: "What you'll do", content: "<li>Research</li><li>Prototype</li>" }],
          salaryRange: { currency: "INR", interval: "per-year-salary", min: 2000000, max: 3000000 },
          hostedUrl: "https://jobs.lever.co/brightwave/0a1b-2c3d",
        },
      },
    })
    const result = await createJobExtractor(fetcher).extract(
      "https://jobs.lever.co/brightwave/0a1b-2c3d/apply",
    )
    expect(result.job).toMatchObject({
      role: "Product Designer",
      company: "Brightwave",
      location: "Bengaluru",
      workMode: "hybrid",
      salary: "INR 2000000–3000000 / year",
      jobUrl: "https://jobs.lever.co/brightwave/0a1b-2c3d",
    })
    expect(result.job.description).toContain("What you'll do\n• Research\n• Prototype")
  })

  it("finds the posting on an Ashby job board", async () => {
    const { fetcher } = fakeFetch({
      "https://api.ashbyhq.com/posting-api/job-board/cobalt-cloud?includeCompensation=true": {
        json: {
          jobs: [
            { id: "other", title: "Other" },
            {
              id: "f00d",
              title: "Platform Engineer",
              location: "London",
              workplaceType: "OnSite",
              descriptionHtml: "<p>Run the platform.</p>",
              compensation: { compensationTierSummary: "£80K – £100K" },
            },
          ],
        },
      },
    })
    const result = await createJobExtractor(fetcher).extract(
      "https://jobs.ashbyhq.com/cobalt-cloud/f00d",
    )
    expect(result.job).toMatchObject({
      role: "Platform Engineer",
      company: "Cobalt Cloud",
      workMode: "onsite",
      salary: "£80K – £100K",
      jobUrl: "https://jobs.ashbyhq.com/cobalt-cloud/f00d",
    })
  })

  it("reads Workday jobs through the CXS API", async () => {
    const { fetcher, calls } = fakeFetch({
      "https://dashcart.wd5.myworkdayjobs.com/wday/cxs/dashcart/External/job/Chennai/Backend-Engineer_R1234":
        {
          json: {
            jobPostingInfo: {
              title: "Backend Engineer",
              location: "Chennai",
              remoteType: "Hybrid",
              jobReqId: "R1234",
              jobDescription: "<p>APIs.</p>",
            },
            hiringOrganization: { name: "DashCart" },
          },
        },
    })
    const result = await createJobExtractor(fetcher).extract(
      "https://dashcart.wd5.myworkdayjobs.com/en-US/External/job/Chennai/Backend-Engineer_R1234",
    )
    expect(calls[0]).toContain("/wday/cxs/dashcart/External/job/Chennai/Backend-Engineer_R1234")
    expect(result.job).toMatchObject({
      role: "Backend Engineer",
      company: "DashCart",
      workMode: "hybrid",
      jobId: "R1234",
    })
  })

  it("reads LinkedIn jobs from the guest job page", async () => {
    const { fetcher, calls } = fakeFetch({
      "https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/3912345678": {
        body: `
          <section class="top-card-layout">
            <h2 class="top-card-layout__title">Full Stack Developer</h2>
            <a class="topcard__org-name-link" href="https://www.linkedin.com/company/freshpath">FreshPath</a>
            <span class="topcard__flavor topcard__flavor--bullet">Pune, Maharashtra, India</span>
          </section>
          <div class="show-more-less-html__markup"><p>We are hiring a full stack developer to build our platform.</p></div>`,
      },
    })
    const result = await createJobExtractor(fetcher).extract(
      "https://www.linkedin.com/jobs/search/?currentJobId=3912345678&keywords=react",
    )
    expect(calls).toEqual(["https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/3912345678"])
    expect(result).toMatchObject({ kind: "job", site: "LinkedIn", via: "page" })
    expect(result.job).toMatchObject({
      role: "Full Stack Developer",
      company: "FreshPath",
      location: "Pune, Maharashtra, India",
      jobId: "3912345678",
      jobUrl: "https://www.linkedin.com/jobs/view/3912345678/",
    })
    expect(result.job.description).toContain("full stack developer")
  })

  it("falls back to the page's JobPosting data when a job API fails", async () => {
    const page = `<html><head><title>Careers</title>
      <script type="application/ld+json">${JSON.stringify({
        "@context": "https://schema.org",
        "@graph": [
          {
            "@type": "JobPosting",
            title: "Data Analyst",
            hiringOrganization: { "@type": "Organization", name: "Acme" },
            jobLocation: { address: { addressLocality: "Chennai", addressCountry: "IN" } },
            jobLocationType: "TELECOMMUTE",
            baseSalary: {
              currency: "INR",
              value: { minValue: 10, maxValue: 15, unitText: "LAKH" },
            },
            description: "<p>Analyse data.</p>",
          },
        ],
      })}</script></head><body></body></html>`
    const { fetcher } = fakeFetch({ "https://boards.greenhouse.io/acme/jobs/77": { body: page } })
    const result = await createJobExtractor(fetcher).extract(
      "https://boards.greenhouse.io/acme/jobs/77",
    )
    expect(result).toMatchObject({ kind: "job", via: "page" })
    expect(result.job).toMatchObject({
      role: "Data Analyst",
      company: "Acme",
      location: "Chennai, IN",
      workMode: "remote",
      salary: "INR 10–15 / lakh",
      description: "Analyse data.",
    })
  })

  it("reads generic career pages from meta tags and returns unknown for other pages", () => {
    const career = extractJobFromHtml(
      `<html><head><meta property="og:site_name" content="Brightwave"></head><body><h1>QA Engineer</h1></body></html>`,
      "https://brightwave.example.com/careers/qa-engineer",
    )
    expect(career).toMatchObject({
      kind: "job",
      job: { role: "QA Engineer", company: "Brightwave" },
    })

    const blog = extractJobFromHtml(
      "<html><body><p>Hello</p></body></html>",
      "https://example.com/blog/post",
    )
    expect(blog.kind).toBe("unknown")
  })

  it("explains pages that block the request", async () => {
    const { fetcher } = fakeFetch({ "https://www.indeed.com/viewjob?jk=abc": { status: 403 } })
    await expect(
      createJobExtractor(fetcher).extract("https://www.indeed.com/viewjob?jk=abc"),
    ).rejects.toThrow(/didn't let knot read that page/)
  })
})

describe("public URL guard", () => {
  it("flags private and reserved addresses", () => {
    for (const address of [
      "127.0.0.1",
      "10.1.2.3",
      "172.20.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "::1",
      "fd00::1",
      "::ffff:127.0.0.1",
    ]) {
      expect(isPrivateAddress(address), address).toBe(true)
    }
    for (const address of ["8.8.8.8", "172.32.0.1", "2606:4700::1111"]) {
      expect(isPrivateAddress(address), address).toBe(false)
    }
  })

  it("only accepts public http(s) links", () => {
    expect(publicHttpUrl(" https://jobs.lever.co/acme/1 ").hostname).toBe("jobs.lever.co")
    for (const bad of [
      "ftp://x.com/a",
      "file:///etc/passwd",
      "http://localhost:3001/",
      "http://169.254.169.254/latest",
      "https://user:pw@x.com",
      "http://x.com:8080/",
      "not a url",
    ]) {
      expect(() => publicHttpUrl(bad), bad).toThrow()
    }
  })

  it("rejects private links through the API", async () => {
    const res = await call(handler, "POST", "/applications/extract", {
      body: { url: "http://169.254.169.254/latest/meta-data" },
    })
    expect(res.status).toBe(400)
    expect(res.body.error?.message).toMatch(/private address/)

    const missing = await call(handler, "POST", "/applications/extract", { body: {} })
    expect(missing.status).toBe(400)
  })
})
