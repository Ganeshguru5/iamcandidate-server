import { getConfig } from "../lib/config"
import { AppError, BadRequestError, ConflictError, NotFoundError } from "../lib/errors"
import { createId, nowIso } from "../lib/ids"
import { logger, serializeError } from "../lib/logger"
import { getDummyHash, hashPassword, verifyPassword } from "../lib/passwords"
import { createToken, TOKEN_TTL_SECONDS } from "../lib/tokens"
import type {
  AccessRequest,
  StoredAccessRequest,
  StoredAccount,
  UserAccount,
  UserRole,
} from "../models"
import {
  accessRequestsRepository,
  repositories,
  settingsRepository,
  usersRepository,
} from "../repositories/dynamodb"
import { batchDelete, queryPartitionKeys, userPk } from "../repositories/dynamodb/table"
import { filesRepository } from "../repositories/s3/files.repository"
import type { AccessRequestInput, CreateUserInput, UpdateUserInput } from "../schemas/users"
import { templatesService } from "./templates.service"

/** API shape: never includes the password hash. */
export function toPublicUser({ passwordHash: _passwordHash, ...user }: StoredAccount): UserAccount {
  return user
}

const invalidCredentials = () => new AppError(401, "UNAUTHORIZED", "Incorrect email or password")

function isActiveAdmin(user: UserAccount) {
  return user.role === "admin" && !user.disabled
}

/** Refuses changes that would leave nobody able to manage users. */
async function assertAnotherActiveAdmin(excludingId: string) {
  const users = await usersRepository.list()
  if (!users.some((user) => user.id !== excludingId && isActiveAdmin(user))) {
    throw new ConflictError("At least one active admin is required")
  }
}

/** Removes everything a user owns: S3 files, then their DynamoDB partition. */
async function deleteUserData(userId: string) {
  const documents = await repositories.documents.list(userId)
  for (const doc of documents) {
    if (!doc.s3Key) continue
    try {
      await filesRepository.delete(doc.s3Key)
    } catch (error) {
      logger.error("Failed to delete S3 object", { key: doc.s3Key, error: serializeError(error) })
    }
  }
  await batchDelete(await queryPartitionKeys(userPk(userId)))
}

/** Caps the public sign-up form so it can't fill the table. */
const MAX_PENDING_REQUESTS = 200

/** Creates the account and an empty workspace with a starter profile. */
async function createAccount(input: {
  email: string
  name: string
  role: UserRole
  passwordHash: string
}): Promise<UserAccount> {
  const now = nowIso()
  const account: StoredAccount = {
    id: createId("usr"),
    email: input.email.trim().toLowerCase(),
    name: input.name,
    role: input.role,
    disabled: false,
    passwordHash: input.passwordHash,
    createdAt: now,
    updatedAt: now,
  }
  await usersRepository.create(account)
  await settingsRepository.put(account.id, "PROFILE", {
    name: account.name,
    email: account.email,
    role: "",
    bio: "",
    location: "",
  })
  await templatesService.ensureDefaults(account.id)
  return toPublicUser(account)
}

async function findAccessRequest(id: string): Promise<StoredAccessRequest> {
  const request = (await accessRequestsRepository.list()).find((item) => item.id === id)
  if (!request) throw new NotFoundError("Access request", id)
  return request
}

function issueSession(account: StoredAccount) {
  const secret = getConfig().authSecret
  if (!secret) throw new Error("AUTH_SECRET is not configured")
  return {
    token: createToken(account.id, secret),
    expiresIn: TOKEN_TTL_SECONDS,
    user: toPublicUser(account),
  }
}

