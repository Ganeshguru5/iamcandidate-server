import { AppError, BadRequestError, ConflictError } from "../lib/errors"
import {
  GitHubAuthError,
  githubRequest,
  parseRepo,
  type RawCommit,
  type RawPull,
  type RawRepo,
  type RawUser,
} from "../lib/github"
import { nowIso } from "../lib/ids"
import { decryptSecret, encryptSecret } from "../lib/secrets"
import type { GitHubActivity, GitHubRepo, GitHubStatus, Project, StoredGitHub } from "../models"
import { repositories, settingsRepository } from "../repositories/dynamodb"
import { activitiesService } from "./activities.service"
import { projectsService } from "./projects.service"

const enc = encodeURIComponent

function toStatus(stored: StoredGitHub | undefined): GitHubStatus {
  if (!stored) return { connected: false }
  return {
    connected: true,
    account: stored.login,
    ...(stored.name ? { name: stored.name } : {}),
    avatarUrl: stored.avatarUrl,
    connectedAt: stored.connectedAt,
  }
}

/** Runs GitHub calls with the stored token; forgets it if GitHub rejects it. */
async function withGitHub<T>(userId: string, run: (token: string) => Promise<T>): Promise<T> {
  const stored = await settingsRepository.get(userId, "GITHUB")
  if (!stored) throw new ConflictError("Connect GitHub first.")
  try {
    return await run(decryptSecret(stored.encryptedToken))
  } catch (error) {
    if (error instanceof GitHubAuthError) await settingsRepository.remove(userId, "GITHUB")
    throw error
  }
}

/** Project ids keyed by lowercase "owner/name" of their repository URL. */
function projectsByRepo(projects: Project[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const project of projects) {
    const repo = parseRepo(project.repository)
    if (repo) map.set(repo.toLowerCase(), project.id)
  }
  return map
}

function toRepo(raw: RawRepo, linked: Map<string, string>): GitHubRepo {
  const projectId = linked.get(raw.full_name.toLowerCase())
  return {
    fullName: raw.full_name,
    name: raw.name,
    description: raw.description ?? "",
    url: raw.html_url,
    ...(raw.homepage ? { homepage: raw.homepage } : {}),
    private: raw.private,
    fork: raw.fork,
    archived: raw.archived,
    ...(raw.language ? { language: raw.language } : {}),
    topics: raw.topics ?? [],
    stars: raw.stargazers_count,
    defaultBranch: raw.default_branch,
    ...(raw.pushed_at ? { pushedAt: raw.pushed_at } : {}),
    ...(projectId ? { projectId } : {}),
  }
}

/** Validated "owner/name". */
function repoPath(fullName: string): string {
  const [owner, name, extra] = fullName.split("/")
  if (!owner || !name || extra !== undefined) {
    throw new BadRequestError("Use the repository as owner/name.")
  }
  return `${enc(owner)}/${enc(name)}`
}

