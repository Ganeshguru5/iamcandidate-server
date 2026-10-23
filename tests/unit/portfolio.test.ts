import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { handler } from "../../src/functions/users"
import { resetConfig } from "../../src/lib/config"
import { hashPassword } from "../../src/lib/passwords"
import { usersRepository } from "../../src/repositories/dynamodb"
import type { PortfolioContent, PortfolioInput } from "../../src/schemas/portfolio"
import { call } from "../support/http"

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

  it("rejects other accounts, even knot admins, and anonymous callers", async () => {
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
})
