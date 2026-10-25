import type {
  LinkedInStatus,
  StoredBoard,
  NotificationPreferences,
  StoredAwsBackup,
  StoredGitHub,
  StoredGoogleCalendar,
  StoredGoogleDrive,
  StoredSmtpSettings,
  UserProfile,
} from "../../models"
import { batchPut, deleteItem, getItem, putItem, queryAll, stripKeys, userPk } from "./table"

interface SettingsDocuments {
  PROFILE: UserProfile
  NOTIFICATIONS: NotificationPreferences
  SMTP: StoredSmtpSettings
  GOOGLE_DRIVE: StoredGoogleDrive
  GOOGLE_CALENDAR: StoredGoogleCalendar
  GITHUB: StoredGitHub
  LINKEDIN: LinkedInStatus
  AWS_BACKUP: StoredAwsBackup
  BOARD: StoredBoard
  /** Which version of the default email templates this account has been given. */
  TEMPLATE_DEFAULTS: { version: number; seededAt: string }
}

/** Settings documents that hold encrypted credentials; never exported or returned as-is. */
export const SECRET_SETTINGS = ["SMTP", "GOOGLE_DRIVE", "GOOGLE_CALENDAR", "GITHUB", "AWS_BACKUP", "BOARD"]

/** Per-user singleton documents: `SK = SETTINGS#PROFILE`, `SETTINGS#NOTIFICATIONS`. */
export const settingsRepository = {
  async remove(userId: string, name: keyof SettingsDocuments): Promise<void> {
    await deleteItem({ PK: userPk(userId), SK: `SETTINGS#${name}` })
  },

  async get<K extends keyof SettingsDocuments>(
    userId: string,
    name: K,
  ): Promise<SettingsDocuments[K] | undefined> {
    const item = await getItem({ PK: userPk(userId), SK: `SETTINGS#${name}` })
    return item ? stripKeys<SettingsDocuments[K]>(item) : undefined
  },

  async put<K extends keyof SettingsDocuments>(
    userId: string,
    name: K,
    value: SettingsDocuments[K],
  ): Promise<SettingsDocuments[K]> {
    await putItem({
      ...value,
      PK: userPk(userId),
      SK: `SETTINGS#${name}`,
      entityType: "SETTINGS",
      userId,
    })
    return value
  },
}

/** Notification read markers expire after 60 days; reminders are short-lived. */
const READ_MARKER_TTL_SECONDS = 60 * 24 * 60 * 60

/** `SK = NOTIFICATION_READ#<notificationId>` — one marker per read reminder. */
export const notificationReadRepository = {
  async listReadIds(userId: string): Promise<Set<string>> {
    const items = await queryAll(userPk(userId), "NOTIFICATION_READ#")
    return new Set(items.map((item) => String(item.notificationId)))
  },

  async markRead(userId: string, ids: string[]): Promise<void> {
    const ttl = Math.floor(Date.now() / 1000) + READ_MARKER_TTL_SECONDS
    await batchPut(
      ids.map((id) => ({
        PK: userPk(userId),
        SK: `NOTIFICATION_READ#${id}`,
        entityType: "NOTIFICATION_READ",
        userId,
        notificationId: id,
        ttl,
      })),
    )
  },
}
