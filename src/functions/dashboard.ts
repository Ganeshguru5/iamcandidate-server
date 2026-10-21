import { createHandler } from "../lib/router"
import { dashboardRoutes } from "../handlers/system"

/** DashboardFunction: read-only aggregate for the dashboard screen. */
export const handler = createHandler(dashboardRoutes)
