/**
 * Seeds DynamoDB with the frontend's mock data and the demo admin login
 * (demo@example.com, the frontend's DEMO_CREDENTIALS).
 *
 *   npm run seed                    # upsert demo data + admin login
 *   npm run seed -- --reset         # delete the user's data first
 *   npm run seed -- --account-only  # only (re)create the admin login, keep data as is
 *
 * Uses `.env` (Docker setup). `npm run dev` seeds its own database on first start.
 */
import { getConfig } from "../src/lib/config"
import { loadLocalEnv } from "./env"
import { resetUserData, seedAdminAccount, seedDemoData } from "./seed-data"

loadLocalEnv()
const config = getConfig()
const userId = config.defaultUserId

async function main() {
  if (!process.argv.includes("--account-only")) {
    if (process.argv.includes("--reset")) {
      console.log(`✓ deleted ${await resetUserData(userId)} items for ${userId}`)
    }
    await seedDemoData(userId)
    console.log(`✓ seeded ${config.tableName} for ${userId}`)
  }
  const email = await seedAdminAccount(userId)
  console.log(`✓ admin login ${email} (password from the frontend's demo credentials)`)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
