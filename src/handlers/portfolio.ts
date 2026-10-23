import { ok } from "../lib/response"
import type { Routes } from "../lib/router"
import { validate } from "../lib/validation"
import { imageUploadInput, portfolioInput } from "../schemas/portfolio"
import { portfolioService } from "../services/portfolio.service"

/** Public: the portfolio site reads this without signing in. */
export const PUBLIC_PORTFOLIO_ROUTES = ["GET /portfolio"]

export const portfolioRoutes: Routes = {
  "GET /portfolio": async () => ok(await portfolioService.get()),

  // Owner only: the signed-in knot account must be the portfolio owner's.
  "PUT /admin/portfolio": async (ctx) => {
    await portfolioService.requireOwner(ctx.userId)
    return ok(await portfolioService.save(validate(portfolioInput, ctx.body, "request body")))
  },
  "POST /admin/portfolio/upload-url": async (ctx) => {
    await portfolioService.requireOwner(ctx.userId)
    return ok(
      await portfolioService.createImageUploadUrl(
        validate(imageUploadInput, ctx.body, "request body"),
      ),
    )
  },
}
