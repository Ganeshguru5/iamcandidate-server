import type { Referral } from "../models"
import { repositories } from "../repositories/dynamodb"
import type { ReferralInput } from "../schemas/career"
import { activitiesService } from "./activities.service"
import { companyName } from "./applications.service"
import { byDateDesc, createCrudService } from "./crud"

const referralsCrud = createCrudService<Referral, ReferralInput>(repositories.referrals, {
  idPrefix: "ref",
  build: (input, id, now) => ({ ...input, id, createdAt: now }),
  sort: byDateDesc("createdAt"),
})

export const referralsService = {
  ...referralsCrud,
  async create(userId: string, input: ReferralInput): Promise<Referral> {
    const referral = await referralsCrud.create(userId, input)
    if (referral.status !== "not_contacted") {
      const contact = await repositories.contacts.get(userId, referral.contactId)
      const firstName = contact?.name.split(" ")[0] ?? "contact"
      await activitiesService.record(userId, {
        type: "referral_requested",
        title: `Referral request sent to ${firstName}`,
        description: `${await companyName(userId, referral.companyId)} — ${referral.role}`,
        entity: { type: "referral", id: referral.id },
      })
    }
    return referral
  },
}
