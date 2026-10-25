import { ValidationError } from "../lib/errors"
import type { Patch } from "../lib/validation"
import type { BoardItem } from "../models"
import { repositories } from "../repositories/dynamodb"
import { SEALED_SECRET, type BoardItemInput } from "../schemas/workspace"
import { byDateDesc, createCrudService } from "./crud"

const crud = createCrudService<BoardItem, BoardItemInput>(repositories.board, {
  idPrefix: "brd",
  build: (input, id, now) => ({ ...input, id, createdAt: now, updatedAt: now }),
  touch: (now) => ({ updatedAt: now }),
  sort: byDateDesc("updatedAt"),
})

/** Secrets must arrive already encrypted, so a client bug can't store one in plain text. */
function assertSealed(item: Pick<BoardItem, "kind" | "content">) {
  if (item.kind === "secret" && !SEALED_SECRET.test(item.content)) {
    throw new ValidationError("Invalid request body", [
      { path: "content", message: "Secret items must be encrypted before upload" },
    ])
  }
}

export const boardService = {
  ...crud,
  create(userId: string, input: BoardItemInput): Promise<BoardItem> {
    assertSealed(input)
    return crud.create(userId, input)
  },
  async update(
    userId: string,
    id: string,
    patch: Patch<Partial<BoardItemInput>>,
  ): Promise<BoardItem> {
    if (patch.kind !== undefined || patch.content !== undefined) {
      const existing = await crud.get(userId, id)
      assertSealed({ kind: patch.kind ?? existing.kind, content: patch.content ?? existing.content })
    }
    return crud.update(userId, id, patch)
  },
}