export const usersService = {
  async login(email: string, password: string) {
    const account = await usersRepository.findByEmail(email)
    if (!account) {
      // Verify against a dummy hash when the email is unknown so response time
      // doesn't reveal which emails have accounts or requests.
      const request = await accessRequestsRepository.get(email)
      const valid = await verifyPassword(password, request?.passwordHash ?? (await getDummyHash()))
      if (request && valid) {
        throw new AppError(
          403,
          "FORBIDDEN",
          "Your access request is waiting for approval. You can sign in once the admin grants access.",
        )
      }
      throw invalidCredentials()
    }
    if (!(await verifyPassword(password, account.passwordHash))) throw invalidCredentials()
    if (account.disabled) {
      throw new AppError(401, "UNAUTHORIZED", "This account has been disabled. Contact your admin.")
    }
    const now = nowIso()
    const updated = await usersRepository.replace({ ...account, lastLoginAt: now })
    return issueSession(updated)
  },

  /** A fresh token for an already signed-in user (rolling sessions). */
  async refresh(userId: string) {
    return issueSession(await usersRepository.getOrThrow(userId))
  },

  async me(userId: string): Promise<UserAccount> {
    return toPublicUser(await usersRepository.getOrThrow(userId))
  },

  async changePassword(userId: string, currentPassword: string, newPassword: string) {
    const account = await usersRepository.getOrThrow(userId)
    if (!(await verifyPassword(currentPassword, account.passwordHash))) {
      throw new BadRequestError("Current password is incorrect")
    }
    await usersRepository.replace({
      ...account,
      passwordHash: await hashPassword(newPassword),
      updatedAt: nowIso(),
    })
  },

  /* Admin ----------------------------------------------------------- */

  async list(): Promise<UserAccount[]> {
    const users = await usersRepository.list()
    return users.map(toPublicUser).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  },

  async get(id: string): Promise<UserAccount> {
    return toPublicUser(await usersRepository.getOrThrow(id))
  },

  async create(input: CreateUserInput): Promise<UserAccount> {
    const { password, ...rest } = input
    return createAccount({ ...rest, passwordHash: await hashPassword(password) })
  },

  /** Pending sign-ups, newest first. */
  async listAccessRequests(): Promise<AccessRequest[]> {
    const requests = await accessRequestsRepository.list()
    return requests
      .map(({ passwordHash: _passwordHash, ...request }) => request)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  },

  /**
   * Saves a sign-up for the admin to review. Says nothing about whether the
   * email already has an account (that request is just dropped), and a second
   * request for the same email replaces the first.
   */
  async requestAccess(input: AccessRequestInput): Promise<void> {
    if (await usersRepository.findByEmail(input.email)) return
    const existing = await accessRequestsRepository.get(input.email)
    if (!existing && (await accessRequestsRepository.list()).length >= MAX_PENDING_REQUESTS) {
      throw new AppError(429, "RATE_LIMITED", "Too many pending requests right now. Try again later.")
    }
    await accessRequestsRepository.put({
      id: existing?.id ?? createId("req"),
      email: input.email,
      name: input.name,
      ...(input.message ? { message: input.message } : {}),
      passwordHash: await hashPassword(input.password),
      createdAt: nowIso(),
    })
  },

  /** Turns the request into a regular (non-admin) account with the password they chose. */
  async grantAccess(requestId: string): Promise<UserAccount> {
    const request = await findAccessRequest(requestId)
    const user = await createAccount({
      email: request.email,
      name: request.name,
      role: "user",
      passwordHash: request.passwordHash,
    })
    await accessRequestsRepository.delete(request.email)
    return user
  },

  async declineAccess(requestId: string): Promise<void> {
    const request = await findAccessRequest(requestId)
    await accessRequestsRepository.delete(request.email)
  },

  async update(actorId: string, id: string, patch: UpdateUserInput): Promise<UserAccount> {
    const existing = await usersRepository.getOrThrow(id)
    const next: StoredAccount = {
      ...existing,
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.role === undefined ? {} : { role: patch.role }),
      ...(patch.disabled === undefined ? {} : { disabled: patch.disabled }),
      ...(patch.password === undefined ? {} : { passwordHash: await hashPassword(patch.password) }),
      updatedAt: nowIso(),
    }
    if (id === actorId && (next.role !== "admin" || next.disabled)) {
      throw new BadRequestError("You can't remove your own admin access or disable yourself")
    }
    if (isActiveAdmin(existing) && !isActiveAdmin(next)) await assertAnotherActiveAdmin(id)
    return toPublicUser(await usersRepository.replace(next))
  },

  /** Deletes the account and all of the user's data and files. */
  async remove(actorId: string, id: string): Promise<void> {
    if (id === actorId) throw new BadRequestError("You can't delete your own account")
    const existing = await usersRepository.getOrThrow(id)
    if (isActiveAdmin(existing)) await assertAnotherActiveAdmin(id)
    await usersRepository.delete(existing)
    await deleteUserData(id)
  },
}
