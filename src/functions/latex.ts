import { latexRoutes } from "../handlers/latex"
import { createHandler } from "../lib/router"

/**
 * LatexFunction: compiles LaTeX in an isolated container image with no secrets
 * and no data access. The session is checked by API Gateway's Lambda
 * authorizer (SessionAuthorizerFunction) before a request reaches it, so the
 * route is public here.
 */
export const handler = createHandler(latexRoutes, { publicRoutes: Object.keys(latexRoutes) })
