import type { StoredAccessRequest } from "../../models"
import { deleteItem, getItem, putItem, queryAll, stripKeys } from "./table"
import { normalizeEmail } from "./users.repository"

/**
 * Pending sign-ups, one per email, in their own registry partition:
 *
 *   PK = ACCESS_REQUESTS   SK = REQUEST#<email>   the request (incl. password hash)
 *
 * Granting one turns it into an account in `USERS` and deletes it here.
 */
const PK = "ACCESS_REQUESTS"
const requestKey = (email: string) => ({ PK, SK: `REQUEST#${normalizeEmail(email)}` })

export const accessRequestsRepository = {
  async get(email: string): Promise<StoredAccessRequest | undefined> {
    const item = await getItem(requestKey(email))
    return item ? stripKeys<StoredAccessRequest>(item) : undefined
  },

  async list(): Promise<StoredAccessRequest[]> {
    const items = await queryAll(PK, "REQUEST#")
    return items.map((item) => stripKeys<StoredAccessRequest>(item))
  },

  /** Creates or replaces the request for this email. */
  async put(request: StoredAccessRequest): Promise<void> {
    await putItem({ ...request, ...requestKey(request.email), entityType: "ACCESS_REQUEST" })
  },

  async delete(email: string): Promise<void> {
    await deleteItem(requestKey(email))
  },
}
