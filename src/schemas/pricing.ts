import { z } from "zod"

import { requiredText, shortText } from "../lib/validation"
import { PRICING_CURRENCIES } from "../models"

const price = z.number().min(0).max(10_000_000)

/** A path on this site, an http(s) URL, or a mailto: link. */
const href = z
  .string()
  .trim()
  .min(1, "Required")
  .max(2048)
  .regex(
    /^(\/[^\s]*|https?:\/\/[^\s]+|mailto:[^\s]+)$/,
    "Use a path like /login, a URL or a mailto: link",
  )

export const pricingPlanInput = z.strictObject({
  id: z
    .string()
    .trim()
    .regex(/^[\w-]{1,64}$/, "Invalid plan id"),
  name: requiredText(60),
  tagline: shortText(200),
  monthlyPrice: price,
  yearlyPrice: price,
  features: z.array(z.string().trim().min(1).max(200)).max(20),
  ctaLabel: requiredText(40),
  ctaHref: href,
  highlighted: z.boolean(),
  visible: z.boolean(),
})

export const pricingInput = z
  .strictObject({
    currency: z.enum(PRICING_CURRENCIES),
    note: shortText(500),
    plans: z.array(pricingPlanInput).max(6, "Use at most 6 plans"),
  })
  .refine((value) => new Set(value.plans.map((p) => p.id)).size === value.plans.length, {
    message: "Plan ids must be unique",
    path: ["plans"],
  })
export type PricingInput = z.output<typeof pricingInput>
