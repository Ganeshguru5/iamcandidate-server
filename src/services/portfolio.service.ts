import { getConfig } from "../lib/config"
import { AppError } from "../lib/errors"
import { createId, nowIso } from "../lib/ids"
import { usersRepository } from "../repositories/dynamodb"
import { getItem, putItem, stripKeys } from "../repositories/dynamodb/table"
import { UPLOAD_URL_TTL_SECONDS } from "../repositories/s3/files.repository"
import {
  portfolioAssetKey,
  portfolioAssetsRepository,
} from "../repositories/s3/portfolio-assets.repository"
import type { ImageUploadInput, PortfolioContent, PortfolioInput } from "../schemas/portfolio"

/** One site-wide item, outside any user's partition. */
const KEY = { PK: "GLOBAL", SK: "PORTFOLIO" }

/** The only knot account allowed to edit the portfolio. */
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
    const content: PortfolioContent = { ...input, updatedAt: nowIso() }
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
