import type { APIGatewayProxyStructuredResultV2 } from "aws-lambda"

import type { AppError } from "./errors"

export type ApiResult = APIGatewayProxyStructuredResultV2

export interface SuccessBody<T> {
  success: true
  data: T
  meta?: Record<string, unknown>
}

export interface ErrorBody {
  success: false
  error: { code: string; message: string; details?: unknown }
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" }

export function ok<T>(data: T, meta?: Record<string, unknown>, status = 200): ApiResult {
  const body: SuccessBody<T> = meta ? { success: true, data, meta } : { success: true, data }
  return { statusCode: status, headers: { ...JSON_HEADERS }, body: JSON.stringify(body) }
}

export function created<T>(data: T): ApiResult {
  return ok(data, undefined, 201)
}

export function noContent(): ApiResult {
  return { statusCode: 204, headers: {} }
}

export function fail(error: Pick<AppError, "status" | "code" | "message" | "details">): ApiResult {
  const body: ErrorBody = {
    success: false,
    error: {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  }
  return { statusCode: error.status, headers: { ...JSON_HEADERS }, body: JSON.stringify(body) }
}
