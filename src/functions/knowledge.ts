import { createHandler } from "../lib/router"
import { certificationRoutes, linkRoutes, skillRoutes } from "../handlers/knowledge"

/** KnowledgeFunction: skills, certifications, links. */
export const handler = createHandler({ ...skillRoutes, ...certificationRoutes, ...linkRoutes })
