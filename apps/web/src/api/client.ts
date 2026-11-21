import type { GraphDataset, GraphNode, KnownCoverageSummary, SandboxConfig } from "@fuluoxiaojie/graph-engine";
import { reportClientError } from "../utils/logger.js";

export type NodeStatus = "unseen" | "learning" | "known" | "ignored";
export type CardType = "recognition" | "stroke" | "component" | "listening";

export interface AuthStatus {
  authDisabled: boolean;
  configured: boolean;
  authenticated: boolean;
}

export interface ProgressEntry {
  status: NodeStatus;
  source: string;
  notes: string;
  updatedAt: string;
}

export interface ExampleWord {
  word: string;
  pinyin: string;
  numbered: string;
  gloss: string;
  freq: number;
  audio?: string;
}

export type ExamplesMap = Record<string, ExampleWord[]>;

export interface SrsSettings {
  dailyNewLimit: number;
  requestRetention: number;
  masteryStabilityDays: number;
  enabledModes: {
    recognition: boolean;
    stroke: boolean;
    component: boolean;
    listening: boolean;
  };
  enableTypingInRecognition: boolean;
}

export interface UserSettings {
  sandbox: SandboxConfig;
  srs: SrsSettings;
}

export interface SandboxPreset {
  id: string;
  name: string;
  config: Partial<SandboxConfig>;
  createdAt: string;
}

export interface SrsCardRow {
  id: string;
  node_id: string;
  card_type: CardType;
  due: string;
  stability: number;
  difficulty: number;
  elapsed_days?: number;
  scheduled_days?: number;
  reps: number;
  lapses: number;
  state: number;
  last_review: string | null;
}

export interface ReviewIntervalPreview {
  rating: 1 | 2 | 3 | 4;
  label: "Again" | "Hard" | "Good" | "Easy";
  due: string;
  scheduledDays: number;
  intervalLabel: string;
}

export interface DueCardPayload {
  card: SrsCardRow;
  node: GraphNode;
  components: Array<{
    id: string;
    definition: string;
    pinyin: string[];
    role: "semantic" | "phonetic" | "structural";
    multiplicity: number;
  }>;
  componentChoices: Array<{ id: string; definition: string }>;
  listeningContext: {
    maskedWord: string;
    word: string;
    pinyin: string;
    gloss: string;
    audio?: string;
  } | null;
  listeningChoices: Array<{ id: string; pinyin: string[]; definition: string }>;
  examples: Array<{ word: string; pinyin: string; numbered: string; gloss: string; audio?: string }>;
  notes: string;
  previews: ReviewIntervalPreview[];
}

export interface SrsStatsPayload {
  totalReviews: number;
  todayReviews: number;
  dueNow: number;
  retentionRate30dPct: number | null;
  learningNodes: number;
  cardStates: { new: number; learning: number; review: number; relearning: number };
  heatmap: Array<{ date: string; count: number; againCount: number }>;
  forecast14d: Array<{ date: string; count: number }>;
  coverage: KnownCoverageSummary;
}

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type UnauthorizedListener = () => void;
let unauthorizedListener: UnauthorizedListener | null = null;

export function setUnauthorizedHandler(handler: UnauthorizedListener | null): void {
  unauthorizedListener = handler;
}

export function notifyUnauthorized(): void {
  unauthorizedListener?.();
}

function handleAuthStatusCode(url: string, status: number): void {
  if (status === 401 && !url.startsWith("/api/auth/")) {
    notifyUnauthorized();
  }
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const mergedHeaders = new Headers(init?.headers);
  if (init?.body && !mergedHeaders.has("Content-Type")) {
    mergedHeaders.set("Content-Type", "application/json");
  }
  const res = await fetch(url, {
    ...init,
    credentials: "same-origin",
    headers: mergedHeaders,
  });
  if (!res.ok) {
    handleAuthStatusCode(url, res.status);
    const body = await res.json().catch(() => ({ error: res.statusText }));
    const message = body.error || `HTTP ${res.status}`;
    if (res.status >= 500) {
      reportClientError({
        source: "api-client",
        message: `${init?.method ?? "GET"} ${url} failed (${res.status}): ${message}`,
        context: {
          status: res.status,
          requestId: res.headers.get("X-Request-Id"),
        },
      });
    }
    throw new ApiError(res.status, message);
  }
  return (await res.json()) as T;
}

