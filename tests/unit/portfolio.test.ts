import { CopyObjectCommand } from "@aws-sdk/client-s3"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { handler } from "../../src/functions/users"
import { resetConfig } from "../../src/lib/config"
import { hashPassword } from "../../src/lib/passwords"
import { repositories, usersRepository } from "../../src/repositories/dynamodb"
import type { PortfolioContent, PortfolioInput } from "../../src/schemas/portfolio"
import { call } from "../support/http"
import { testState } from "../support/setup"

const SECRET = "test-secret-that-is-long-enough-for-hmac-signing"

async function addAccount(id: string, email: string, role: "admin" | "user") {
  await usersRepository.upsert({
    id,
    email,
    name: id,
    role,
    disabled: false,
    passwordHash: await hashPassword("password-123"),
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  })
}

async function tokenFor(email: string) {
  const res = await call<{ token: string }>(handler, "POST", "/auth/login", {
    body: { email, password: "password-123" },
  })
  return res.body.data?.token as string
}

const content: PortfolioInput = {
  profile: {
    name: "Ganeshguru A",
    role: "Full-stack developer",
    availability: "Available",
    intro: "I build things.",
    aiHeading: "AI",
    aiBlurb: "",
    aiSkills: ["RAG"],
    about: ["Paragraph one."],
    readout: [{ key: "Based", value: "Chennai" }],
    email: "ganeshguru8681@gmail.com",
    phone: "",
    location: "Chennai",
    resumeUrl: "/resume.pdf",
    photo: "/Images/profile.png",
    socials: [{ label: "GitHub", href: "https://github.com/Ganeshguru5" }],
    education: { degree: "BE", school: "KCET", years: "2020 — 2023", grade: "" },
    contactTitle: "Hi",
    contactBody: "",
  },
  experience: [
    {
      title: "Developer",
      company: "Apeiron",
      location: "Chennai",
      exp: "2025 — Present",
      description: "",
      image: "",
      skills: ["Next.js"],
      current: true,
    },
  ],
  projects: [
    {
      slug: "stamin",
      title: "Stamin",
      description: "",
      detail: [],
      highlights: [],
      image: "",
      href: "",
      meta: "",
      tags: [],
      span: "md:col-span-4",
    },
  ],
  agentSkills: [],
  toolkit: [{ group: "Languages", items: ["TypeScript"] }],
  testimonials: [],
}

beforeEach(async () => {
  process.env.AUTH_SECRET = SECRET
  resetConfig()
  await addAccount("usr_owner", "ganeshguru8681@gmail.com", "user")
  await addAccount("usr_admin", "admin@example.com", "admin")
})

afterEach(() => {
  delete process.env.AUTH_SECRET
  resetConfig()
})

