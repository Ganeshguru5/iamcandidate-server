import type { Note } from "../models"
import { repositories } from "../repositories/dynamodb"
import type { NoteInput } from "../schemas/workspace"
import { activitiesService } from "./activities.service"
import { byDateDesc, createCrudService } from "./crud"

const crud = createCrudService<Note, NoteInput>(repositories.notes, {
  idPrefix: "note",
  build: (input, id, now) => ({ ...input, id, createdAt: now, updatedAt: now }),
  touch: (now) => ({ updatedAt: now }),
  sort: byDateDesc("updatedAt"),
})

export const notesService = {
  ...crud,
  async create(userId: string, input: NoteInput): Promise<Note> {
    const note = await crud.create(userId, input)
    await activitiesService.record(userId, {
      type: "note_created",
      title: "Note created",
      description: note.title,
      entity: { type: "note", id: note.id },
    })
    return note
  },
}
