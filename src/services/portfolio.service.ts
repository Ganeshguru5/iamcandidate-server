import { getConfig } from "../lib/config"
import { AppError, BadRequestError, ConflictError, NotFoundError } from "../lib/errors"
import { createId, nowIso } from "../lib/ids"
import { repositories, usersRepository } from "../repositories/dynamodb"
import { getItem, putItem, stripKeys } from "../repositories/dynamodb/table"
import { UPLOAD_URL_TTL_SECONDS } from "../repositories/s3/files.repository"
import {
  portfolioAssetKey,
  portfolioAssetsRepository,
} from "../repositories/s3/portfolio-assets.repository"
import type {
  ImageUploadInput,
  PortfolioContent,
  PortfolioInput,
  ResumeSyncInput,
} from "../schemas/portfolio"
import { resumesService } from "./resumes.service"

/** One site-wide item, outside any user's partition. */
const KEY = { PK: "GLOBAL", SK: "PORTFOLIO" }

/** The only IamCandidate account allowed to edit the portfolio. */
export const PORTFOLIO_OWNER_EMAIL = "ganeshguru8681@gmail.com"

export const portfolioService = {
  /**
   * The saved content, or null if it was never saved — the portfolio then
   * keeps showing the defaults built into its static site.
   */
  async get(): Promise<PortfolioContent | null> {
    const item = await getItem(KEY)
    return item ? stripKeys<PortfolioContent>(item) : null
  },

  async save(input: PortfolioInput): Promise<PortfolioContent> {
    const existing = await this.get()
    // Keep the synced-resume link only while the download still points at it.
    const resume =
      existing?.resume && existing.profile.resumeUrl === input.profile.resumeUrl
        ? existing.resume
        : undefined
    const content: PortfolioContent = { ...input, ...(resume ? { resume } : {}), updatedAt: nowIso() }
    await putItem({ ...content, ...KEY, entityType: "PORTFOLIO" })
    return content
  },

  /**
   * Publishes a IamCandidate resume's saved PDF: copies it into the public bucket
   * and points the site's "Download résumé" links at the copy.
   */
  async syncResume(userId: string, input: ResumeSyncInput): Promise<PortfolioContent> {
    const { bucketName, portfolioBucketName, portfolioAssetsUrl } = getConfig()
    if (!portfolioBucketName || !portfolioAssetsUrl) {
      throw new AppError(503, "SERVICE_UNAVAILABLE", "Portfolio uploads aren't configured on this server")
    }
    const current = await this.get()
    if (!current) {
      throw new ConflictError("Save the portfolio once in Admin → Portfolio before syncing a resume")
    }
    const resume = await resumesService.get(userId, input.resumeId)
    if (!resume.documentId) {
      throw new BadRequestError("This resume has no saved PDF yet. Open it and save a PDF to Documents first.")
    }
    const doc = await repositories.documents.getOrThrow(userId, resume.documentId)
    if (!doc.s3Key) throw new NotFoundError("Stored file for document", doc.id)
    if (doc.kind !== "pdf" && doc.mimeType !== "application/pdf") {
      throw new BadRequestError("Only PDF resumes can be published to the portfolio")
    }

    const fileName = `${(current.profile.name || "Resume").trim().replace(/\s+/g, "-")}-Resume.pdf`
    const key = portfolioAssetKey(createId("resume"), fileName)
    await portfolioAssetsRepository.copyFrom(
      { bucket: bucketName, key: doc.s3Key },
      { bucket: portfolioBucketName, key, contentType: "application/pdf", fileName },
    )

    const now = nowIso()
    const content: PortfolioContent = {
      ...current,
      profile: {
        ...current.profile,
        resumeUrl: `${portfolioAssetsUrl}/${key.split("/").map(encodeURIComponent).join("/")}`,
      },
      resume: { resumeId: resume.id, title: resume.title, version: resume.version, syncedAt: now },
      updatedAt: now,
    }
    await putItem({ ...content, ...KEY, entityType: "PORTFOLIO" })
    return content
  },

  /**
   * A short-lived presigned PUT for one image, plus the public URL it will
   * be served from. The browser uploads straight to S3; the URL then goes
   * into the portfolio content like any other image path.
   */
  async createImageUploadUrl(input: ImageUploadInput) {
    const { portfolioBucketName, portfolioAssetsUrl } = getConfig()
    if (!portfolioBucketName || !portfolioAssetsUrl) {
      throw new AppError(
        503,
        "SERVICE_UNAVAILABLE",
        "Image uploads aren't configured on this server",
      )
    }
    const key = portfolioAssetKey(createId("img"), input.fileName)
    return {
      uploadUrl: await portfolioAssetsRepository.createUploadUrl(
        portfolioBucketName,
        key,
        input.contentType,
      ),
      method: "PUT" as const,
      headers: {
        "Content-Type": input.contentType,
        "Cache-Control": "public, max-age=31536000, immutable",
      },
      url: `${portfolioAssetsUrl}/${key.split("/").map(encodeURIComponent).join("/")}`,
      expiresIn: UPLOAD_URL_TTL_SECONDS,
    }
  },

  /** Re-reads the account so a changed email takes effect at once. */
  async requireOwner(userId: string) {
    const account = await usersRepository.get(userId)
    if (account?.email.toLowerCase() !== PORTFOLIO_OWNER_EMAIL) {
      throw new AppError(403, "FORBIDDEN", "Only the portfolio owner can edit it")
    }
  },
}
