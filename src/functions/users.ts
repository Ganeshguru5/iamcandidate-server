import { PUBLIC_PRICING_ROUTES, pricingRoutes } from "../handlers/pricing"
import { authRoutes, PUBLIC_ROUTES, userRoutes } from "../handlers/users"
import { createHandler } from "../lib/router"

/** UsersFunction: sign-in, own account, admin user management and pricing. */
export const handler = createHandler(
  { ...authRoutes, ...userRoutes, ...pricingRoutes },
  { publicRoutes: [...PUBLIC_ROUTES, ...PUBLIC_PRICING_ROUTES] },
)
