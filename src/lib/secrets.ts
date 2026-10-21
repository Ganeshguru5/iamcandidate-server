import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto"

import { getConfig } from "./config"

/**
 * Encrypts small secrets stored in DynamoDB (SMTP passwords) with
 * AES-256-GCM. The key comes from DATA_ENCRYPTION_KEY (a stack parameter in
 * AWS). Format: `v1.<iv b64url>.<auth tag b64url>.<ciphertext b64url>`.
 */
function key(): Buffer {
  const material = getConfig().dataEncryptionKey
  if (!material) throw new Error("DATA_ENCRYPTION_KEY is not configured")
  return createHash("sha256").update(material).digest()
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key(), iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  return ["v1", iv, tag, ciphertext]
    .map((part) => (typeof part === "string" ? part : part.toString("base64url")))
    .join(".")
}

export function decryptSecret(encrypted: string): string {
  const [version, iv, tag, ciphertext] = encrypted.split(".")
  if (version !== "v1" || !iv || !tag || !ciphertext) throw new Error("Unsupported secret format")
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"))
  decipher.setAuthTag(Buffer.from(tag, "base64url"))
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8")
}
