import type { Project } from "../models"
import { repositories } from "../repositories/dynamodb"
import type { ProjectInput } from "../schemas/workspace"
import { activitiesService } from "./activities.service"
import { byDateDesc, createCrudService } from "./crud"

const crud = createCrudService<Project, ProjectInput>(repositories.projects, {
  idPrefix: "prj",
  build: (input, id, now) => ({ ...input, id, updatedAt: now }),
  touch: (now) => ({ updatedAt: now }),
  sort: byDateDesc("updatedAt"),
})

export const projectsService = {
  ...crud,
  async create(userId: string, input: ProjectInput): Promise<Project> {
    const project = await crud.create(userId, input)
    await activitiesService.record(userId, {
      type: "project_updated",
      title: `Project created: ${project.name}`,
      entity: { type: "project", id: project.id },
    })
    return project
  },
}
