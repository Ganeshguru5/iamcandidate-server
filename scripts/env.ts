/** Loads `.env` (if present) for local scripts. Lambda never uses this. */
export function loadLocalEnv() {
  try {
    process.loadEnvFile(".env")
  } catch {
    // No .env — rely on the shell environment.
  }
}
