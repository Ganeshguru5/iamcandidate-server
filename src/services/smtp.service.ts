import { lookup } from "node:dns/promises"
import { isIPv4 } from "node:net"

import nodemailer from "nodemailer"

import { getConfig } from "../lib/config"
import { AppError, BadRequestError } from "../lib/errors"
import { nowIso } from "../lib/ids"
import { logger } from "../lib/logger"
import { decryptSecret, encryptSecret } from "../lib/secrets"
import type { SmtpSettings, StoredSmtpSettings } from "../models"
import { settingsRepository } from "../repositories/dynamodb"
import type { SmtpSettingsInput } from "../schemas/communication"

/**
 * Each user sends from their own mailbox via SMTP. Settings are stored per
 * user with the password encrypted; the plain password is only held in memory
 * while connecting and is never returned by the API.
 */

const DEFAULTS: SmtpSettings = {
  host: "",
  port: 587,
  username: "",
  password: "",
  hasPassword: false,
  encryption: "tls",
  senderName: "",
  senderEmail: "",
}

function toPublic(stored: StoredSmtpSettings | undefined): SmtpSettings {
  if (!stored) return DEFAULTS
  const { encryptedPassword, ...rest } = stored
  return { ...rest, password: "", hasPassword: Boolean(encryptedPassword) }
}

/* Guard against using the API as a proxy into private networks ------- */

function isPrivateAddress(address: string): boolean {
  if (isIPv4(address)) {
    const [a = 0, b = 0] = address.split(".").map(Number)
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    )
  }
  const lower = address.toLowerCase()
  if (lower.startsWith("::ffff:")) return isPrivateAddress(lower.slice(7))
  return lower === "::1" || lower === "::" || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower)
}

async function assertAllowedHost(host: string) {
  if (getConfig().allowPrivateSmtpHosts) return
  let addresses: Array<{ address: string }>
  try {
    addresses = await lookup(host, { all: true })
  } catch {
    throw new AppError(
      502,
      "SMTP_ERROR",
      `Couldn't find the mail server "${host}". Check the host name.`,
    )
  }
  if (addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new BadRequestError("The SMTP host must be a public mail server")
  }
}

/* Connection --------------------------------------------------------- */

function transport(settings: Omit<SmtpSettings, "password" | "hasPassword">, password: string) {
  return nodemailer.createTransport({
    host: settings.host,
    port: settings.port,
    secure: settings.encryption === "ssl",
    requireTLS: settings.encryption === "tls",
    ignoreTLS: settings.encryption === "none",
    auth: { user: settings.username, pass: password },
    connectionTimeout: 8_000,
    greetingTimeout: 8_000,
    socketTimeout: 15_000,
  })
}

/** Turns nodemailer errors into messages a user can act on (no credentials included). */
function smtpError(error: unknown, settings: { host: string; port: number }): AppError {
  const code = (error as { code?: string }).code
  const detail = error instanceof Error ? error.message.slice(0, 300) : String(error)
  logger.warn("SMTP failure", { code, host: settings.host, port: settings.port, detail })
  if (code === "EAUTH") {
    return new AppError(
      502,
      "SMTP_ERROR",
      "The mail server rejected the username or password. Gmail and Outlook need an app password.",
    )
  }
  if (code === "ECONNECTION" || code === "ETIMEDOUT" || code === "ESOCKET" || code === "EDNS") {
    return new AppError(
      502,
      "SMTP_ERROR",
      `Couldn't connect to ${settings.host}:${settings.port}. Check the host, port and encryption (587 = STARTTLS, 465 = SSL/TLS).`,
    )
  }
  if (code === "EENVELOPE")
    return new AppError(502, "SMTP_ERROR", `A recipient was rejected: ${detail}`)
  return new AppError(502, "SMTP_ERROR", `The mail server returned an error: ${detail}`)
}

async function requireSettings(
  userId: string,
): Promise<{ stored: StoredSmtpSettings; password: string }> {
  const stored = await settingsRepository.get(userId, "SMTP")
  if (!stored?.encryptedPassword) {
    throw new BadRequestError("Set up your email account in Settings → Email before sending.")
  }
  return { stored, password: decryptSecret(stored.encryptedPassword) }
}

export const smtpService = {
  async get(userId: string): Promise<SmtpSettings> {
    return toPublic(await settingsRepository.get(userId, "SMTP"))
  },

  /** An empty password keeps the stored one. */
  async save(userId: string, input: SmtpSettingsInput): Promise<SmtpSettings> {
    const existing = await settingsRepository.get(userId, "SMTP")
    const encryptedPassword = input.password
      ? encryptSecret(input.password)
      : existing?.encryptedPassword
    if (!encryptedPassword) throw new BadRequestError("Enter the SMTP password")
    await assertAllowedHost(input.host)

    const sameConnection =
      existing &&
      !input.password &&
      existing.host === input.host &&
      existing.port === input.port &&
      existing.username === input.username &&
      existing.encryption === input.encryption
    const next: StoredSmtpSettings = {
      host: input.host,
      port: input.port,
      username: input.username,
      encryption: input.encryption,
      senderName: input.senderName,
      senderEmail: input.senderEmail,
      encryptedPassword,
      ...(sameConnection && existing.lastTestedAt ? { lastTestedAt: existing.lastTestedAt } : {}),
    }
    await settingsRepository.put(userId, "SMTP", next)
    return toPublic(next)
  },

  async remove(userId: string): Promise<void> {
    await settingsRepository.remove(userId, "SMTP")
  },

  /** Connects and authenticates without sending. Uses the stored password if none is given. */
  async test(userId: string, input: SmtpSettingsInput): Promise<{ ok: true; latencyMs: number }> {
    const existing = await settingsRepository.get(userId, "SMTP")
    const password =
      input.password ||
      (existing?.encryptedPassword ? decryptSecret(existing.encryptedPassword) : "")
    if (!password) throw new BadRequestError("Enter the SMTP password")
    await assertAllowedHost(input.host)

    const started = Date.now()
    try {
      await transport(input, password).verify()
    } catch (error) {
      throw smtpError(error, input)
    }
    const latencyMs = Date.now() - started
    if (existing && existing.host === input.host && existing.username === input.username) {
      await settingsRepository.put(userId, "SMTP", { ...existing, lastTestedAt: nowIso() })
    }
    return { ok: true, latencyMs }
  },

  /** Sends one message from the user's account; returns the sender and Message-ID. */
  async send(
    userId: string,
    message: { to: string[]; cc: string[]; subject: string; text: string },
  ): Promise<{ from: { name: string; email: string }; messageId: string }> {
    const { stored, password } = await requireSettings(userId)
    await assertAllowedHost(stored.host)
    try {
      const info = await transport(stored, password).sendMail({
        from: { name: stored.senderName, address: stored.senderEmail },
        to: message.to,
        cc: message.cc.length ? message.cc : undefined,
        subject: message.subject,
        text: message.text,
      })
      return {
        from: { name: stored.senderName, email: stored.senderEmail },
        messageId: info.messageId,
      }
    } catch (error) {
      throw smtpError(error, stored)
    }
  },

  /** Sender shown on drafts (may be empty before setup). */
  async sender(userId: string): Promise<{ name: string; email: string }> {
    const stored = await settingsRepository.get(userId, "SMTP")
    return { name: stored?.senderName ?? "", email: stored?.senderEmail ?? "" }
  },
}
