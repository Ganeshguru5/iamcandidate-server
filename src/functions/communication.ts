import { emailRoutes, smtpRoutes, templateRoutes } from "../handlers/communication"
import { createHandler } from "../lib/router"

/** CommunicationFunction: sending email via the user's SMTP account, drafts, templates. */
export const handler = createHandler({ ...emailRoutes, ...templateRoutes, ...smtpRoutes })
