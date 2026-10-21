/**
 * Demo data shared by `npm run seed` and `npm run dev`. The data comes straight
 * from the frontend (`../knot/src/lib/mock`, see scripts/tsconfig.json), so
 * mock mode and API mode start with the same content.
 */
import { createSeedDatabase, DEMO_CREDENTIALS } from "@/lib/mock"

import { nowIso } from "../src/lib/ids"
import { hashPassword } from "../src/lib/passwords"
import type { Activity } from "../src/models"
import {
  activityRepository,
  repositories,
  settingsRepository,
  usersRepository,
} from "../src/repositories/dynamodb"
import { batchDelete, queryPartitionKeys, userPk } from "../src/repositories/dynamodb/table"

/** Deletes everything in the user's data partition (not their login). */
export async function resetUserData(userId: string): Promise<number> {
  const keys = await queryPartitionKeys(userPk(userId))
  await batchDelete(keys)
  return keys.length
}

/**
 * Creates or refreshes the demo login (the frontend's DEMO_CREDENTIALS) as an
 * admin that owns `userId`'s data.
 */
export async function seedAdminAccount(userId: string): Promise<string> {
  const existing = await usersRepository.get(userId)
  const now = nowIso()
  await usersRepository.upsert({
    id: userId,
    email: DEMO_CREDENTIALS.email,
    name: createSeedDatabase().profile.name,
    role: "admin",
    disabled: false,
    passwordHash: await hashPassword(DEMO_CREDENTIALS.password),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  })
  return DEMO_CREDENTIALS.email
}

/** Upserts the demo data. Documents are metadata only (no stored file). */
export async function seedDemoData(userId: string): Promise<void> {
  const db = createSeedDatabase()
  const r = repositories
  await Promise.all([
    r.applications.putMany(userId, db.applications),
    r.companies.putMany(userId, db.companies),
    r.contacts.putMany(userId, db.contacts),
    r.referrals.putMany(userId, db.referrals),
    r.interviews.putMany(userId, db.interviews),
    r.resumes.putMany(userId, db.resumes),
    r.documents.putMany(userId, db.documents),
    r.projects.putMany(userId, db.projects),
    r.tasks.putMany(userId, db.tasks),
    r.notes.putMany(userId, db.notes),
    r.skills.putMany(userId, db.skills),
    r.certifications.putMany(userId, db.certifications),
    r.links.putMany(userId, db.bookmarks),
    // Templates only — mock inbox/sent mail would be mistaken for real tracking data.
    r.templates.putMany(userId, db.templates),
    activityRepository.putMany(userId, db.activities as Activity[]),
    settingsRepository.put(userId, "PROFILE", db.profile),
    settingsRepository.put(userId, "NOTIFICATIONS", db.notificationPreferences),
  ])
}
