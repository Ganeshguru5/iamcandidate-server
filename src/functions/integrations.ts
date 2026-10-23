import { integrationRoutes } from "../handlers/integrations"
import { createHandler } from "../lib/router"

/**
 * IntegrationsFunction: Google Drive (browse, import), Google Calendar (sync),
 * GitHub (repos, activity), LinkedIn (data export import) and S3 backups.
 */
export const handler = createHandler(integrationRoutes)
