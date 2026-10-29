export type ErrorCode =
  | "BAD_REQUEST"
  | "VALIDATION_ERROR"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "READ_ONLY"
  | "NOT_FOUND"
  | "ROUTE_NOT_FOUND"
  | "CONFLICT"
  | "SMTP_ERROR"
  | "INTEGRATION_ERROR"
  | "EMPTY_REPOSITORY"
  | "RATE_LIMITED"
  | "COMPILE_ERROR"
  | "SERVICE_UNAVAILABLE"
  | "INTERNAL_ERROR"

/** An error whose message is safe to show to API clients. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = "AppError"
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, id?: string) {
    super(404, "NOT_FOUND", id ? `${resource} ${id} was not found` : `${resource} was not found`)
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(400, "VALIDATION_ERROR", message, details)
  }
}

export class BadRequestError extends AppError {
  constructor(message: string) {
    super(400, "BAD_REQUEST", message)
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(409, "CONFLICT", message)
  }
}
