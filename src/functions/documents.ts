import { createHandler } from "../lib/router"
import { documentRoutes, resumeRoutes } from "../handlers/documents"

/** DocumentsFunction: documents (S3 presigned uploads) and resumes. */
export const handler = createHandler({ ...documentRoutes, ...resumeRoutes })
