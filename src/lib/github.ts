import { AppError, BadRequestError } from "./errors"
import { logger } from "./logger"

/**
 * Minimal GitHub REST client on `fetch`, authenticated with the user's own
 * personal access token (no GitHub App or OAuth app to register).
 */
const API = "https://api.github.com"

/** Raised when GitHub rejects the stored token (revoked, expired, wrong scopes). */
export class GitHubAuthError extends AppError {
  constructor() {
    super(
      409,
      "INTEGRATION_ERROR",
      "GitHub rejected the access token (revoked or expired). Connect GitHub again with a new token.",
    )
  }
}

export async function githubRequest<T>(token: string, path: string, what: string): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${API}${path}`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "user-agent": "iamcandidate-server",
        "x-github-api-version": "2022-11-28",
      },
      signal: AbortSignal.timeout(15_000),
    })
  } catch (error) {
    logger.warn("GitHub request failed", { what, error: String(error) })
    throw new AppError(502, "INTEGRATION_ERROR", "Couldn't reach GitHub. Try again in a moment.")
  }
  if (response.ok) return (await response.json()) as T

  let message = ""
  try {
    message = ((await response.json()) as { message?: string }).message ?? ""
  } catch {
    // Not JSON.
  }
  logger.warn("GitHub API error", { what, status: response.status, message })
  if (response.status === 401) throw new GitHubAuthError()
  if (response.status === 404) {
    throw new AppError(
      404,
      "NOT_FOUND",
      "That repository doesn't exist or your token can't access it.",
    )
  }
  if (response.status === 409 && /empty/i.test(message)) {
    throw new AppError(409, "EMPTY_REPOSITORY", "This repository has no commits yet.")
  }
  if (response.status === 403 || response.status === 429) {
    if (response.headers.get("x-ratelimit-remaining") === "0") {
      throw new AppError(429, "RATE_LIMITED", "GitHub's rate limit was reached. Try again later.")
    }
    throw new BadRequestError(
      "Your GitHub token doesn't have access to this. Give it read access to repository contents, metadata and pull requests.",
    )
  }
  throw new AppError(502, "INTEGRATION_ERROR", "GitHub returned an error. Try again.")
}

/** "owner/name" from a GitHub URL (https, ssh or bare), or undefined. */
export function parseRepo(value: string | undefined): string | undefined {
  if (!value) return undefined
  const match = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/?#].*)?$/i.exec(value.trim())
  return match ? `${match[1]}/${match[2]}` : undefined
}

/* Response shapes (only the fields we read) -------------------------- */

export interface RawUser {
  login: string
  name: string | null
  avatar_url: string
}

export interface RawRepo {
  full_name: string
  name: string
  description: string | null
  html_url: string
  homepage: string | null
  private: boolean
  fork: boolean
  archived: boolean
  language: string | null
  topics?: string[]
  stargazers_count: number
  default_branch: string
  pushed_at: string | null
  created_at: string
}

export interface RawCommit {
  sha: string
  html_url: string
  commit: { message: string; author: { name: string; date: string } | null }
  author: { login: string } | null
}

export interface RawPull {
  number: number
  title: string
  state: "open" | "closed"
  merged_at: string | null
  updated_at: string
  html_url: string
  user: { login: string } | null
}
