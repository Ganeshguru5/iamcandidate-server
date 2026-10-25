import { nowIso } from "../lib/ids"
import { decryptSecret, encryptSecret } from "../lib/secrets"
import type { Board } from "../models"
import { settingsRepository } from "../repositories/dynamodb"
import type { BoardInput } from "../schemas/workspace"

/** One pad per user (`SETTINGS#BOARD`); the text is encrypted at rest because it often holds keys. */
export const boardService = {
  async get(userId: string): Promise<Board> {
    const stored = await settingsRepository.get(userId, "BOARD")
    if (!stored) return { content: "", updatedAt: null }
    return { content: decryptSecret(stored.encryptedContent), updatedAt: stored.updatedAt }
  },

  async save(userId: string, input: BoardInput): Promise<Board> {
    const updatedAt = nowIso()
    await settingsRepository.put(userId, "BOARD", {
      encryptedContent: encryptSecret(input.content),
      updatedAt,
    })
    return { content: input.content, updatedAt }
  },
}
