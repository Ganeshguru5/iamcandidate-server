/**
 * Seeds DynamoDB with the frontend's mock data and the demo login
 * (demo@example.com, the frontend's DEMO_CREDENTIALS).
 *
 *   npm run seed                    # upsert demo data + admin login
 *   npm run seed -- --reset         # delete the user's data first
 *   npm run seed -- --account-only  # only (re)create the login, keep data as is
 *   npm run seed -- --env .env.prod --role user --read-only   # a deployed table: view-only demo
 *
 * Uses `.env` (Docker setup) unless `--env` names another file; only that file
 * is read. `npm run dev` seeds its own database on first start. For a deployed
 * table the file sets DYNAMODB_TABLE and S3_BUCKET (no endpoints) and AWS
 * credentials come from your AWS profile.
 */
import { parseArgs } from "node:util"

import { getConfig } from "../src/lib/config"
import { USER_ROLES, type UserRole } from "../src/models"
import { loadLocalEnv } from "./env"
import { resetUserData, seedAdminAccount, seedDemoData } from "./seed-data"

const { values: args } = parseArgs({
  options: {
    env: { type: "string" },
    role: { type: "string", default: "admin" },
    "read-only": { type: "boolean", default: false },
    reset: { type: "boolean", default: false },
    "account-only": { type: "boolean", default: false },
  },
})

const role = args.role as UserRole
if (!USER_ROLES.includes(role)) throw new Error(`--role must be one of ${USER_ROLES.join(", ")}`)

if (args.env) process.loadEnvFile(args.env)
else loadLocalEnv()
const config = getConfig()
const userId = config.defaultUserId

async function main() {
  console.log(`→ ${config.tableName}${config.dynamodbEndpoint ? ` at ${config.dynamodbEndpoint}` : " (AWS)"}`)
  if (!args["account-only"]) {
    if (args.reset) {
      console.log(`✓ deleted ${await resetUserData(userId)} items for ${userId}`)
    }
    await seedDemoData(userId)
    console.log(`✓ seeded ${config.tableName} for ${userId}`)
  }
  const readOnly = args["read-only"]
  const email = await seedAdminAccount(userId, role, readOnly)
  console.log(`✓ ${readOnly ? "read-only " : ""}${role} login ${email} (password from the frontend's demo credentials)`)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
