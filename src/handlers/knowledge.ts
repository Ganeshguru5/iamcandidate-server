import {
  certificationInput,
  certificationPatch,
  linkInput,
  linkPatch,
  linkQuery,
  skillInput,
  skillPatch,
} from "../schemas/knowledge"
import { filterItems } from "../services/crud"
import { certificationsService, linksService, skillsService } from "../services/knowledge.service"
import { crudRoutes } from "./crud"

export const skillRoutes = crudRoutes("/skills", skillsService, {
  input: skillInput,
  patch: skillPatch,
})

export const certificationRoutes = crudRoutes("/certifications", certificationsService, {
  input: certificationInput,
  patch: certificationPatch,
})

export const linkRoutes = crudRoutes(
  "/links",
  {
    ...linksService,
    list: async (userId: string, filters: { category?: string }) =>
      filterItems(await linksService.list(userId), filters),
  },
  { input: linkInput, patch: linkPatch, query: linkQuery },
)
