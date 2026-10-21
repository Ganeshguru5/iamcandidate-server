import { createHmac, timingSafeEqual } from "node:crypto"

/**
 * Minimal HS256 JWT for session tokens. Only the user id travels in the token;
 * role and status are read from DynamoDB on every request, so disabling or
 * deleting a user takes effect immediately.
 */
export const TOKEN_TTL_SECONDS = 12 * 60 * 60

export interface TokenClaims {
  sub: string
  iat: number
  exp: number
}

const HEADER = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url")

function sign(data: string, secret: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url")
}

export function createToken(userId: string, secret: string, now = Date.now()): string {
  const iat = Math.floor(now / 1000)
  const claims: TokenClaims = { sub: userId, iat, exp: iat + TOKEN_TTL_SECONDS }
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url")
  return `${HEADER}.${payload}.${sign(`${HEADER}.${payload}`, secret)}`
}

/** Returns the claims of a valid, unexpired token, or undefined. */
export function verifyToken(
  token: string,
  secret: string,
  now = Date.now(),
): TokenClaims | undefined {
  const [header, payload, signature] = token.split(".")
  if (header !== HEADER || !payload || !signature) return undefined
  const expected = Buffer.from(sign(`${header}.${payload}`, secret))
  const actual = Buffer.from(signature)
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return undefined
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as TokenClaims
    if (typeof claims.sub !== "string" || typeof claims.exp !== "number") return undefined
    return claims.exp > now / 1000 ? claims : undefined
  } catch {
    return undefined
  }
}
