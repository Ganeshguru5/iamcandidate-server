import { ConflictError } from "../lib/errors"
import {
  GOOGLE_PRODUCTS,
  GoogleGrantError,
  refreshAccessToken,
  type GooglePurpose,
} from "../lib/google"
import { decryptSecret, encryptSecret } from "../lib/secrets"
import { settingsRepository } from "../repositories/dynamodb"

const SETTINGS = { drive: "GOOGLE_DRIVE", calendar: "GOOGLE_CALENDAR" } as const

/** A valid access token, refreshed and re-stored when it is about to expire. */
async function accessToken(userId: string, purpose: GooglePurpose): Promise<string> {
  const name = SETTINGS[purpose]
  const stored = await settingsRepository.get(userId, name)
  if (!stored) throw new ConflictError(`Connect ${GOOGLE_PRODUCTS[purpose]} first.`)
  if (stored.encryptedAccessToken && (stored.accessTokenExpiresAt ?? 0) > Date.now() + 60_000) {
    return decryptSecret(stored.encryptedAccessToken)
  }
  const tokens = await refreshAccessToken(decryptSecret(stored.encryptedRefreshToken), purpose)
  await settingsRepository.put(userId, name, {
    ...stored,
    encryptedAccessToken: encryptSecret(tokens.accessToken),
    accessTokenExpiresAt: tokens.expiresAt,
    // Google may rotate the refresh token.
    ...(tokens.refreshToken ? { encryptedRefreshToken: encryptSecret(tokens.refreshToken) } : {}),
  })
  return tokens.accessToken
}

/**
 * Runs Google API calls with a fresh access token, dropping the stored
 * connection if Google says the grant is gone (revoked, expired test app).
 */
export async function withGoogle<T>(
  userId: string,
  purpose: GooglePurpose,
  run: (token: string) => Promise<T>,
): Promise<T> {
  try {
    return await run(await accessToken(userId, purpose))
  } catch (error) {
    if (error instanceof GoogleGrantError)
      await settingsRepository.remove(userId, SETTINGS[purpose])
    throw error
  }
}
