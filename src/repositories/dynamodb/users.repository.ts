import { ConflictError, NotFoundError } from "../../lib/errors"
import type { StoredAccount } from "../../models"
import {
  deleteItem,
  getItem,
  isConditionalCheckFailure,
  putItem,
  queryAll,
  stripKeys,
  type StoredItem,
} from "./table"

/**
 * Login accounts live in one registry partition so admins can list them:
 *
 *   PK = USERS   SK = USER#<userId>      the account (incl. password hash)
 *   PK = USERS   SK = EMAIL#<email>      { userId } — unique-email lookup
 *
 * Each user's own data stays in `USER#<userId>` as before.
 */
const PK = "USERS"
const accountKey = (id: string) => ({ PK, SK: `USER#${id}` })
const emailKey = (email: string) => ({ PK, SK: `EMAIL#${normalizeEmail(email)}` })

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

function toItem(account: StoredAccount): StoredItem {
  return { ...account, ...accountKey(account.id), entityType: "ACCOUNT", userId: account.id }
}

export const usersRepository = {
  async get(id: string): Promise<StoredAccount | undefined> {
    const item = await getItem(accountKey(id))
    return item ? stripKeys<StoredAccount>(item) : undefined
  },

  async getOrThrow(id: string): Promise<StoredAccount> {
    const account = await this.get(id)
    if (!account) throw new NotFoundError("User", id)
    return account
  },

  async findByEmail(email: string): Promise<StoredAccount | undefined> {
    const lookup = await getItem(emailKey(email))
    return typeof lookup?.userId === "string" ? this.get(lookup.userId) : undefined
  },

  async list(): Promise<StoredAccount[]> {
    const items = await queryAll(PK, "USER#")
    return items.map((item) => stripKeys<StoredAccount>(item))
  },

  /** Claims the email first (conditional put), so emails stay unique. */
  async create(account: StoredAccount): Promise<StoredAccount> {
    try {
      await putItem(
        { ...emailKey(account.email), entityType: "EMAIL", userId: account.id },
        "attribute_not_exists(PK)",
      )
    } catch (error) {
      if (isConditionalCheckFailure(error)) {
        throw new ConflictError(`A user with email ${account.email} already exists`)
      }
      throw error
    }
    try {
      await putItem(toItem(account), "attribute_not_exists(PK)")
    } catch (error) {
      await deleteItem(emailKey(account.email))
      throw error
    }
    return account
  },

  /** Insert or overwrite (seeding). */
  async upsert(account: StoredAccount): Promise<void> {
    await putItem({ ...emailKey(account.email), entityType: "EMAIL", userId: account.id })
    await putItem(toItem(account))
  },

  async replace(account: StoredAccount): Promise<StoredAccount> {
    try {
      await putItem(toItem(account), "attribute_exists(PK)")
    } catch (error) {
      if (isConditionalCheckFailure(error)) throw new NotFoundError("User", account.id)
      throw error
    }
    return account
  },

  async delete(account: StoredAccount): Promise<void> {
    await deleteItem(accountKey(account.id))
    await deleteItem(emailKey(account.email))
  },
}
