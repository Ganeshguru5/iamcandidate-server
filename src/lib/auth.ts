import type { APIGatewayProxyEventV2 } from "aws-lambda"

import type { UserRole } from "../models"
import { usersRepository } from "../repositories/dynamodb/users.repository"
import { getConfig } from "./config"
import { AppError } from "./errors"
import { verifyToken } from "./tokens"

/** The authenticated caller. All data access is scoped by `userId`. */
export interface Principal {
  userId: string
  role: UserRole
}

const unauthorized = (message: string) => new AppError(401, "UNAUTHORIZED", message)

/**
 * Resolves the caller from `Authorization: Bearer <token>`.
 *
 * The token only proves who the caller is; the account is re-read on every
 * request so a disabled or deleted user, or a changed role, applies at once.
 * Without `AUTH_SECRET` (unit tests only — template.yaml always sets it) the
 * API runs in open mode as `DEFAULT_USER_ID`.
 */
export async function authenticate(event: APIGatewayProxyEventV2): Promise<Principal> {
  const { authSecret, defaultUserId } = getConfig()
  if (!authSecret) return { userId: defaultUserId, role: "admin" }

  const header = event.headers?.authorization ?? event.headers?.Authorization
  const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : undefined
  if (!token) throw unauthorized("Sign in to continue")

  const claims = verifyToken(token, authSecret)
  if (!claims) throw unauthorized("Your session has expired. Sign in again.")

  const account = await usersRepository.get(claims.sub)
  if (!account || account.disabled) throw unauthorized("This account is no longer active")
  return { userId: account.id, role: account.role }
}

export function requireAdmin(principal: Pick<Principal, "role">, action = "manage users") {
  if (principal.role !== "admin") {
    throw new AppError(403, "FORBIDDEN", `Only admins can ${action}`)
  }
}
