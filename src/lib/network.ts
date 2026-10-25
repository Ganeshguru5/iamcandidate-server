import { lookup, type LookupAddress } from "node:dns"
import http from "node:http"
import https from "node:https"
import { isIP, isIPv4 } from "node:net"
import type { Readable } from "node:stream"
import zlib from "node:zlib"

import { AppError, BadRequestError } from "./errors"

/**
 * Loopback, private, link-local (incl. the cloud metadata endpoint), CGNAT,
 * multicast and reserved addresses. Used to stop the API from being turned
 * into a proxy into private networks.
 */
export function isPrivateAddress(address: string): boolean {
  if (isIPv4(address)) {
    const [a = 0, b = 0] = address.split(".").map(Number)
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    )
  }
  const lower = address.toLowerCase()
  if (lower.startsWith("::ffff:")) return isPrivateAddress(lower.slice(7))
  return (
    lower === "::1" ||
    lower === "::" ||
    /^f[cd]/.test(lower) ||
    /^fe[89ab]/.test(lower) ||
    /^ff/.test(lower)
  )
}

class BlockedAddressError extends Error {}

/**
 * DNS lookup that refuses private addresses. It runs as the socket's own
 * `lookup`, so the address checked is the address connected to (no gap for
 * DNS rebinding between a check and the request).
 */
const publicLookup: NonNullable<http.RequestOptions["lookup"]> = (hostname, options, callback) => {
  lookup(hostname, { ...options, all: true }, (error, addresses: LookupAddress[]) => {
    if (error) return callback(error, "", 4)
    if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
      return callback(new BlockedAddressError(hostname), "", 4)
    }
    if (options.all)
      return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, addresses)
    const [first] = addresses as [LookupAddress]
    callback(null, first.address, first.family)
  })
}

export interface FetchedPage {
  /** Final URL after redirects. */
  url: string
  status: number
  contentType: string
  body: string
}

export interface FetchOptions {
  accept?: string
  timeoutMs?: number
  maxBytes?: number
  maxRedirects?: number
}

// Many job sites only serve full pages to browsers.
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"

function decode(response: http.IncomingMessage): Readable {
  switch (String(response.headers["content-encoding"] ?? "").toLowerCase()) {
    case "gzip":
      return response.pipe(zlib.createGunzip())
    case "deflate":
      return response.pipe(zlib.createInflate())
    case "br":
      return response.pipe(zlib.createBrotliDecompress())
    default:
      return response
  }
}

function requestOnce(url: URL, options: Required<FetchOptions>, signal: AbortSignal) {
  return new Promise<{ status: number; location?: string; contentType: string; body: string }>(
    (resolve, reject) => {
      const client = url.protocol === "https:" ? https : http
      const request = client.get(
        url,
        {
          lookup: publicLookup,
          signal,
          headers: {
            "user-agent": USER_AGENT,
            accept: options.accept,
            "accept-language": "en-US,en;q=0.9",
            "accept-encoding": "gzip, deflate, br",
          },
        },
        (response) => {
          const status = response.statusCode ?? 0
          const contentType = String(response.headers["content-type"] ?? "")
          if (status >= 300 && status < 400 && response.headers.location) {
            response.resume()
            return resolve({ status, location: response.headers.location, contentType, body: "" })
          }
          const chunks: Buffer[] = []
          let size = 0
          const stream = decode(response)
          stream.on("data", (chunk: Buffer) => {
            size += chunk.length
            if (size > options.maxBytes) {
              request.destroy()
              stream.destroy()
              reject(new AppError(502, "INTEGRATION_ERROR", "That page is too large to read"))
              return
            }
            chunks.push(chunk)
          })
          stream.on("end", () =>
            resolve({ status, contentType, body: Buffer.concat(chunks).toString("utf8") }),
          )
          stream.on("error", reject)
        },
      )
      request.on("error", reject)
    },
  )
}

/** Parses `raw` as an http(s) URL on a public host, or throws a 400. */
export function publicHttpUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new BadRequestError("That doesn't look like a link")
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BadRequestError("Only http and https links are supported")
  }
  if (url.username || url.password)
    throw new BadRequestError("Links with credentials aren't supported")
  if (url.port && url.port !== "80" && url.port !== "443") {
    throw new BadRequestError("Only links on the standard web ports are supported")
  }
  const host = url.hostname.replace(/^\[|\]$/g, "")
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) {
    throw new BadRequestError("That link points to a private address")
  }
  if (isIP(host) && isPrivateAddress(host)) {
    throw new BadRequestError("That link points to a private address")
  }
  return url
}

/**
 * GETs a URL on the public internet: private addresses are refused (on every
 * redirect hop), and the time and size spent on one page are capped.
 */
export async function fetchPublic(raw: string, options: FetchOptions = {}): Promise<FetchedPage> {
  const settings: Required<FetchOptions> = {
    accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
    timeoutMs: 8_000,
    maxBytes: 3 * 1024 * 1024,
    maxRedirects: 5,
    ...options,
  }
  const signal = AbortSignal.timeout(settings.timeoutMs)
  let url = publicHttpUrl(raw)
  try {
    for (let hop = 0; ; hop++) {
      const result = await requestOnce(url, settings, signal)
      if (result.location === undefined) {
        return {
          url: url.toString(),
          status: result.status,
          contentType: result.contentType,
          body: result.body,
        }
      }
      if (hop >= settings.maxRedirects) {
        throw new AppError(502, "INTEGRATION_ERROR", "That link redirects too many times")
      }
      url = publicHttpUrl(new URL(result.location, url).toString())
    }
  } catch (error) {
    if (error instanceof AppError) throw error
    if (error instanceof BlockedAddressError) {
      throw new BadRequestError("That link points to a private address")
    }
    if (signal.aborted) {
      throw new AppError(504, "INTEGRATION_ERROR", "The site took too long to respond")
    }
    const code = (error as { code?: string }).code
    if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
      throw new AppError(502, "INTEGRATION_ERROR", `Couldn't find the site "${url.hostname}"`)
    }
    throw new AppError(502, "INTEGRATION_ERROR", `Couldn't reach ${url.hostname}`)
  }
}
