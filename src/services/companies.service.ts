import type { Company } from "../models"
import { repositories } from "../repositories/dynamodb"
import type { CompanyInput } from "../schemas/career"
import { activitiesService } from "./activities.service"
import { createCrudService } from "./crud"

const companiesCrud = createCrudService<Company, CompanyInput>(repositories.companies, {
  idPrefix: "cmp",
  build: (input, id, now) => ({ ...input, id, createdAt: now }),
  sort: (a, b) => a.name.localeCompare(b.name),
})

export const companiesService = {
  ...companiesCrud,
  async create(userId: string, input: CompanyInput): Promise<Company> {
    const company = await companiesCrud.create(userId, input)
    await activitiesService.record(userId, {
      type: "company_added",
      title: `Company added: ${company.name}`,
      entity: { type: "company", id: company.id },
    })
    return company
  },
}
