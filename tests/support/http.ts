import type { APIGatewayProxyEventV2 } from "aws-lambda"

import type { ApiResult } from "../../src/lib/response"

type Handler = (event: APIGatewayProxyEventV2) => Promise<ApiResult>

/** Minimal API Gateway HTTP API (payload v2) event. */
export function makeEvent(
  method: string,
  path: string,
  options: {
    body?: unknown
    query?: Record<string, string>
    origin?: string
    token?: string
  } = {},
): APIGatewayProxyEventV2 {
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath: path,
    rawQueryString: new URLSearchParams(options.query).toString(),
    headers: {
      ...(options.origin ? { origin: options.origin } : {}),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    queryStringParameters: options.query,
    requestContext: {
      accountId: "123456789012",
      apiId: "api",
      domainName: "localhost",
      domainPrefix: "localhost",
      http: { method, path, protocol: "HTTP/1.1", sourceIp: "127.0.0.1", userAgent: "vitest" },
      requestId: "req",
      routeKey: "$default",
      stage: "$default",
      time: "",
      timeEpoch: 0,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    isBase64Encoded: false,
  }
}

export interface Response<T = unknown> {
  status: number
  headers: Record<string, string | number | boolean>
  body: {
    success: boolean
    data?: T
    meta?: Record<string, unknown>
    error?: { code: string; message: string; details?: unknown }
  }
}

/** Invokes a Lambda handler and parses the JSON envelope. */
export async function call<T = unknown>(
  handler: Handler,
  method: string,
  path: string,
  options?: Parameters<typeof makeEvent>[2],
): Promise<Response<T>> {
  const result = await handler(makeEvent(method, path, options))
  return {
    status: result.statusCode ?? 200,
    headers: result.headers ?? {},
    body: result.body ? (JSON.parse(result.body) as Response<T>["body"]) : { success: true },
  }
}
