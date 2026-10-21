/**
 * Creates a login account directly in DynamoDB — mainly to bootstrap the first
 * admin of a fresh AWS deployment (afterwards, admins add users in the UI).
 *
 *   npm run create-user -- --email you@example.com --name "Your Name" --role admin
 *
 * The password is asked for interactively so it doesn't land in shell history.
 * Uses `.env` locally; for AWS set DYNAMODB_TABLE and leave DYNAMODB_ENDPOINT empty.
 */
import { createInterface } from "node:readline/promises"
import { parseArgs } from "node:util"

import { getConfig } from "../src/lib/config"
import { createUserInput } from "../src/schemas/users"
import { usersService } from "../src/services/users.service"
import { loadLocalEnv } from "./env"

loadLocalEnv()

async function main() {
  const { values } = parseArgs({
    options: {
      email: { type: "string" },
      name: { type: "string" },
      role: { type: "string", default: "user" },
    },
  })
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const password = await rl.question("Password (8+ characters): ")
  rl.close()

  const input = createUserInput.safeParse({ ...values, password })
  if (!input.success) {
    for (const issue of input.error.issues)
      console.error(`✗ ${issue.path.join(".")}: ${issue.message}`)
    process.exit(1)
  }
  const user = await usersService.create(input.data)
  console.log(`✓ created ${user.role} ${user.email} (${user.id}) in ${getConfig().tableName}`)
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
