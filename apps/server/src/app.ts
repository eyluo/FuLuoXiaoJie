import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import { buildStudyQueue, resolveNodeIndex } from "@fuluoxiaojie/graph-engine";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getCookie } from "hono/cookie";
import { z } from "zod";
import {
  clearSessionCookie,
  createSession,
  csrfOriginGuard,
  getClientIp,
  hashPassphrase,
  isPassphraseConfigured,
  LoginRateLimiter,
  MIN_PASSPHRASE_LENGTH,
  requireAuthMiddleware,
  revokeAllSessionsExcept,
  revokeSessionToken,
  SESSION_COOKIE_NAME,
  setSessionCookie,
  setupInitialPassphraseAtomic,
  validateSessionToken,
  verifyStoredPassphrase,
  writePassphraseHash,
} from "./auth/auth.js";
import type { ServerConfig } from "./config.js";
import type { StaticDataStore } from "./data/staticLoader.js";
import { withTransaction, type AppDatabase } from "./db/database.js";
import { buildExportRows, generateAnkiApkg, generateAnkiCsv } from "./services/anki.js";
import {
  DEFAULT_USER_SETTINGS,
  getUserSettings,
  mergeUserSettings,
  SandboxConfigSchema,
  saveUserSettings,
  UserSettingsPatchSchema,
} from "./services/settings.js";
import {
  enrollNodesInSrs,
  getDueQueue,
  getSrsStats,
  submitCardReview,
  type CardType,
} from "./services/srs.js";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".mp3": "audio/mpeg",
};

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function isValidIsoTimestamp(s: string): boolean {
  if (!ISO_DATE_RE.test(s)) return false;
  return !Number.isNaN(Date.parse(s));
}

const IsoTimestampSchema = z.string().refine(isValidIsoTimestamp, {
  message: "Must be a valid ISO-8601 timestamp",
});

const PassphraseSchema = z.object({
  passphrase: z.string().min(1).max(256),
});

const ChangePassphraseSchema = z.object({
  currentPassphrase: z.string().min(1).max(256),
  newPassphrase: z.string().min(MIN_PASSPHRASE_LENGTH).max(256),
});

const ProgressUpdateSchema = z.object({
  status: z.enum(["unseen", "learning", "known", "ignored"]).optional(),
  notes: z.string().max(4000).optional(),
  source: z.enum(["manual", "srs", "import"]).optional(),
});

const BulkImportSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("hsk"),
    maxLevel: z.number().int().min(1).max(7),
    status: z.enum(["known", "learning"]).default("known"),
  }),
  z.object({
    mode: z.literal("top-n"),
    corpus: z.enum(["subtlex", "junda"]),
    count: z.number().int().min(1).max(4000),
    status: z.enum(["known", "learning"]).default("known"),
  }),
  z.object({
    mode: z.literal("text"),
    text: z.string().min(1).max(500_000),
    status: z.enum(["known", "learning"]).default("known"),
  }),
  z.object({
    mode: z.literal("list"),
    nodeIds: z.array(z.string().min(1).max(8)).max(5000),
    status: z.enum(["known", "learning", "ignored", "unseen"]).default("known"),
  }),
]);

const EnrollSchema = z.object({
  nodeIds: z.array(z.string().min(1).max(8)).min(1).max(200),
});

const ReviewSubmitSchema = z.object({
  cardId: z.string().min(1).max(128),
  rating: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  durationMs: z.number().min(0).max(600_000).optional(),
});

const PresetCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  config: SandboxConfigSchema,
});

const AnkiExportSchema = z.object({
  format: z.enum(["csv", "apkg"]),
  nodeIds: z.array(z.string().min(1).max(8)).max(1000).optional(),
  usePlannerTopN: z.number().int().min(1).max(500).optional(),
  deckTitle: z.string().trim().min(1).max(100).optional(),
});

