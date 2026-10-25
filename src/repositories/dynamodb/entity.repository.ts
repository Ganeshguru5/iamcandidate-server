import { ConflictError, NotFoundError } from "../../lib/errors"
import type { Entity } from "../../models"
import {
  batchPut,
  deleteItem,
  getItem,
  isConditionalCheckFailure,
  putItem,
  queryAll,
  stripKeys,
  userPk,
  type StoredItem,
} from "./table"

/** Sort-key prefixes of every CRUD entity in the table. */
export type EntityType =
  | "APPLICATION"
  | "COMPANY"
  | "CONTACT"
  | "REFERRAL"
  | "INTERVIEW"
  | "RESUME"
  | "DOCUMENT"
  | "PROJECT"
  | "TASK"
  | "NOTE"
  | "BOARD"
  | "SKILL"
  | "CERTIFICATION"
  | "LINK"
  | "EMAIL"
  | "TEMPLATE"

/**
 * CRUD for one entity type inside a user's partition
 * (`PK = USER#<userId>`, `SK = <TYPE>#<id>`).
 */
export class EntityRepository<T extends Entity> {
  constructor(
    readonly type: EntityType,
    /** Human-readable name used in error messages. */
    readonly label: string,
  ) {}

  private key(userId: string, id: string) {
    return { PK: userPk(userId), SK: `${this.type}#${id}` }
  }

  private toItem(userId: string, entity: T): StoredItem {
    const item = { ...entity, ...this.key(userId, entity.id), entityType: this.type, userId }
    return item as unknown as StoredItem
  }

  async list(userId: string): Promise<T[]> {
    const items = await queryAll(userPk(userId), `${this.type}#`)
    return items.map((item) => stripKeys<T>(item))
  }

  async get(userId: string, id: string): Promise<T | undefined> {
    const item = await getItem(this.key(userId, id))
    return item ? stripKeys<T>(item) : undefined
  }

  async getOrThrow(userId: string, id: string): Promise<T> {
    const entity = await this.get(userId, id)
    if (!entity) throw new NotFoundError(this.label, id)
    return entity
  }

  /** Inserts a new entity; fails with 409 if the id already exists. */
  async create(userId: string, entity: T): Promise<T> {
    try {
      await putItem(this.toItem(userId, entity), "attribute_not_exists(PK)")
    } catch (error) {
      if (isConditionalCheckFailure(error)) {
        throw new ConflictError(`${this.label} ${entity.id} already exists`)
      }
      throw error
    }
    return entity
  }

  /** Replaces an existing entity; fails with 404 if it was deleted meanwhile. */
  async replace(userId: string, entity: T): Promise<T> {
    try {
      await putItem(this.toItem(userId, entity), "attribute_exists(PK)")
    } catch (error) {
      if (isConditionalCheckFailure(error)) throw new NotFoundError(this.label, entity.id)
      throw error
    }
    return entity
  }

  /** Deletes and returns the removed entity, or throws 404. */
  async delete(userId: string, id: string): Promise<T> {
    const removed = await deleteItem(this.key(userId, id))
    if (!removed) throw new NotFoundError(this.label, id)
    return stripKeys<T>(removed)
  }

  /** Bulk upsert (seeding, set-default on resumes). */
  async putMany(userId: string, entities: T[]): Promise<void> {
    await batchPut(entities.map((entity) => this.toItem(userId, entity)))
  }
}
