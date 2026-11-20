import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

const MAX_LOG_BYTES = 5 * 1024 * 1024; // 5 MB rotation threshold (SD-card friendly)

export interface LogRecord {
  ts: string;
  level: Exclude<LogLevel, "silent">;
  msg: string;
  [key: string]: unknown;
}

export interface Logger {
  level: LogLevel;
  logFilePath: string | null;
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export function parseLogLevel(raw: string | undefined, fallback: LogLevel = "info"): LogLevel {
  const normalized = (raw ?? "").trim().toLowerCase();
  if (
    normalized === "debug" ||
    normalized === "info" ||
    normalized === "warn" ||
    normalized === "error" ||
    normalized === "silent"
  ) {
    return normalized;
  }
  return fallback;
}

export function serializeError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
    };
  }
  return { message: String(err) };
}

function rotateIfNeeded(filePath: string): void {
  try {
    const size = statSync(filePath).size;
    if (size >= MAX_LOG_BYTES) {
      renameSync(filePath, `${filePath}.1`);
    }
  } catch {
    // File does not exist yet or cannot be stat'd; ignore
  }
}

export function createLogger(options: {
  level?: LogLevel;
  logDir?: string | null;
  sink?: (line: string, record: LogRecord) => void;
}): Logger {
  const level = options.level ?? "info";
  const logFilePath = options.logDir ? resolve(options.logDir, "app.log") : null;
  let dirReady = false;

  const write = (entryLevel: Exclude<LogLevel, "silent">, msg: string, fields?: Record<string, unknown>) => {
    if (LEVEL_RANK[entryLevel] < LEVEL_RANK[level]) return;

    const record: LogRecord = {
      ts: new Date().toISOString(),
      level: entryLevel,
      msg,
      ...fields,
    };

    let line: string;
    try {
      line = JSON.stringify(record);
    } catch {
      line = JSON.stringify({
        ts: record.ts,
        level: entryLevel,
        msg,
        serializationError: true,
      });
    }

    if (options.sink) {
      options.sink(line, record);
    } else if (entryLevel === "error") {
      console.error(line);
    } else if (entryLevel === "warn") {
      console.warn(line);
    } else {
      console.log(line);
    }

    if (logFilePath) {
      try {
        if (!dirReady) {
          mkdirSync(dirname(logFilePath), { recursive: true });
          dirReady = true;
        }
        rotateIfNeeded(logFilePath);
        appendFileSync(logFilePath, line + "\n", "utf-8");
      } catch {
        // Never crash the server if disk logging fails
      }
    }
  };

  return {
    level,
    logFilePath,
    debug: (msg, fields) => write("debug", msg, fields),
    info: (msg, fields) => write("info", msg, fields),
    warn: (msg, fields) => write("warn", msg, fields),
    error: (msg, fields) => write("error", msg, fields),
  };
}
