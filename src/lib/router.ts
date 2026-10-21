import type { APIGatewayProxyEventV2, Context } from "aws-lambda"

import { authenticate } from "./auth"
import { getConfig } from "./config"
import { AppError } from "./errors"
import { logger, serializeError } from "./logger"
import { fail, type ApiResult } from "./response"
import { parseJsonBody } from "./validation"

export interface RequestContext {
  /** Owner of the data this request reads and writes ("" on public routes). */
  userId: string
  role: "admin" | "user"

  params: Record<string, string>
  query: Record<string, string | undefined>
  body: unknown
  event: APIGatewayProxyEventV2
}

export type RouteHandler = (ctx: RequestContext) => Promise<ApiResult>

/** Route table keyed like API Gateway route keys: `"GET /applications/{id}"`. */
export type Routes = Record<string, RouteHandler>

interface CompiledRoute {
  key: string
  method: string
  pattern: RegExp
  names: string[]
  /** Literal segments win over `{param}` segments. */
  specificity: number
  handler: RouteHandler
}

function compile(routes: Routes): CompiledRoute[] {
  return Object.entries(routes)
    .map(([key, handler]) => {
      const [method = "", path = ""] = key.split(" ")
      const names: string[] = []
      const segments = path.split("/").filter(Boolean)
      const source = segments
        .map((segment) => {
          const param = /^\{(\w+)\}$/.exec(segment)
          if (!param?.[1]) return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
          names.push(param[1])
          return "([^/]+)"
        })
        .join("/")
      return {
        key,
        method,
        pattern: new RegExp(`^/${source}/?$`),
        names,
        specificity: segments.length * 10 - names.length,
        handler,
      }
    })
    .sort((a, b) => b.specificity - a.specificity)
}

function match(compiled: CompiledRoute[], method: string, path: string) {
  for (const route of compiled) {
    if (route.method !== method) continue
    const found = route.pattern.exec(path)
    if (!found) continue
    const params: Record<string, string> = {}
    route.names.forEach((name, index) => {
      params[name] = decodeURIComponent(found[index + 1] ?? "")
    })
    return { route, params }
  }
  return undefined
}

function corsHeaders(event: APIGatewayProxyEventV2): Record<string, string> {
  // API Gateway adds CORS headers itself in AWS (and ignores these). They
  // matter for `sam local start-api`, which proxies Lambda responses as-is.
  const origin = event.headers?.origin ?? event.headers?.Origin
  if (!origin || !getConfig().allowedOrigins.includes(origin)) return {}
  return { "access-control-allow-origin": origin, vary: "Origin" }
}

/**
 * Builds a Lambda handler that dispatches API Gateway HTTP API (payload v2)
 * events to `routes`, and converts thrown errors into the standard error
 * envelope without leaking internal details. Every route requires a signed-in
 * user except the route keys listed in `publicRoutes`.
 */
export function createHandler(routes: Routes, options: { publicRoutes?: string[] } = {}) {
  const compiled = compile(routes)
  const publicRoutes = new Set(options.publicRoutes)

  return async (event: APIGatewayProxyEventV2, context?: Context): Promise<ApiResult> => {
    const started = Date.now()
    const method = event.requestContext.http.method.toUpperCase()
    const path = event.rawPath
    let result: ApiResult

    try {
      if (method === "OPTIONS") {
        result = {
          statusCode: 204,
          headers: {
            "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
            "access-control-allow-headers": "content-type,authorization",
            "access-control-max-age": "600",
          },
        }
      } else {
        const found = match(compiled, method, path)
        if (!found) {
          throw new AppError(404, "ROUTE_NOT_FOUND", `No route for ${method} ${path}`)
        }
        const principal = publicRoutes.has(found.route.key)
          ? { userId: "", role: "user" as const }
          : await authenticate(event)
        result = await found.route.handler({
          ...principal,
          params: found.params,
          query: event.queryStringParameters ?? {},
          body: parseJsonBody(event.body, event.isBase64Encoded),
          event,
        })
      }
    } catch (error) {
      if (error instanceof AppError) {
        result = fail(error)
      } else {
        logger.error("Unhandled error", {
          method,
          path,
          requestId: context?.awsRequestId,
          error: serializeError(error),
        })
        result = fail({
          status: 500,
          code: "INTERNAL_ERROR",
          message: "Something went wrong",
          details: undefined,
        })
      }
    }

    result.headers = { ...result.headers, ...corsHeaders(event) }
    logger.info("request", {
      method,
      path,
      status: result.statusCode,
      durationMs: Date.now() - started,
      requestId: context?.awsRequestId,
    })
    return result
  }
}
