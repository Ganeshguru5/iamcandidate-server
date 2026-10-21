import { nowIso } from "../lib/ids"
import type { Interview } from "../models"
import { INTERVIEW_TYPE_LABELS } from "../models/labels"
import { repositories } from "../repositories/dynamodb"
import type { InterviewInput } from "../schemas/career"
import { activitiesService } from "./activities.service"
import { companyName, timelineEvent } from "./applications.service"
import { createCrudService } from "./crud"

const interviewsCrud = createCrudService<Interview, InterviewInput>(repositories.interviews, {
  idPrefix: "int",
  build: (input, id, now) => ({ ...input, id, createdAt: now }),
  sort: (a, b) => a.scheduledAt.localeCompare(b.scheduledAt),
})

export const interviewsService = {
  ...interviewsCrud,
  /** Scheduling an interview also adds an entry to the application's timeline. */
  async create(userId: string, input: InterviewInput): Promise<Interview> {
    const interview = await interviewsCrud.create(userId, input)
    const typeLabel = INTERVIEW_TYPE_LABELS[interview.type]
    const application = await repositories.applications.get(userId, interview.applicationId)
    if (application) {
      await repositories.applications.replace(userId, {
        ...application,
        timeline: [
          ...application.timeline,
          timelineEvent(`${typeLabel} interview scheduled`, "interview", interview.scheduledAt),
        ],
        updatedAt: nowIso(),
      })
    }
    await activitiesService.record(userId, {
      type: "interview_scheduled",
      title: "Interview scheduled",
      description: application
        ? `${await companyName(userId, application.companyId)} — ${typeLabel}`
        : typeLabel,
      entity: { type: "interview", id: interview.id },
    })
    return interview
  },
}
