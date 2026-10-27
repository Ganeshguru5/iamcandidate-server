/**
 * Creates or resets the showcase account: a regular (non-admin) login filled
 * with the frontend's fictional mock data, for taking screenshots of a deployed
 * environment. It only ever writes the showcase user's records.
 *
 *   npm run seed:showcase                         # uses .env.showcase
 *   npm run seed:showcase -- --env path/to/file   # another target
 *
 * Reads everything from that env file (`.env.showcase` is git-ignored), never
 * from `.env`:
 *
 *   DYNAMODB_TABLE=personal-os-dev
 *   S3_BUCKET=personal-os-documents-<account>-dev
 *   API_URL=https://<id>.execute-api.ap-south-1.amazonaws.com
 *   SHOWCASE_PASSWORD=...   # generated and saved on the first run
 *   DYNAMODB_ENDPOINT=...   # only for a local database
 *
 * AWS credentials come from your AWS profile. Each run deletes the showcase
 * user's data partition and reseeds it, so dates stay relative to today.
 */
import { randomBytes } from "node:crypto"
import { appendFileSync, readFileSync } from "node:fs"
import { parseArgs } from "node:util"

import { createSeedDatabase, DEMO_CREDENTIALS, type MockDatabase } from "@/lib/mock"

import { getConfig } from "../src/lib/config"
import { nowIso } from "../src/lib/ids"
import { hashPassword } from "../src/lib/passwords"
import type { Activity } from "../src/models"
import {
  activityRepository,
  repositories,
  settingsRepository,
  usersRepository,
} from "../src/repositories/dynamodb"
import { resetUserData } from "./seed-data"

const ENV_FILE = parseArgs({ options: { env: { type: "string", default: ".env.showcase" } } })
  .values.env
const SHOWCASE_USER_ID = "usr_showcase"
const SHOWCASE_EMAIL = "alex.morgan@example.com"

/** Mock descriptions that point at real companies, reworded for screenshots. */
const COMPANY_DESCRIPTIONS: Record<string, string> = {
  cmp_ledgerline:
    "Stablecoin issuer building wallet and payments infrastructure. Fully remote engineering org.",
  cmp_freshpath: "Customer support and IT service desk software for growing teams.",
  cmp_teamforge: "Project tracking, wiki and planning tools for software teams.",
  cmp_relay: "API design, testing and monitoring platform used by millions of developers.",
}

const BOARD = `Standup — Thu
- Brightwave: system design round on Monday, revise checkout flow notes
- Send thank-you note to Elias (Ledgerline) after the culture-fit call
- Ask Jordan for the referral form link

Prep links
- STAR stories doc → Documents / Interview prep
- Portfolio: https://alexmorgan.example.com

Salary range to quote: ₹28–32 LPA (flexible for remote)
`

function loadEnv(): void {
  try {
    process.loadEnvFile(ENV_FILE)
  } catch {
    throw new Error(`Missing ${ENV_FILE}; see the comment at the top of this script.`)
  }
  for (const name of ["DYNAMODB_TABLE", "S3_BUCKET", "API_URL"]) {
    if (!process.env[name]) throw new Error(`${name} is not set in ${ENV_FILE}`)
  }
}

function showcasePassword(): string {
  const existing = process.env.SHOWCASE_PASSWORD?.trim()
  if (existing) return existing
  const password = randomBytes(18).toString("base64url")
  const ending = readFileSync(ENV_FILE, "utf8").endsWith("\n") ? "" : "\n"
  appendFileSync(ENV_FILE, `${ending}SHOWCASE_PASSWORD=${password}\n`)
  return password
}

/** Refuses to run if the email or user id already belongs to someone else. */
async function assertShowcaseOwned(): Promise<void> {
  const byEmail = await usersRepository.findByEmail(SHOWCASE_EMAIL)
  if (byEmail && byEmail.id !== SHOWCASE_USER_ID) {
    throw new Error(`${SHOWCASE_EMAIL} belongs to ${byEmail.id}; refusing to touch it`)
  }
  const byId = await usersRepository.get(SHOWCASE_USER_ID)
  if (byId && byId.email !== SHOWCASE_EMAIL) {
    throw new Error(`${SHOWCASE_USER_ID} is ${byId.email}; refusing to touch it`)
  }
}

/** The mock data, signed as the showcase email instead of the demo one. */
function showcaseDatabase(): MockDatabase {
  const db = JSON.parse(
    JSON.stringify(createSeedDatabase()).replaceAll(DEMO_CREDENTIALS.email, SHOWCASE_EMAIL),
  ) as MockDatabase
  db.companies = db.companies.map((company) =>
    COMPANY_DESCRIPTIONS[company.id]
      ? { ...company, description: COMPANY_DESCRIPTIONS[company.id] }
      : company,
  )
  return db
}

async function seedData(userId: string, db: MockDatabase): Promise<void> {
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
    r.templates.putMany(userId, db.templates),
    // Unlike `npm run seed`, the showcase account gets the mock inbox too.
    r.emails.putMany(userId, db.emails),
    activityRepository.putMany(userId, db.activities as Activity[]),
    settingsRepository.put(userId, "PROFILE", db.profile),
    settingsRepository.put(userId, "NOTIFICATIONS", db.notificationPreferences),
  ])
}

async function upsertAccount(name: string, password: string): Promise<void> {
  const existing = await usersRepository.get(SHOWCASE_USER_ID)
  const now = nowIso()
  await usersRepository.upsert({
    id: SHOWCASE_USER_ID,
    email: SHOWCASE_EMAIL,
    name,
    role: "user",
    disabled: false,
    passwordHash: await hashPassword(password),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  })
}

async function api<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(`${(process.env.API_URL ?? "").replace(/\/+$/, "")}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  })
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`)
  return ((await response.json()) as { data: T }).data
}

/**
 * The board is encrypted with the deployment's key, so it goes through the API.
 * Signing in also proves the account works end to end.
 */
async function seedBoard(password: string): Promise<void> {
  const { token } = await api<{ token: string }>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: SHOWCASE_EMAIL, password }),
  })
  await api("/board", {
    method: "PUT",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ content: BOARD }),
  })
}

async function main() {
  loadEnv()
  const { tableName, region, dynamodbEndpoint } = getConfig()
  console.log(`→ ${tableName} on ${dynamodbEndpoint ?? `AWS ${region}`}`)
  const password = showcasePassword()
  await assertShowcaseOwned()

  const db = showcaseDatabase()
  console.log(`✓ deleted ${await resetUserData(SHOWCASE_USER_ID)} items for ${SHOWCASE_USER_ID}`)
  await upsertAccount(db.profile.name, password)
  await seedData(SHOWCASE_USER_ID, db)
  console.log(`✓ seeded ${tableName} for ${SHOWCASE_USER_ID}`)
  await seedBoard(password)
  console.log(`✓ signed in through ${process.env.API_URL} and saved the board`)
  console.log(`✓ login ${SHOWCASE_EMAIL} (password in ${ENV_FILE})`)
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
