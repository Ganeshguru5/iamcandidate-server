import { requireAdmin } from "../lib/auth"
import { ok } from "../lib/response"
import type { Routes } from "../lib/router"
import { validate } from "../lib/validation"
import { pricingInput } from "../schemas/pricing"
import { pricingService } from "../services/pricing.service"

/** Public: the pricing page reads this without signing in. */
export const PUBLIC_PRICING_ROUTES = ["GET /pricing"]

export const pricingRoutes: Routes = {
  "GET /pricing": async () => ok(await pricingService.getPublic()),

  // Admin: every plan, including hidden ones.
  "GET /admin/pricing": async (ctx) => {
    requireAdmin(ctx, "change pricing")
    return ok(await pricingService.get())
  },
  "PUT /admin/pricing": async (ctx) => {
    requireAdmin(ctx, "change pricing")
    return ok(await pricingService.save(validate(pricingInput, ctx.body, "request body")))
  },
  "POST /admin/pricing/reset": async (ctx) => {
    requireAdmin(ctx, "change pricing")
    return ok(await pricingService.reset())
  },
}
