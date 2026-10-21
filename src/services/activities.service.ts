import { logger, serializeError } from "../lib/logger"
import type { Activity, NewActivity } from "../models"
import { activityRepository } from "../repositories/dynamodb"

export const activitiesService = {
  list(userId: string, options: { limit: number; cursor?: string }) {
    return activityRepository.list(userId, options)
  },

  /**
   * Records a feed entry. The feed is secondary data: a failure here is logged
   * but never fails the user's actual change.
   */
  async record(userId: string, entry: NewActivity): Promise<Activity | undefined> {
    try {
      return await activityRepository.add(userId, entry)
    } catch (error) {
      logger.error("Failed to record activity", { type: entry.type, error: serializeError(error) })
      return undefined
    }
  },
}