export const api = {
  getAuthStatus: () => requestJson<AuthStatus>("/api/auth/status"),
  setupPassphrase: (passphrase: string) =>
    requestJson<{ ok: boolean }>("/api/auth/setup", {
      method: "POST",
      body: JSON.stringify({ passphrase }),
    }),
  login: (passphrase: string) =>
    requestJson<{ ok: boolean }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ passphrase }),
    }),
  logout: () => requestJson<{ ok: boolean }>("/api/auth/logout", { method: "POST" }),
  changePassphrase: (currentPassphrase: string, newPassphrase: string) =>
    requestJson<{ ok: boolean }>("/api/auth/change-passphrase", {
      method: "POST",
      body: JSON.stringify({ currentPassphrase, newPassphrase }),
    }),

  getGraph: () => requestJson<GraphDataset>("/api/data/graph"),
  getExamples: () => requestJson<ExamplesMap>("/api/data/examples"),
  getStrokeData: (strokeFile: string) =>
    requestJson<{ strokes: string[]; medians: number[][][] }>(
      `/api/data/strokes/${encodeURIComponent(strokeFile)}`
    ),

  getProgress: () => requestJson<{ items: Record<string, ProgressEntry> }>("/api/progress"),
  updateProgress: (
    nodeId: string,
    patch: { status?: NodeStatus; notes?: string; source?: "manual" | "srs" | "import" }
  ) =>
    requestJson<{ nodeId: string; status: NodeStatus; source: string; notes: string; updatedAt: string }>(
      `/api/progress/${encodeURIComponent(nodeId)}`,
      { method: "PUT", body: JSON.stringify(patch) }
    ),
  bulkImportProgress: (
    payload:
      | { mode: "hsk"; maxLevel: number; status?: "known" | "learning" }
      | { mode: "top-n"; corpus: "subtlex" | "junda"; count: number; status?: "known" | "learning" }
      | { mode: "text"; text: string; status?: "known" | "learning" }
      | { mode: "list"; nodeIds: string[]; status?: NodeStatus }
  ) =>
    requestJson<{ importedCount: number; status: NodeStatus; nodeIds: string[] }>(
      "/api/progress/bulk-import",
      { method: "POST", body: JSON.stringify(payload) }
    ),

  getSettings: () => requestJson<UserSettings>("/api/settings"),
  updateSettings: (patch: { sandbox?: Partial<SandboxConfig>; srs?: Partial<SrsSettings> }) =>
    requestJson<UserSettings>("/api/settings", { method: "PUT", body: JSON.stringify(patch) }),

  getPresets: () => requestJson<{ presets: SandboxPreset[] }>("/api/presets"),
  createPreset: (name: string, config: Partial<SandboxConfig>) =>
    requestJson<SandboxPreset>("/api/presets", {
      method: "POST",
      body: JSON.stringify({ name, config }),
    }),
  deletePreset: (id: string) =>
    requestJson<{ ok: boolean }>(`/api/presets/${encodeURIComponent(id)}`, { method: "DELETE" }),

  getDueCards: (mode?: CardType, limit = 30) => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (mode) params.set("mode", mode);
    return requestJson<{ dueCount: number; cards: DueCardPayload[] }>(`/api/srs/due?${params}`);
  },
  getSrsCards: () => requestJson<{ cards: SrsCardRow[] }>("/api/srs/cards"),
  enrollNodes: (nodeIds: string[]) =>
    requestJson<{ enrolledNodes: string[]; createdCards: number }>("/api/srs/enroll", {
      method: "POST",
      body: JSON.stringify({ nodeIds }),
    }),
  submitReview: (cardId: string, rating: 1 | 2 | 3 | 4, durationMs: number) =>
    requestJson<{ card: SrsCardRow; promotedToKnown: boolean }>("/api/srs/review", {
      method: "POST",
      body: JSON.stringify({ cardId, rating, durationMs }),
    }),
  unenrollNode: (nodeId: string) =>
    requestJson<{ deletedCards: number }>(`/api/srs/node/${encodeURIComponent(nodeId)}`, {
      method: "DELETE",
    }),
  getSrsStats: () => requestJson<SrsStatsPayload>("/api/srs/stats"),

  async exportAnkiBlob(payload: {
    format: "csv" | "apkg";
    nodeIds?: string[];
    usePlannerTopN?: number;
    deckTitle?: string;
  }): Promise<{ blob: Blob; filename: string }> {
    const res = await fetch("/api/export/anki", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      handleAuthStatusCode("/api/export/anki", res.status);
      const body = await res.json().catch(() => ({ error: res.statusText }));
      throw new ApiError(res.status, body.error || `HTTP ${res.status}`);
    }
    const blob = await res.blob();
    return {
      blob,
      filename: payload.format === "apkg" ? "FuLuoXiaoJie-study-deck.apkg" : "FuLuoXiaoJie-study-deck.csv",
    };
  },

  async downloadBackup(): Promise<Blob> {
    const res = await fetch("/api/backup/export", { credentials: "same-origin" });
    if (!res.ok) {
      handleAuthStatusCode("/api/backup/export", res.status);
      throw new ApiError(res.status, "Failed to export backup");
    }
    return res.blob();
  },
  importBackup: (json: unknown) =>
    requestJson<{ ok: boolean; restoredProgress: number; restoredCards: number; restoredLogs: number }>(
      "/api/backup/import",
      { method: "POST", body: JSON.stringify(json) }
    ),
};
