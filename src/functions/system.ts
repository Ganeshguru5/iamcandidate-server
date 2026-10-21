import { createHandler } from "../lib/router"
import { activityRoutes, notificationRoutes, settingsRoutes } from "../handlers/system"

/** SystemFunction: activity feed, notifications, settings. */
export const handler = createHandler({
  ...activityRoutes,
  ...notificationRoutes,
  ...settingsRoutes,
})
