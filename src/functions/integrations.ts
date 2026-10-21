import { googleDriveRoutes } from "../handlers/integrations"
import { createHandler } from "../lib/router"

/** IntegrationsFunction: Google Drive (OAuth, browse, import into Documents). */
export const handler = createHandler(googleDriveRoutes)
