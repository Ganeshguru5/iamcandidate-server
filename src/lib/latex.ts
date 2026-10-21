import { spawn } from "node:child_process"
import { cp, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { AppError } from "./errors"
import { logger } from "./logger"

/**
 * Compiles LaTeX to PDF with Tectonic (a self-contained XeTeX distribution).
 *
 * LaTeX can read any file the process can (`\input{/abs/path}` works even in
 * Tectonic's --untrusted mode), so in AWS this runs in its own Lambda with no
 * secrets and no IAM permissions. Here we also give the compiler a minimal
 * environment and a throwaway working directory per compile.
 */
export const MAX_SOURCE_LENGTH = 200_000
const MAX_PDF_BYTES = 4 * 1024 * 1024 // Lambda responses are capped at 6 MB (base64)
/** Lambda's image is pre-warmed; locally a first compile may still download packages. */
const timeoutMs = () => Number(process.env.LATEX_TIMEOUT_MS) || 45_000
const MAX_OUTPUT = 256 * 1024

export interface CompileResult {
  pdf: Buffer
  log: string
}

export class LatexCompileError extends AppError {
  constructor(message: string, details: { log: string; line?: number }) {
    super(400, "COMPILE_ERROR", message, details)
  }
}

/** First `! error` from a TeX log, with the `l.<n>` line number if present. */
export function parseTexError(log: string): { message: string; line?: number } {
  const lines = log.split(/\r?\n/)
  const index = lines.findIndex((line) => line.startsWith("! "))
  const errorLine = lines[index]
  if (index === -1 || !errorLine) return { message: "LaTeX couldn't compile this document" }
  const message = errorLine.slice(2).trim()
  for (const line of lines.slice(index, index + 20)) {
    const match = /^l\.(\d+)/.exec(line)
    if (match) return { message, line: Number(match[1]) }
  }
  return { message }
}

/** Lambda only: copy the package cache baked into the image to writable /tmp once per container. */
let cacheReady: Promise<string | undefined> | undefined
function prepareCache(): Promise<string | undefined> {
  cacheReady ??= (async () => {
    const seed = process.env.TECTONIC_SEED_CACHE
    if (!seed) return process.env.TECTONIC_CACHE_DIR
    const target = join(tmpdir(), "tectonic-cache")
    try {
      await stat(target)
    } catch {
      await cp(seed, target, { recursive: true })
    }
    return target
  })()
  return cacheReady
}

function compilerEnv(cacheDir: string | undefined): NodeJS.ProcessEnv {
  // Deliberately minimal: nothing secret is passed to the compiler.
  const keep = ["PATH", "SystemRoot", "TEMP", "TMP", "LOCALAPPDATA", "HOME"]
  const env: NodeJS.ProcessEnv = {}
  for (const key of keep) if (process.env[key]) env[key] = process.env[key]
  if (!env.HOME) env.HOME = tmpdir()
  if (cacheDir) env.TECTONIC_CACHE_DIR = cacheDir
  return env
}

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  return new Promise<{ code: number | null; output: string; timedOut: boolean }>(
    (resolve, reject) => {
      // No stdin: TeX must never wait for interactive input.
      const child = spawn(command, args, {
        cwd,
        env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      })
      let output = ""
      const collect = (chunk: Buffer) => {
        if (output.length < MAX_OUTPUT) output += chunk.toString("utf8")
      }
      child.stdout.on("data", collect)
      child.stderr.on("data", collect)
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        child.kill("SIGKILL")
      }, timeoutMs())
      child.on("error", (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.on("close", (code) => {
        clearTimeout(timer)
        resolve({ code, output, timedOut })
      })
    },
  )
}

/** One compile at a time per process; concurrent runs contend for the package cache. */
let queue: Promise<unknown> = Promise.resolve()

export function compileLatex(source: string): Promise<CompileResult> {
  const next = queue.then(() => compileNow(source))
  queue = next.catch(() => undefined)
  return next
}

async function compileNow(source: string): Promise<CompileResult> {
  const tectonic = process.env.TECTONIC_PATH || "tectonic"
  const dir = await mkdtemp(join(tmpdir(), "latex-"))
  try {
    await writeFile(join(dir, "main.tex"), source, "utf8")
    const cacheDir = await prepareCache()
    let result: Awaited<ReturnType<typeof run>>
    try {
      result = await run(
        tectonic,
        ["--untrusted", "--keep-logs", "--chatter", "minimal", "main.tex"],
        dir,
        compilerEnv(cacheDir),
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new AppError(
          503,
          "SERVICE_UNAVAILABLE",
          "The LaTeX compiler (Tectonic) isn't installed on this server. See docs/latex.md.",
        )
      }
      throw error
    }

    const texLog = await readFile(join(dir, "main.log"), "utf8").catch(() => "")
    const log = (texLog || result.output).slice(-20_000)
    if (result.timedOut) {
      throw new LatexCompileError(
        `Compilation took too long (over ${Math.round(timeoutMs() / 1000)} s) and was stopped.`,
        { log },
      )
    }
    const pdf = await readFile(join(dir, "main.pdf")).catch(() => undefined)
    if (result.code !== 0 || !pdf) {
      const error = parseTexError(texLog || result.output)
      logger.info("LaTeX compile failed", { message: error.message, line: error.line })
      throw new LatexCompileError(
        error.line ? `Line ${error.line}: ${error.message}` : error.message,
        { log, ...(error.line ? { line: error.line } : {}) },
      )
    }
    if (pdf.byteLength > MAX_PDF_BYTES) {
      throw new LatexCompileError("The PDF is larger than 4 MB.", { log })
    }
    return { pdf, log }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