export const githubService = {
  async status(userId: string): Promise<GitHubStatus> {
    return toStatus(await settingsRepository.get(userId, "GITHUB"))
  },

  /** Checks the token against GitHub, then stores it encrypted. */
  async connect(userId: string, token: string): Promise<GitHubStatus> {
    let user: RawUser
    try {
      user = await githubRequest<RawUser>(token, "/user", "user")
    } catch (error) {
      if (error instanceof GitHubAuthError) {
        throw new BadRequestError(
          "GitHub didn't accept this token. Check that it's copied in full and not expired.",
        )
      }
      throw error
    }
    const stored: StoredGitHub = {
      login: user.login,
      ...(user.name ? { name: user.name } : {}),
      avatarUrl: user.avatar_url,
      encryptedToken: encryptSecret(token),
      connectedAt: nowIso(),
    }
    await settingsRepository.put(userId, "GITHUB", stored)
    await activitiesService.record(userId, {
      type: "integration_connected",
      title: "GitHub connected",
      description: `@${user.login}`,
      entity: { type: "integration", id: "github" },
    })
    return toStatus(stored)
  },

  /** Forgets the token. (Personal tokens can only be revoked on GitHub itself.) */
  async disconnect(userId: string): Promise<GitHubStatus> {
    if (await settingsRepository.get(userId, "GITHUB")) {
      await settingsRepository.remove(userId, "GITHUB")
      await activitiesService.record(userId, {
        type: "integration_disconnected",
        title: "GitHub disconnected",
        entity: { type: "integration", id: "github" },
      })
    }
    return toStatus(undefined)
  },

  /** The user's repositories, most recently pushed first, with their linked project. */
  async repos(userId: string): Promise<GitHubRepo[]> {
    const [raw, projects] = await Promise.all([
      withGitHub(userId, (token) =>
        githubRequest<RawRepo[]>(
          token,
          "/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member",
          "repos",
        ),
      ),
      repositories.projects.list(userId),
    ])
    const linked = projectsByRepo(projects)
    return raw.map((repo) => toRepo(repo, linked))
  },

  /** Recent commits on the default branch and recently updated pull requests. */
  async activity(userId: string, fullName: string): Promise<GitHubActivity> {
    const path = repoPath(fullName)
    const projects = await repositories.projects.list(userId)
    return withGitHub(userId, async (token) => {
      const [raw, commits, pulls] = await Promise.all([
        githubRequest<RawRepo>(token, `/repos/${path}`, "repo"),
        githubRequest<RawCommit[]>(token, `/repos/${path}/commits?per_page=10`, "commits").catch(
          (error: unknown) => {
            // A brand-new repository has no commits yet.
            if (error instanceof AppError && error.code === "EMPTY_REPOSITORY") return []
            throw error
          },
        ),
        githubRequest<RawPull[]>(
          token,
          `/repos/${path}/pulls?state=all&sort=updated&direction=desc&per_page=10`,
          "pulls",
        ),
      ])
      return {
        repo: toRepo(raw, projectsByRepo(projects)),
        commits: commits.map((c) => ({
          sha: c.sha.slice(0, 7),
          message: c.commit.message.split("\n")[0] ?? "",
          author: c.author?.login ?? c.commit.author?.name ?? "unknown",
          date: c.commit.author?.date ?? "",
          url: c.html_url,
        })),
        pullRequests: pulls.map((p) => ({
          number: p.number,
          title: p.title,
          state: p.merged_at ? "merged" : p.state,
          author: p.user?.login ?? "unknown",
          updatedAt: p.updated_at,
          url: p.html_url,
        })),
      }
    })
  },

  /** Creates a iamcandidate project from a repository (or returns the one already linked). */
  async importRepo(userId: string, fullName: string): Promise<Project> {
    const path = repoPath(fullName)
    const projects = await repositories.projects.list(userId)
    const existingId = projectsByRepo(projects).get(fullName.toLowerCase())
    const existing = projects.find((p) => p.id === existingId)
    if (existing) return existing

    const { raw, languages } = await withGitHub(userId, async (token) => ({
      raw: await githubRequest<RawRepo>(token, `/repos/${path}`, "repo"),
      languages: await githubRequest<Record<string, number>>(
        token,
        `/repos/${path}/languages`,
        "languages",
      ),
    }))
    const technologies = [
      ...Object.entries(languages)
        .sort((a, b) => b[1] - a[1])
        .map(([name]) => name),
      ...(raw.topics ?? []),
    ]
    return projectsService.create(userId, {
      name: raw.name.slice(0, 200),
      description: (raw.description ?? "").slice(0, 5000),
      status: raw.archived ? "archived" : "development",
      progress: raw.archived ? 100 : 0,
      technologies: [...new Set(technologies)].slice(0, 12).map((t) => t.slice(0, 100)),
      repository: raw.html_url,
      ...(raw.homepage ? { deployment: raw.homepage } : {}),
      startedAt: raw.created_at,
    })
  },
}