describe("portfolio", () => {
  it("returns null publicly until the owner saves", async () => {
    const res = await call<PortfolioContent | null>(handler, "GET", "/portfolio")
    expect(res.status).toBe(200)
    expect(res.body.data).toBeNull()
  })

  it("lets the owner save content that the public route then serves", async () => {
    const owner = await tokenFor("ganeshguru8681@gmail.com")
    const saved = await call<PortfolioContent>(handler, "PUT", "/admin/portfolio", {
      body: content,
      token: owner,
    })
    expect(saved.status).toBe(200)
    expect(saved.body.data?.updatedAt).toBeDefined()

    const pub = await call<PortfolioContent>(handler, "GET", "/portfolio")
    expect(pub.body.data?.profile.name).toBe("Ganeshguru A")
    expect(pub.body.data?.experience[0]?.current).toBe(true)
    expect(pub.body.data).not.toHaveProperty("PK")
  })

  it("rejects other accounts, even IamCandidate admins, and anonymous callers", async () => {
    const admin = await tokenFor("admin@example.com")
    const res = await call(handler, "PUT", "/admin/portfolio", { body: content, token: admin })
    expect(res.status).toBe(403)

    const anon = await call(handler, "PUT", "/admin/portfolio", { body: content })
    expect(anon.status).toBe(401)
  })

  it("validates the body", async () => {
    const owner = await tokenFor("ganeshguru8681@gmail.com")
    const res = await call(handler, "PUT", "/admin/portfolio", {
      body: { ...content, projects: [{ ...content.projects[0], slug: "Not A Slug" }] },
      token: owner,
    })
    expect(res.status).toBe(400)
  })

  describe("image uploads", () => {
    const image = { fileName: "My Photo.png", contentType: "image/png", sizeBytes: 2048 }

    beforeEach(() => {
      process.env.PORTFOLIO_BUCKET = "personal-os-portfolio-test"
      process.env.PORTFOLIO_ASSETS_URL = "https://assets.example.com/"
      resetConfig()
    })

    afterEach(() => {
      delete process.env.PORTFOLIO_BUCKET
      delete process.env.PORTFOLIO_ASSETS_URL
    })

    it("gives the owner a presigned PUT and the public URL", async () => {
      const owner = await tokenFor("ganeshguru8681@gmail.com")
      const res = await call<{ uploadUrl: string; url: string; headers: Record<string, string> }>(
        handler,
        "POST",
        "/admin/portfolio/upload-url",
        { body: image, token: owner },
      )
      expect(res.status).toBe(200)
      expect(res.body.data?.url).toMatch(
        /^https:\/\/assets\.example\.com\/portfolio\/img_[\w-]+\/My-Photo\.png$/,
      )
      expect(res.body.data?.uploadUrl).toContain("personal-os-portfolio-test")
      expect(res.body.data?.headers["Content-Type"]).toBe("image/png")
    })

    it("rejects other accounts and non-images", async () => {
      const admin = await tokenFor("admin@example.com")
      const forbidden = await call(handler, "POST", "/admin/portfolio/upload-url", {
        body: image,
        token: admin,
      })
      expect(forbidden.status).toBe(403)

      const owner = await tokenFor("ganeshguru8681@gmail.com")
      const svg = await call(handler, "POST", "/admin/portfolio/upload-url", {
        body: { ...image, contentType: "image/svg+xml" },
        token: owner,
      })
      expect(svg.status).toBe(400)
    })

    it("explains when uploads aren't configured", async () => {
      delete process.env.PORTFOLIO_BUCKET
      resetConfig()
      const owner = await tokenFor("ganeshguru8681@gmail.com")
      const res = await call(handler, "POST", "/admin/portfolio/upload-url", {
        body: image,
        token: owner,
      })
      expect(res.status).toBe(503)
    })
  })

  describe("resume sync", () => {
    const now = "2026-10-20T00:00:00.000Z"

    async function seedResume(documentId?: string) {
      await repositories.resumes.create("usr_owner", {
        id: "res_0000000000000001",
        title: "LaTeX resume",
        targetRole: "Software Engineer",
        version: "v1.3",
        isDefault: false,
        summary: "",
        skills: [],
        experience: [],
        education: [],
        ...(documentId ? { documentId } : {}),
        createdAt: now,
        updatedAt: now,
      })
    }

    async function seedPdf() {
      await repositories.documents.create("usr_owner", {
        id: "doc_0000000000000001",
        name: "resume.pdf",
        category: "resume",
        kind: "pdf",
        sizeBytes: 1024,
        starred: false,
        source: "local",
        mimeType: "application/pdf",
        s3Key: "users/usr_owner/documents/doc_0000000000000001/resume.pdf",
        uploadedAt: now,
        updatedAt: now,
      })
    }

    beforeEach(() => {
      process.env.PORTFOLIO_BUCKET = "personal-os-portfolio-test"
      process.env.PORTFOLIO_ASSETS_URL = "https://assets.example.com"
      resetConfig()
    })

    afterEach(() => {
      delete process.env.PORTFOLIO_BUCKET
      delete process.env.PORTFOLIO_ASSETS_URL
    })

    it("copies the resume PDF to the public bucket and links it", async () => {
      const sent: unknown[] = []
      testState.s3Send = async (command) => {
        sent.push(command)
        return {}
      }
      const owner = await tokenFor("ganeshguru8681@gmail.com")
      await call(handler, "PUT", "/admin/portfolio", { body: content, token: owner })
      await seedPdf()
      await seedResume("doc_0000000000000001")

      const res = await call<PortfolioContent>(handler, "POST", "/admin/portfolio/resume", {
        body: { resumeId: "res_0000000000000001" },
        token: owner,
      })
      expect(res.status).toBe(200)
      const url = res.body.data?.profile.resumeUrl
      expect(url).toMatch(/^https:\/\/assets\.example\.com\/portfolio\/resume_\w+\/Ganeshguru-A-Resume\.pdf$/)
      expect(res.body.data?.resume).toMatchObject({ resumeId: "res_0000000000000001", version: "v1.3" })

      const copy = sent.find((c) => c instanceof CopyObjectCommand) as CopyObjectCommand
      expect(copy.input.Bucket).toBe("personal-os-portfolio-test")
      expect(copy.input.CopySource).toBe(
        "personal-os-documents-test/users/usr_owner/documents/doc_0000000000000001/resume.pdf",
      )
      expect(copy.input.ContentDisposition).toContain("attachment")

      // A later save keeps the link while the URL is unchanged, and drops it once edited.
      const kept = await call<PortfolioContent>(handler, "PUT", "/admin/portfolio", {
        body: { ...content, profile: { ...content.profile, resumeUrl: url } },
        token: owner,
      })
      expect(kept.body.data?.resume?.resumeId).toBe("res_0000000000000001")
      const dropped = await call<PortfolioContent>(handler, "PUT", "/admin/portfolio", {
        body: content,
        token: owner,
      })
      expect(dropped.body.data?.resume).toBeUndefined()
    })

    it("needs a saved PDF and a saved portfolio", async () => {
      const owner = await tokenFor("ganeshguru8681@gmail.com")
      await seedResume()
      const unsaved = await call(handler, "POST", "/admin/portfolio/resume", {
        body: { resumeId: "res_0000000000000001" },
        token: owner,
      })
      expect(unsaved.status).toBe(409)

      await call(handler, "PUT", "/admin/portfolio", { body: content, token: owner })
      const noPdf = await call(handler, "POST", "/admin/portfolio/resume", {
        body: { resumeId: "res_0000000000000001" },
        token: owner,
      })
      expect(noPdf.status).toBe(400)
    })

    it("is owner only", async () => {
      const admin = await tokenFor("admin@example.com")
      const res = await call(handler, "POST", "/admin/portfolio/resume", {
        body: { resumeId: "res_0000000000000001" },
        token: admin,
      })
      expect(res.status).toBe(403)
    })
  })
})
