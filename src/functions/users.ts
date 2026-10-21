import { authRoutes, PUBLIC_ROUTES, userRoutes } from "../handlers/users"
import { createHandler } from "../lib/router"

/** UsersFunction: sign-in, own account, and admin user management. */
export const handler = createHandler(
  { ...authRoutes, ...userRoutes },
  { publicRoutes: PUBLIC_ROUTES },
)
