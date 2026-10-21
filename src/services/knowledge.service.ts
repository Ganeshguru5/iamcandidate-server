import type { Bookmark, Certification, Skill } from "../models"
import { repositories } from "../repositories/dynamodb"
import type { CertificationInput, LinkInput, SkillInput } from "../schemas/knowledge"
import { byDateDesc, createCrudService } from "./crud"

/** Skills, certifications and links are plain CRUD with no side effects. */

export const skillsService = createCrudService<Skill, SkillInput>(repositories.skills, {
  idPrefix: "sk",
  build: (input, id) => ({ ...input, id }),
  sort: (a, b) => b.proficiency - a.proficiency || a.name.localeCompare(b.name),
})

export const certificationsService = createCrudService<Certification, CertificationInput>(
  repositories.certifications,
  {
    idPrefix: "cert",
    build: (input, id) => ({ ...input, id }),
    sort: byDateDesc("issueDate"),
  },
)

export const linksService = createCrudService<Bookmark, LinkInput>(repositories.links, {
  idPrefix: "bm",
  build: (input, id, now) => ({ ...input, id, createdAt: now }),
  sort: byDateDesc("createdAt"),
})
