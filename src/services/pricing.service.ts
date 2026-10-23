import { DEFAULT_PRICING } from "../lib/default-pricing"
import { nowIso } from "../lib/ids"
import type { PricingConfig } from "../models"
import { getItem, putItem, stripKeys } from "../repositories/dynamodb/table"
import type { PricingInput } from "../schemas/pricing"

/** One site-wide item, outside any user's partition. */
const KEY = { PK: "GLOBAL", SK: "PRICING" }

export const pricingService = {
  /** The saved configuration, or the defaults if an admin never saved one. */
  async get(): Promise<PricingConfig> {
    const item = await getItem(KEY)
    return item ? stripKeys<PricingConfig>(item) : DEFAULT_PRICING
  },

  /** What the public pricing page shows: visible plans only, in order. */
  async getPublic(): Promise<PricingConfig> {
    const config = await this.get()
    return { ...config, plans: config.plans.filter((plan) => plan.visible) }
  },

  async save(input: PricingInput): Promise<PricingConfig> {
    const config: PricingConfig = { ...input, updatedAt: nowIso() }
    await putItem({ ...config, ...KEY, entityType: "PRICING" })
    return config
  },

  /** Back to the built-in plans. */
  async reset(): Promise<PricingConfig> {
    return this.save(DEFAULT_PRICING)
  },
}
