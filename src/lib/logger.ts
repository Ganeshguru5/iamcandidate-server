/** Minimal structured logger; CloudWatch Logs Insights can query the JSON fields. */
type Level = "info" | "warn" | "error"

function write(level: Level, message: string, context?: Record<string, unknown>) {
  if (process.env.LOG_LEVEL === "silent") return
  const line = JSON.stringify({ level, message, ...context })
  if (level === "error") console.error(line)
  else if (level === "warn") console.warn(line)
  else console.log(line)
}

export const logger = {
  info: (message: string, context?: Record<string, unknown>) => write("info", message, context),
  warn: (message: string, context?: Record<string, unknown>) => write("warn", message, context),
  error: (message: string, context?: Record<string, unknown>) => write("error", message, context),
}

export function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack }
  }
  return { value: String(error) }
}
