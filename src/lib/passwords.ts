import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto"

/**
 * Password hashing with Node's built-in scrypt (no native dependencies).
 * Stored format: `scrypt$<N>$<r>$<p>$<salt b64>$<hash b64>`, so parameters can
 * be raised later without breaking existing hashes.
 */
const PARAMS = { N: 16_384, r: 8, p: 1 }
const KEY_LENGTH = 64

function derive(password: string, salt: Buffer, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize("NFKC"), salt, KEY_LENGTH, options, (error, key) =>
      error ? reject(error) : resolve(key),
    )
  })
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const key = await derive(password, salt, PARAMS)
  const { N, r, p } = PARAMS
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${key.toString("base64")}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, N, r, p, salt, hash] = stored.split("$")
  if (scheme !== "scrypt" || !N || !r || !p || !salt || !hash) return false
  const expected = Buffer.from(hash, "base64")
  const key = await derive(password, Buffer.from(salt, "base64"), {
    N: Number(N),
    r: Number(r),
    p: Number(p),
  })
  return key.length === expected.length && timingSafeEqual(key, expected)
}

/** A real hash of a random password, verified against when an email is unknown
 *  so failed logins take the same time whether or not the account exists. */
let dummyHash: Promise<string> | undefined
export function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(16).toString("hex"))
  return dummyHash
}
