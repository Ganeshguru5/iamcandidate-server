import type { NotificationPreferences, UserProfile } from "../models"
import { settingsRepository } from "../repositories/dynamodb"
import { activitiesService } from "./activities.service"

export const DEFAULT_PROFILE: UserProfile = {
  name: "",
  email: "",
  role: "",
  bio: "",
  location: "",
}

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  emailNotifications: true,
  interviewReminders: true,
  taskReminders: true,
  followUpReminders: true,
  weeklyDigest: false,
}

export const settingsService = {
  async getProfile(userId: string): Promise<UserProfile> {
    return (await settingsRepository.get(userId, "PROFILE")) ?? DEFAULT_PROFILE
  },

  async updateProfile(userId: string, profile: UserProfile): Promise<UserProfile> {
    await settingsRepository.put(userId, "PROFILE", profile)
    await activitiesService.record(userId, { type: "settings_updated", title: "Profile updated" })
    return profile
  },

  async getNotificationPreferences(userId: string): Promise<NotificationPreferences> {
    const stored = await settingsRepository.get(userId, "NOTIFICATIONS")
    return { ...DEFAULT_NOTIFICATION_PREFERENCES, ...stored }
  },

  updateNotificationPreferences(
    userId: string,
    prefs: NotificationPreferences,
  ): Promise<NotificationPreferences> {
    return settingsRepository.put(userId, "NOTIFICATIONS", prefs)
  },
}