const BackupSrsCardSchema = z
  .object({
    id: z.string().min(1).max(128),
    node_id: z.string().min(1).max(8),
    card_type: z.enum(["recognition", "stroke", "component", "listening"]),
    due: IsoTimestampSchema,
    stability: z.number().finite().min(0).max(100_000),
    difficulty: z.number().finite().min(0).max(10),
    elapsed_days: z.number().int().min(0).max(100_000),
    scheduled_days: z.number().int().min(0).max(100_000),
    reps: z.number().int().min(0).max(1_000_000),
    lapses: z.number().int().min(0).max(1_000_000),
    state: z.number().int().min(0).max(3),
    last_review: IsoTimestampSchema.nullable(),
  })
  .superRefine((card, ctx) => {
    if (card.state !== 0 && card.last_review === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Non-new FSRS card must include a valid last_review timestamp",
      });
    }
    if (card.state !== 0 && card.stability <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Non-new FSRS card must have positive stability",
      });
    }
  });

const BackupImportSchema = z.object({
  version: z.number().int().min(1).max(10),
  settings: UserSettingsPatchSchema.optional(),
  presets: z
    .array(
      z.object({
        id: z.string().min(1).max(128),
        name: z.string().trim().min(1).max(80),
        config: SandboxConfigSchema,
        createdAt: IsoTimestampSchema,
      })
    )
    .max(200)
    .optional(),
  progress: z
    .array(
      z.object({
        nodeId: z.string().min(1).max(8),
        status: z.enum(["unseen", "learning", "known", "ignored"]),
        source: z.enum(["manual", "srs", "import"]),
        notes: z.string().max(4000),
        updatedAt: IsoTimestampSchema,
      })
    )
    .max(10_000),
  srsCards: z.array(BackupSrsCardSchema).max(50_000),
  reviewLogs: z
    .array(
      z.object({
        id: z.string().min(1).max(128),
        card_id: z.string().min(1).max(128),
        node_id: z.string().min(1).max(8),
        card_type: z.enum(["recognition", "stroke", "component", "listening"]),
        rating: z.number().int().min(1).max(4),
        duration_ms: z.number().int().min(0).max(600_000),
        reviewed_at: IsoTimestampSchema,
        fsrs_snapshot_json: z
          .string()
          .max(2048)
          .refine((val) => {
            try {
              const p = JSON.parse(val);
              return p !== null && typeof p === "object";
            } catch {
              return false;
            }
          }, "fsrs_snapshot_json must be a valid JSON object"),
      })
    )
    .max(500_000)
    .optional(),
});

export interface CreateAppDeps {
  db: AppDatabase;
  store: StaticDataStore;
  config: ServerConfig;
  rateLimiter?: LoginRateLimiter;
}

