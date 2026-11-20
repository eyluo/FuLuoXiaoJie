import { createHash, randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { ServerConfig } from "../config.js";
import type { AppDatabase } from "../db/database.js";

export const SESSION_COOKIE_NAME = "flxj_session";
export const MIN_PASSPHRASE_LENGTH = 8;

const SCRYPT_KEYLEN = 64;
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const HEX_RE = /^[0-9a-f]+$/i;

function scryptDerive(
  passphrase: string,
  salt: string,
  keylen: number,
  options: ScryptOptions
): Promise<Buffer> {
  return new Promise((resolvePromise, rejectPromise) => {
    scrypt(passphrase, salt, keylen, options, (err, derivedKey) => {
      if (err) rejectPromise(err);
      else resolvePromise(derivedKey);
    });
  });
}

function isPowerOfTwo(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

export async function hashPassphrase(
  passphrase: string,
  params: { N?: number; r?: number; p?: number } = {}
): Promise<string> {
  const N = params.N ?? SCRYPT_N;
  const r = params.r ?? SCRYPT_R;
  const p = params.p ?? SCRYPT_P;
  const salt = randomBytes(16).toString("hex");
  const maxmem = Math.max(32 * 1024 * 1024, 256 * N * r);
  const derived = await scryptDerive(passphrase, salt, SCRYPT_KEYLEN, { N, r, p, maxmem });
  return `scrypt:${N}:${r}:${p}:${salt}:${derived.toString("hex")}`;
}

export async function verifyPassphrase(passphrase: string, storedHash: string): Promise<boolean> {
  const parts = storedHash.split(":");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const N = Number.parseInt(parts[1]!, 10);
  const r = Number.parseInt(parts[2]!, 10);
  const p = Number.parseInt(parts[3]!, 10);
  const salt = parts[4]!;
  const expectedHex = parts[5]!;

  // Strictly validate stored scrypt parameters and hex digest before deriving (prevents 0-byte bypass or DoS)
  if (
    !Number.isInteger(N) ||
    !Number.isInteger(r) ||
    !Number.isInteger(p) ||
    N < 1024 ||
    N > 1 << 20 ||
    !isPowerOfTwo(N) ||
    r < 1 ||
    r > 32 ||
    p < 1 ||
    p > 16 ||
    salt.length < 8 ||
    expectedHex.length < 64 ||
    expectedHex.length % 2 !== 0 ||
    !HEX_RE.test(expectedHex)
  ) {
    return false;
  }

  const expectedBuf = Buffer.from(expectedHex, "hex");
  if (expectedBuf.length < 32) return false;

  try {
    const maxmem = Math.max(32 * 1024 * 1024, 256 * N * r);
    const derived = await scryptDerive(passphrase, salt, expectedBuf.length, { N, r, p, maxmem });
    if (derived.length !== expectedBuf.length) return false;
    return timingSafeEqual(derived, expectedBuf);
  } catch {
    return false;
  }
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function isPassphraseConfigured(db: AppDatabase): boolean {
  const row = db.prepare("SELECT id FROM auth_config WHERE id = 1").get();
  return row !== undefined;
}

/**
 * Atomic initial passphrase setup (INSERT OR IGNORE) eliminating TOCTOU race conditions.
 * Returns true if inserted, false if already configured.
 */
export async function setupInitialPassphraseAtomic(
  db: AppDatabase,
  passphrase: string
): Promise<boolean> {
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new Error(`Passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters.`);
  }
  const hash = await hashPassphrase(passphrase);
  const now = new Date().toISOString();
  const res = db
    .prepare(
      `INSERT OR IGNORE INTO auth_config (id, password_hash, created_at, updated_at)
       VALUES (1, ?, ?, ?)`
    )
    .run(hash, now, now);
  return Number(res.changes) === 1;
}

export function writePassphraseHash(db: AppDatabase, hash: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO auth_config (id, password_hash, created_at, updated_at)
     VALUES (1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET password_hash = excluded.password_hash, updated_at = excluded.updated_at`
  ).run(hash, now, now);
}

export async function bootstrapPassphraseFromEnv(db: AppDatabase, config: ServerConfig): Promise<void> {
  if (config.authDisabled) return;
  if (!config.appPassphrase) return;
  if (isPassphraseConfigured(db)) return;
  if (config.appPassphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new Error(
      `APP_PASSPHRASE env var must be at least ${MIN_PASSPHRASE_LENGTH} characters long.`
    );
  }
  await setupInitialPassphraseAtomic(db, config.appPassphrase);
}

export async function verifyStoredPassphrase(db: AppDatabase, passphrase: string): Promise<boolean> {
  const row = db.prepare("SELECT password_hash FROM auth_config WHERE id = 1").get() as
    | { password_hash: string }
    | undefined;
  if (!row) return false;
  return verifyPassphrase(passphrase, row.password_hash);
}

export function createSession(
  db: AppDatabase,
  ttlDays: number,
  userAgent = ""
): { token: string; expiresAt: Date } {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = sha256Hex(token);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000);

  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now.toISOString());
  db.prepare(
    "INSERT INTO sessions (token_hash, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?)"
  ).run(tokenHash, now.toISOString(), expiresAt.toISOString(), userAgent.slice(0, 200));

  return { token, expiresAt };
}

export function validateSessionToken(db: AppDatabase, token: string | undefined): boolean {
  if (!token || token.length < 20) return false;
  const tokenHash = sha256Hex(token);
  const row = db
    .prepare("SELECT expires_at FROM sessions WHERE token_hash = ?")
    .get(tokenHash) as { expires_at: string } | undefined;
  if (!row) return false;
  if (row.expires_at <= new Date().toISOString()) {
    db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
    return false;
  }
  return true;
}

export function revokeSessionToken(db: AppDatabase, token: string | undefined): void {
  if (!token) return;
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256Hex(token));
}

export function revokeAllSessionsExcept(db: AppDatabase, keepToken?: string): void {
  if (keepToken) {
    db.prepare("DELETE FROM sessions WHERE token_hash != ?").run(sha256Hex(keepToken));
  } else {
    db.prepare("DELETE FROM sessions").run();
  }
}

function getRightmostHeaderValue(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const parts = raw
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  return parts.length > 0 ? parts[parts.length - 1] : undefined;
}

export function isRequestSecure(c: Context, config: ServerConfig): boolean {
  if (config.trustProxy) {
    // Use rightmost proxy-appended protocol to prevent client spoofing via prepended X-Forwarded-Proto
    const proto = getRightmostHeaderValue(c.req.header("x-forwarded-proto"))?.toLowerCase();
    if (proto === "https") return true;
    if (proto === "http") return false;
  }
  return c.req.url.startsWith("https://");
}

export function setSessionCookie(c: Context, token: string, config: ServerConfig): void {
  setCookie(c, SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "Lax",
    secure: isRequestSecure(c, config),
    path: "/",
    maxAge: config.sessionTtlDays * 24 * 60 * 60,
  });
}

export function clearSessionCookie(c: Context, config: ServerConfig): void {
  deleteCookie(c, SESSION_COOKIE_NAME, {
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
    secure: isRequestSecure(c, config),
  });
}

export class LoginRateLimiter {
  private readonly attempts = new Map<string, number[]>();
  private readonly maxAttempts: number;
  private readonly windowMs: number;
  private readonly maxTrackedKeys: number;

  constructor(maxAttempts = 8, windowMs = 15 * 60 * 1000, maxTrackedKeys = 2000) {
    this.maxAttempts = maxAttempts;
    this.windowMs = windowMs;
    this.maxTrackedKeys = maxTrackedKeys;
  }

  private prune(key: string, now: number): number[] {
    const list = this.attempts.get(key) ?? [];
    const cutoff = now - this.windowMs;
    const recent = list.filter((ts) => ts > cutoff);
    if (recent.length === 0) {
      this.attempts.delete(key);
    } else {
      this.attempts.set(key, recent);
    }
    return recent;
  }

  check(key: string, now = Date.now()): { allowed: boolean; retryAfterSec: number } {
    const recent = this.prune(key, now);
    if (recent.length >= this.maxAttempts) {
      const oldest = recent[0]!;
      const retryAfterSec = Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000));
      return { allowed: false, retryAfterSec };
    }
    return { allowed: true, retryAfterSec: 0 };
  }

  recordFailure(key: string, now = Date.now()): void {
    const recent = this.prune(key, now);
    if (!this.attempts.has(key) && this.attempts.size >= this.maxTrackedKeys) {
      const firstKey = this.attempts.keys().next().value;
      if (firstKey !== undefined) this.attempts.delete(firstKey);
    }
    recent.push(now);
    this.attempts.set(key, recent);
  }

  reset(key: string): void {
    this.attempts.delete(key);
  }
}

function getSocketRemoteIp(c: Context): string | undefined {
  try {
    const info = getConnInfo(c);
    return info?.remote?.address || undefined;
  } catch {
    return undefined;
  }
}

export function getClientIp(c: Context, config: ServerConfig): string {
  if (config.trustProxy) {
    if (config.trustCloudflareIp) {
      const cfIp = c.req.header("cf-connecting-ip")?.trim();
      if (cfIp) return cfIp;
    }
    // Rightmost entry of X-Forwarded-For is appended by the trusted reverse proxy (cannot be spoofed by client prepending)
    const xffRight = getRightmostHeaderValue(c.req.header("x-forwarded-for"));
    if (xffRight) return xffRight;
    const xReal = c.req.header("x-real-ip")?.trim();
    if (xReal) return xReal;
  }
  return getSocketRemoteIp(c) ?? "local";
}

function normalizeOrigin(rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return `${u.protocol}//${u.host}`.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Strict same-origin CSRF guard checking Sec-Fetch-Site, Origin, and Referer (including protocol scheme).
 */
export function csrfOriginGuard(config: ServerConfig): MiddlewareHandler {
  return async (c, next) => {
    const method = c.req.method.toUpperCase();
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
      return next();
    }

    const fetchSite = c.req.header("sec-fetch-site")?.trim().toLowerCase();
    if (fetchSite === "cross-site") {
      return c.json({ error: "Cross-site request blocked" }, 403);
    }

    const expectedProto = isRequestSecure(c, config) ? "https:" : "http:";
    const expectedHost = (
      (config.trustProxy ? getRightmostHeaderValue(c.req.header("x-forwarded-host")) : undefined) ||
      c.req.header("host") ||
      new URL(c.req.url).host
    ).toLowerCase();
    const expectedOrigin = `${expectedProto}//${expectedHost}`;

    const origin = c.req.header("origin");
    if (origin) {
      const norm = normalizeOrigin(origin);
      if (!norm || norm !== expectedOrigin) {
        return c.json({ error: "Cross-origin request blocked" }, 403);
      }
      return next();
    }

    const referer = c.req.header("referer");
    if (referer) {
      const norm = normalizeOrigin(referer);
      if (!norm || norm !== expectedOrigin) {
        return c.json({ error: "Cross-origin referer blocked" }, 403);
      }
    }

    return next();
  };
}

export function requireAuthMiddleware(db: AppDatabase, config: ServerConfig): MiddlewareHandler {
  return async (c, next) => {
    if (config.authDisabled) {
      return next();
    }
    const token = getCookie(c, SESSION_COOKIE_NAME);
    if (!validateSessionToken(db, token)) {
      return c.json({ error: "Authentication required" }, 401);
    }
    return next();
  };
}
