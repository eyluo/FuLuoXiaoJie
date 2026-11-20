export interface ClientErrorReport {
  level?: "warn" | "error";
  source: string;
  message: string;
  stack?: string;
  context?: Record<string, unknown>;
}

const DEDUPE_WINDOW_MS = 5_000;
const MAX_REPORTS_PER_MINUTE = 20;

const recentKeys = new Map<string, number>();
let reportTimestamps: number[] = [];
let globalHandlersInstalled = false;

function shouldSend(key: string): boolean {
  const now = Date.now();
  const prev = recentKeys.get(key);
  if (prev !== undefined && now - prev < DEDUPE_WINDOW_MS) {
    return false;
  }
  recentKeys.set(key, now);
  if (recentKeys.size > 100) {
    for (const [k, ts] of recentKeys) {
      if (now - ts >= DEDUPE_WINDOW_MS) recentKeys.delete(k);
    }
  }

  reportTimestamps = reportTimestamps.filter((ts) => now - ts < 60_000);
  if (reportTimestamps.length >= MAX_REPORTS_PER_MINUTE) {
    return false;
  }
  reportTimestamps.push(now);
  return true;
}

export function reportClientError(report: ClientErrorReport): void {
  const level = report.level ?? "error";
  const prefix = `[FuLuoXiaoJie:${report.source}]`;
  if (level === "warn") {
    console.warn(prefix, report.message, report.context ?? "");
  } else {
    console.error(prefix, report.message, report.stack ?? "", report.context ?? "");
  }

  if (typeof window === "undefined" || typeof fetch !== "function") return;
  const dedupeKey = `${level}:${report.source}:${report.message.slice(0, 120)}`;
  if (!shouldSend(dedupeKey)) return;

  const payload = {
    level,
    source: report.source.slice(0, 64),
    message: report.message.slice(0, 2000),
    stack: report.stack?.slice(0, 8000),
    url: `${window.location.pathname}${window.location.search}`.slice(0, 512),
    context: report.context,
  };

  void fetch("/api/client-logs", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    keepalive: true,
  }).catch(() => {
    // Ignore logging transport errors to prevent feedback loops
  });
}

export function installGlobalErrorHandlers(): void {
  if (globalHandlersInstalled || typeof window === "undefined") return;
  globalHandlersInstalled = true;

  window.addEventListener("error", (event) => {
    const err = event.error as Error | undefined;
    reportClientError({
      source: "window.onerror",
      message: err?.message || event.message || "Uncaught window error",
      stack: err?.stack,
      context: {
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
      },
    });
  });

  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    const message =
      reason instanceof Error
        ? reason.message
        : typeof reason === "string"
          ? reason
          : "Unhandled promise rejection";
    const stack = reason instanceof Error ? reason.stack : undefined;
    reportClientError({
      source: "unhandledrejection",
      message,
      stack,
    });
  });
}