export function createApp({
  db,
  store,
  config,
  rateLimiter = new LoginRateLimiter(),
}: CreateAppDeps): Hono {
  const app = new Hono();

  // Security headers on all responses
  app.use("*", async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    c.header("Referrer-Policy", "same-origin");
  });

  // Protect Raspberry Pi RAM from oversized request bodies
  app.use(
    "/api/backup/import",
    bodyLimit({
      maxSize: 20 * 1024 * 1024,
      onError: (c) => c.json({ error: "Backup payload exceeds 20 MB limit" }, 413),
    })
  );
  app.use("/api/*", async (c, next) => {
    if (c.req.path === "/api/backup/import") return next();
    return bodyLimit({
      maxSize: 2 * 1024 * 1024,
      onError: (ctx) => ctx.json({ error: "Request body exceeds 2 MB limit" }, 413),
    })(c, next);
  });

  // Same-origin CSRF guard (Sec-Fetch-Site + Origin + Referer + scheme) on mutating API calls
  app.use("/api/*", csrfOriginGuard(config));

  // Auth routes are never cacheable
  app.use("/api/auth/*", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
  });

  // Unauthenticated healthcheck for Docker HEALTHCHECK
  app.get("/api/health", (c) =>
    c.json({
      status: "ok",
      app: "FuLuoXiaoJie",
      nodes: store.graph.meta.nodeCount,
      version: store.graph.meta.version,
    })
  );

  // ---------------- Auth Routes ----------------
  app.get("/api/auth/status", (c) => {
    const configured = isPassphraseConfigured(db);
    const authenticated = config.authDisabled
      ? true
      : validateSessionToken(db, getCookie(c, SESSION_COOKIE_NAME));
    return c.json({
      authDisabled: config.authDisabled,
      configured,
      authenticated,
    });
  });

  app.post("/api/auth/setup", async (c) => {
    if (config.authDisabled) {
      return c.json({ ok: true, authDisabled: true });
    }
    if (isPassphraseConfigured(db)) {
      return c.json({ error: "Passphrase is already configured" }, 409);
    }
    const body = await c.req.json().catch(() => null);
    const parsed = PassphraseSchema.safeParse(body);
    if (!parsed.success || parsed.data.passphrase.length < MIN_PASSPHRASE_LENGTH) {
      return c.json(
        { error: `Passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters.` },
        400
      );
    }
    const inserted = await setupInitialPassphraseAtomic(db, parsed.data.passphrase);
    if (!inserted) {
      return c.json({ error: "Passphrase is already configured" }, 409);
    }
    const session = createSession(db, config.sessionTtlDays, c.req.header("user-agent") ?? "");
    setSessionCookie(c, session.token, config);
    return c.json({ ok: true });
  });

  app.post("/api/auth/login", async (c) => {
    if (config.authDisabled) {
      return c.json({ ok: true, authDisabled: true });
    }
    if (!isPassphraseConfigured(db)) {
      return c.json({ error: "Passphrase not configured yet" }, 400);
    }
    const ip = getClientIp(c, config);
    const limitCheck = rateLimiter.check(ip);
    if (!limitCheck.allowed) {
      c.header("Retry-After", String(limitCheck.retryAfterSec));
      return c.json(
        { error: `Too many login attempts. Retry in ${limitCheck.retryAfterSec}s.` },
        429
      );
    }

    const body = await c.req.json().catch(() => null);
    const parsed = PassphraseSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Passphrase is required" }, 400);
    }

    const valid = await verifyStoredPassphrase(db, parsed.data.passphrase);
    if (!valid) {
      rateLimiter.recordFailure(ip);
      return c.json({ error: "Invalid passphrase" }, 401);
    }

    rateLimiter.reset(ip);
    const session = createSession(db, config.sessionTtlDays, c.req.header("user-agent") ?? "");
    setSessionCookie(c, session.token, config);
    return c.json({ ok: true });
  });

  app.post("/api/auth/logout", (c) => {
    revokeSessionToken(db, getCookie(c, SESSION_COOKIE_NAME));
    clearSessionCookie(c, config);
    return c.json({ ok: true });
  });

  const requireAuth = requireAuthMiddleware(db, config);

  app.post("/api/auth/change-passphrase", requireAuth, async (c) => {
    if (config.authDisabled) {
      return c.json({ error: "Authentication is disabled" }, 400);
    }
    const ip = getClientIp(c, config);
    const limitCheck = rateLimiter.check(`chpw:${ip}`);
    if (!limitCheck.allowed) {
      c.header("Retry-After", String(limitCheck.retryAfterSec));
      return c.json(
        { error: `Too many passphrase attempts. Retry in ${limitCheck.retryAfterSec}s.` },
        429
      );
    }

    const body = await c.req.json().catch(() => null);
    const parsed = ChangePassphraseSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: `New passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters.` },
        400
      );
    }
    const ok = await verifyStoredPassphrase(db, parsed.data.currentPassphrase);
    if (!ok) {
      rateLimiter.recordFailure(`chpw:${ip}`);
      return c.json({ error: "Current passphrase is incorrect" }, 401);
    }
    rateLimiter.reset(`chpw:${ip}`);

    const newHash = await hashPassphrase(parsed.data.newPassphrase);
    const ua = c.req.header("user-agent") ?? "";
    const fresh = withTransaction(db, () => {
      writePassphraseHash(db, newHash);
      const sess = createSession(db, config.sessionTtlDays, ua);
      revokeAllSessionsExcept(db, sess.token);
      return sess;
    });

    setSessionCookie(c, fresh.token, config);
    return c.json({ ok: true });
  });

  // ---------------- Protected Static Data Routes (Cache-Control: private) ----------------
  app.get("/api/data/graph", requireAuth, (c) => {
    c.header("Content-Type", "application/json; charset=utf-8");
    c.header("Cache-Control", "private, max-age=3600");
    return c.body(store.graphJsonRaw);
  });

  app.get("/api/data/examples", requireAuth, (c) => {
    c.header("Content-Type", "application/json; charset=utf-8");
    c.header("Cache-Control", "private, max-age=3600");
    return c.body(store.examplesJsonRaw);
  });

  app.get("/api/data/strokes/:file", requireAuth, (c) => {
    const content = store.readStrokeFile(c.req.param("file"));
    if (content === null) return c.json({ error: "Stroke data not found" }, 404);
    c.header("Content-Type", "application/json; charset=utf-8");
    c.header("Cache-Control", "private, max-age=31536000, immutable");
    return c.body(content);
  });

  app.get("/api/data/audio/:file", requireAuth, (c) => {
    const bytes = store.readAudioFile(c.req.param("file"));
    if (bytes === null) return c.json({ error: "Audio syllable not found" }, 404);
    return new Response(bytes as unknown as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "private, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });

  // ---------------- Progress & Bulk Import Routes ----------------
  app.get("/api/progress", requireAuth, (c) => {
    const rows = db
      .prepare("SELECT node_id, status, source, notes, updated_at FROM node_progress")
      .all() as Array<{
      node_id: string;
      status: string;
      source: string;
      notes: string;
      updated_at: string;
    }>;
    const items: Record<string, { status: string; source: string; notes: string; updatedAt: string }> = {};
    for (const r of rows) {
      items[r.node_id] = {
        status: r.status,
        source: r.source,
        notes: r.notes,
        updatedAt: r.updated_at,
      };
    }
    return c.json({ items });
  });

  app.put("/api/progress/:nodeId", requireAuth, async (c) => {
    // Hono already URL-decodes route params (no second decodeURIComponent!)
    const rawNodeId = c.req.param("nodeId");
    const settings = getUserSettings(db);
    const proj = store.getProjection(settings.sandbox.mergeVariants);
    const idx = resolveNodeIndex(proj, rawNodeId);
    if (idx === undefined) {
      return c.json({ error: `Unknown DAG node: ${rawNodeId}` }, 404);
    }
    const canonicalId = proj.nodes[idx]!.id;

    const body = await c.req.json().catch(() => null);
    const parsed = ProgressUpdateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid progress payload", details: parsed.error.flatten() }, 400);
    }

    const existing = db
      .prepare("SELECT status, source, notes FROM node_progress WHERE node_id = ?")
      .get(canonicalId) as { status: string; source: string; notes: string } | undefined;

    const status = parsed.data.status ?? existing?.status ?? "unseen";
    const source = parsed.data.source ?? (parsed.data.status ? "manual" : existing?.source ?? "manual");
    const notes = parsed.data.notes ?? existing?.notes ?? "";
    const now = new Date().toISOString();

    db.prepare(
      `INSERT INTO node_progress (node_id, status, source, notes, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(node_id) DO UPDATE SET
         status = excluded.status,
         source = excluded.source,
         notes = excluded.notes,
         updated_at = excluded.updated_at`
    ).run(canonicalId, status, source, notes, now);

    return c.json({ nodeId: canonicalId, status, source, notes, updatedAt: now });
  });

  app.post("/api/progress/bulk-import", requireAuth, async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = BulkImportSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid bulk-import payload", details: parsed.error.flatten() }, 400);
    }

    const settings = getUserSettings(db);
    const proj = store.getProjection(settings.sandbox.mergeVariants);
    const targetIds = new Set<string>();
    const status = parsed.data.status;

    if (parsed.data.mode === "hsk") {
      const maxLvl = parsed.data.maxLevel;
      for (const n of proj.nodes) {
        if (n.hskLevel !== null && n.hskLevel <= maxLvl) {
          targetIds.add(n.id);
        }
      }
    } else if (parsed.data.mode === "top-n") {
      const corpus = parsed.data.corpus;
      const limit = parsed.data.count;
      const ranked = proj.nodes
        .filter((n) => !n.isPrimitive)
        .map((n) => ({
          id: n.id,
          rank: corpus === "subtlex" ? n.freq.subtlexRank : n.freq.jundaRank,
        }))
        .filter((x): x is { id: string; rank: number } => x.rank !== null && x.rank <= limit);
      for (const x of ranked) targetIds.add(x.id);
    } else if (parsed.data.mode === "text") {
      for (const ch of parsed.data.text) {
        const idx = resolveNodeIndex(proj, ch);
        if (idx !== undefined) {
          targetIds.add(proj.nodes[idx]!.id);
        }
      }
    } else {
      for (const rawId of parsed.data.nodeIds) {
        const idx = resolveNodeIndex(proj, rawId);
        if (idx !== undefined) {
          targetIds.add(proj.nodes[idx]!.id);
        }
      }
    }

    const now = new Date().toISOString();
    const ids = Array.from(targetIds);
    const stmt = db.prepare(
      `INSERT INTO node_progress (node_id, status, source, notes, updated_at)
       VALUES (?, ?, 'import', '', ?)
       ON CONFLICT(node_id) DO UPDATE SET
         status = excluded.status,
         source = 'import',
         updated_at = excluded.updated_at`
    );

    withTransaction(db, () => {
      for (const id of ids) {
        stmt.run(id, status, now);
      }
    });

    return c.json({ importedCount: ids.length, status, nodeIds: ids });
  });

  // ---------------- SRS Routes ----------------
  app.get("/api/srs/due", requireAuth, (c) => {
    const settings = getUserSettings(db);
    const modeParam = c.req.query("mode");
    const limitParam = Number.parseInt(c.req.query("limit") || "30", 10);
    const validModes: CardType[] = ["recognition", "stroke", "component", "listening"];
    const modeFilter = validModes.includes(modeParam as CardType) ? (modeParam as CardType) : undefined;
    const result = getDueQueue(
      db,
      store,
      settings,
      modeFilter,
      Number.isFinite(limitParam) ? limitParam : 30
    );
    return c.json(result);
  });

  app.get("/api/srs/cards", requireAuth, (c) => {
    const rows = db
      .prepare(
        `SELECT id, node_id, card_type, due, stability, difficulty, reps, lapses, state, last_review
         FROM srs_cards ORDER BY due ASC`
      )
      .all();
    return c.json({ cards: rows });
  });

  app.post("/api/srs/enroll", requireAuth, async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = EnrollSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid enroll payload", details: parsed.error.flatten() }, 400);
    }
    const settings = getUserSettings(db);
    const res = enrollNodesInSrs(db, store, settings, parsed.data.nodeIds);
    return c.json(res);
  });

  app.post("/api/srs/review", requireAuth, async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = ReviewSubmitSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid review payload", details: parsed.error.flatten() }, 400);
    }
    const settings = getUserSettings(db);
    const res = submitCardReview(
      db,
      store,
      settings,
      parsed.data.cardId,
      parsed.data.rating,
      parsed.data.durationMs ?? 0
    );
    if (!res) return c.json({ error: "SRS card not found" }, 404);
    return c.json(res);
  });

  app.delete("/api/srs/node/:nodeId", requireAuth, (c) => {
    const rawNodeId = c.req.param("nodeId");
    const settings = getUserSettings(db);
    const proj = store.getProjection(settings.sandbox.mergeVariants);
    const idx = resolveNodeIndex(proj, rawNodeId);
    const targets = new Set<string>([rawNodeId]);
    if (idx !== undefined) {
      const canonicalId = proj.nodes[idx]!.id;
      targets.add(canonicalId);
      for (const alias of proj.mergedFrom[canonicalId] ?? []) {
        targets.add(alias);
      }
    }
    const ids = Array.from(targets);
    const placeholders = ids.map(() => "?").join(", ");
    const res = db.prepare(`DELETE FROM srs_cards WHERE node_id IN (${placeholders})`).run(...ids);
    return c.json({ deletedCards: Number(res.changes) });
  });

  app.get("/api/srs/stats", requireAuth, (c) => {
    const settings = getUserSettings(db);
    return c.json(getSrsStats(db, store, settings));
  });

  // ---------------- Settings & Presets Routes ----------------
  app.get("/api/settings", requireAuth, (c) => c.json(getUserSettings(db)));

  app.put("/api/settings", requireAuth, async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = UserSettingsPatchSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid settings payload", details: parsed.error.flatten() }, 400);
    }
    return c.json(saveUserSettings(db, parsed.data));
  });

  app.get("/api/presets", requireAuth, (c) => {
    const rows = db
      .prepare("SELECT id, name, config_json, created_at FROM sandbox_presets ORDER BY created_at DESC")
      .all() as Array<{ id: string; name: string; config_json: string; created_at: string }>;
    return c.json({
      presets: rows.map((r) => ({
        id: r.id,
        name: r.name,
        config: JSON.parse(r.config_json),
        createdAt: r.created_at,
      })),
    });
  });

  app.post("/api/presets", requireAuth, async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = PresetCreateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid preset payload", details: parsed.error.flatten() }, 400);
    }
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    db.prepare(
      "INSERT INTO sandbox_presets (id, name, config_json, created_at) VALUES (?, ?, ?, ?)"
    ).run(id, parsed.data.name, JSON.stringify(parsed.data.config), createdAt);
    return c.json({ id, name: parsed.data.name, config: parsed.data.config, createdAt }, 201);
  });

  app.delete("/api/presets/:id", requireAuth, (c) => {
    const res = db.prepare("DELETE FROM sandbox_presets WHERE id = ?").run(c.req.param("id"));
    if (Number(res.changes) === 0) return c.json({ error: "Preset not found" }, 404);
    return c.json({ ok: true });
  });

  // ---------------- Anki Export & JSON Backup Routes ----------------
  app.post("/api/export/anki", requireAuth, async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = AnkiExportSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid Anki export payload", details: parsed.error.flatten() }, 400);
    }

    const settings = getUserSettings(db);
    let nodeIds = parsed.data.nodeIds ?? [];

    if (nodeIds.length === 0) {
      const proj = store.getProjection(settings.sandbox.mergeVariants);
      const progRows = db
        .prepare("SELECT node_id, status FROM node_progress WHERE status IN ('known', 'ignored')")
        .all() as Array<{ node_id: string; status: string }>;
      const known = new Set<string>();
      const ignored = new Set<string>();
      for (const r of progRows) {
        if (r.status === "known") known.add(r.node_id);
        else if (r.status === "ignored") ignored.add(r.node_id);
      }
      const queue = buildStudyQueue(
        proj,
        settings.sandbox,
        known,
        ignored,
        parsed.data.usePlannerTopN ?? 100
      );
      nodeIds = queue.map((q) => q.id);
    }

    const resolvedRows = buildExportRows(store, nodeIds, settings.sandbox.mergeVariants);
    if (resolvedRows.length === 0) {
      return c.json({ error: "No valid DAG characters available to export" }, 400);
    }

    if (parsed.data.format === "csv") {
      const csv = generateAnkiCsv(store, nodeIds, settings.sandbox.mergeVariants);
      return new Response(csv, {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": 'attachment; filename="FuLuoXiaoJie-study-deck.csv"',
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    const apkgBytes = generateAnkiApkg(
      store,
      nodeIds,
      settings.sandbox.mergeVariants,
      parsed.data.deckTitle ?? "FuLuoXiaoJie (弗洛小姐)"
    );
    return new Response(apkgBytes as unknown as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": 'attachment; filename="FuLuoXiaoJie-study-deck.apkg"',
        "X-Content-Type-Options": "nosniff",
      },
    });
  });

  app.get("/api/backup/export", requireAuth, (c) => {
    const settings = getUserSettings(db);
    const presets = (
      db
        .prepare("SELECT id, name, config_json, created_at FROM sandbox_presets ORDER BY created_at ASC")
        .all() as Array<{ id: string; name: string; config_json: string; created_at: string }>
    ).map((r) => ({
      id: r.id,
      name: r.name,
      config: JSON.parse(r.config_json),
      createdAt: r.created_at,
    }));
    const progress = (
      db
        .prepare("SELECT node_id, status, source, notes, updated_at FROM node_progress ORDER BY node_id ASC")
        .all() as Array<{
        node_id: string;
        status: string;
        source: string;
        notes: string;
        updated_at: string;
      }>
    ).map((r) => ({
      nodeId: r.node_id,
      status: r.status,
      source: r.source,
      notes: r.notes,
      updatedAt: r.updated_at,
    }));
    const srsCards = db.prepare("SELECT * FROM srs_cards ORDER BY id ASC").all();
    const reviewLogs = db.prepare("SELECT * FROM review_logs ORDER BY reviewed_at ASC").all();

    const payload = {
      version: 1,
      app: "FuLuoXiaoJie",
      exportedAt: new Date().toISOString(),
      settings,
      presets,
      progress,
      srsCards,
      reviewLogs,
    };

    return new Response(JSON.stringify(payload, null, 2), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": 'attachment; filename="fuluoxiaojie-backup.json"',
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });

  app.post("/api/backup/import", requireAuth, async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = BackupImportSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid backup archive format", details: parsed.error.flatten() }, 400);
    }

    const data = parsed.data;

    // Validate referential integrity & uniqueness up front so bad backups return clean 400s (never SQLite 500s)
    const seenPresetIds = new Set<string>();
    for (const p of data.presets ?? []) {
      if (seenPresetIds.has(p.id)) {
        return c.json({ error: `Duplicate preset id in backup: ${p.id}` }, 400);
      }
      seenPresetIds.add(p.id);
    }

    const seenProgNodes = new Set<string>();
    for (const p of data.progress) {
      if (seenProgNodes.has(p.nodeId)) {
        return c.json({ error: `Duplicate progress nodeId in backup: ${p.nodeId}` }, 400);
      }
      if (resolveNodeIndex(store.rawProjection, p.nodeId) === undefined) {
        return c.json({ error: `Unknown DAG nodeId in progress backup: ${p.nodeId}` }, 400);
      }
      seenProgNodes.add(p.nodeId);
    }

    const seenCardIds = new Set<string>();
    const seenCardPairs = new Set<string>();
    for (const card of data.srsCards) {
      if (seenCardIds.has(card.id)) {
        return c.json({ error: `Duplicate SRS card id in backup: ${card.id}` }, 400);
      }
      const pairKey = `${card.node_id}:${card.card_type}`;
      if (seenCardPairs.has(pairKey)) {
        return c.json({ error: `Duplicate SRS card (${pairKey}) in backup` }, 400);
      }
      if (resolveNodeIndex(store.rawProjection, card.node_id) === undefined) {
        return c.json({ error: `Unknown DAG node_id in SRS card backup: ${card.node_id}` }, 400);
      }
      seenCardIds.add(card.id);
      seenCardPairs.add(pairKey);
    }

    const seenLogIds = new Set<string>();
    for (const log of data.reviewLogs ?? []) {
      if (seenLogIds.has(log.id)) {
        return c.json({ error: `Duplicate review log id in backup: ${log.id}` }, 400);
      }
      seenLogIds.add(log.id);
    }

    let insertedLogs = 0;

    withTransaction(db, () => {
      // Restore settings cleanly against DEFAULT_USER_SETTINGS (never inheriting stale pre-restore overrides)
      const restoredSettings = data.settings
        ? mergeUserSettings(DEFAULT_USER_SETTINGS, data.settings)
        : structuredClone(DEFAULT_USER_SETTINGS);
      db.prepare(
        `INSERT INTO user_settings (id, config_json, updated_at)
         VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET config_json = excluded.config_json, updated_at = excluded.updated_at`
      ).run(JSON.stringify(restoredSettings), new Date().toISOString());

      db.prepare("DELETE FROM review_logs").run();
      db.prepare("DELETE FROM srs_cards").run();
      db.prepare("DELETE FROM node_progress").run();
      if (data.presets) {
        db.prepare("DELETE FROM sandbox_presets").run();
        const insPreset = db.prepare(
          "INSERT INTO sandbox_presets (id, name, config_json, created_at) VALUES (?, ?, ?, ?)"
        );
        for (const p of data.presets) {
          insPreset.run(p.id, p.name, JSON.stringify(p.config), p.createdAt);
        }
      }

      const insProg = db.prepare(
        "INSERT INTO node_progress (node_id, status, source, notes, updated_at) VALUES (?, ?, ?, ?, ?)"
      );
      for (const p of data.progress) {
        insProg.run(p.nodeId, p.status, p.source, p.notes, p.updatedAt);
      }

      const insCard = db.prepare(
        `INSERT INTO srs_cards
          (id, node_id, card_type, due, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, state, last_review)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const card of data.srsCards) {
        insCard.run(
          card.id,
          card.node_id,
          card.card_type,
          card.due,
          card.stability,
          card.difficulty,
          card.elapsed_days,
          card.scheduled_days,
          card.reps,
          card.lapses,
          card.state,
          card.last_review
        );
      }

      if (data.reviewLogs) {
        const insLog = db.prepare(
          `INSERT INTO review_logs (id, card_id, node_id, card_type, rating, duration_ms, reviewed_at, fsrs_snapshot_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        );
        for (const log of data.reviewLogs) {
          if (!seenCardIds.has(log.card_id)) continue;
          insLog.run(
            log.id,
            log.card_id,
            log.node_id,
            log.card_type,
            log.rating,
            log.duration_ms,
            log.reviewed_at,
            log.fsrs_snapshot_json
          );
          insertedLogs++;
        }
      }
    });

    return c.json({
      ok: true,
      restoredProgress: data.progress.length,
      restoredCards: data.srsCards.length,
      restoredLogs: insertedLogs,
    });
  });

  app.all("/api/*", (c) => c.json({ error: "API endpoint not found" }, 404));

  // ---------------- Production SPA Static Asset Serving ----------------
  const webDist = resolve(config.webDistDir);
  app.get("*", (c) => {
    if (!existsSync(webDist)) {
      return c.text("FuLuoXiaoJie API server is running. Build apps/web to serve the UI.", 200);
    }
    const reqPath = c.req.path === "/" ? "/index.html" : c.req.path;
    const candidate = resolve(webDist, "." + reqPath);
    if (
      (candidate === webDist || candidate.startsWith(webDist + "/")) &&
      existsSync(candidate) &&
      statSync(candidate).isFile()
    ) {
      const ext = extname(candidate).toLowerCase();
      const mime = MIME_TYPES[ext] ?? "application/octet-stream";
      const isHashedAsset = reqPath.startsWith("/assets/");
      return new Response(readFileSync(candidate) as unknown as BodyInit, {
        status: 200,
        headers: {
          "Content-Type": mime,
          "Cache-Control": isHashedAsset ? "public, max-age=31536000, immutable" : "no-cache",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    const indexHtml = resolve(webDist, "index.html");
    if (existsSync(indexHtml)) {
      return new Response(readFileSync(indexHtml) as unknown as BodyInit, {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-cache",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
    return c.text("Frontend bundle not found.", 404);
  });

  return app;
}
