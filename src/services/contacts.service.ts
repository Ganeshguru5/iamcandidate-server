import type { Contact } from "../models"
import { repositories } from "../repositories/dynamodb"
import type { ContactInput } from "../schemas/career"
import { activitiesService } from "./activities.service"
import { companyName } from "./applications.service"
import { createCrudService } from "./crud"

const contactsCrud = createCrudService<Contact, ContactInput>(repositories.contacts, {
  idPrefix: "ct",
  build: (input, id, now) => ({ ...input, id, createdAt: now }),
  sort: (a, b) => a.name.localeCompare(b.name),
})

export const contactsService = {
  ...contactsCrud,
  async create(userId: string, input: ContactInput): Promise<Contact> {
    const contact = await contactsCrud.create(userId, input)
    await activitiesService.record(userId, {
      type: "contact_added",
      title: `Contact added: ${contact.name}`,
      description: contact.companyId ? await companyName(userId, contact.companyId) : contact.role,
      entity: { type: "contact", id: contact.id },
    })
    return contact
  },
}
