import { resolve } from "node:path";

export interface ServerConfig {
  port: number;
  host: string;
  dataDir: string;
  dbPath: string;
  staticDataDir: string;
  webDistDir: string;
  appPassphrase: string;
  authDisabled: boolean;
  trustProxy: boolean;
  trustCloudflareIp: boolean;
  sessionTtlDays: number;
}

export function loadServerConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  const cwd = process.cwd();
  const defaultStaticDir = resolve(
    process.env.STATIC_DATA_DIR ||
      (cwd.endsWith("/apps/server") ? resolve(cwd, "../../data") : resolve(cwd, "data"))
  );
  const defaultWebDistDir = resolve(
    process.env.WEB_DIST_DIR ||
      (cwd.endsWith("/apps/server") ? resolve(cwd, "../web/dist") : resolve(cwd, "apps/web/dist"))
  );
  const dataDir = overrides.dataDir
    ? resolve(overrides.dataDir)
    : resolve(process.env.DATA_DIR || resolve(cwd, "fuluoxiaojie-data"));
  const dbPath =
    overrides.dbPath ?? (dataDir === ":memory:" ? ":memory:" : resolve(dataDir, "fuluoxiaojie.db"));

  const portParsed = Number.parseInt(process.env.PORT || "3000", 10);
  const ttlParsed = Number.parseInt(process.env.SESSION_TTL_DAYS || "30", 10);

  return {
    port: Number.isFinite(portParsed) && portParsed > 0 ? portParsed : 3000,
    host: process.env.HOST || "0.0.0.0",
    dataDir,
    dbPath,
    staticDataDir: defaultStaticDir,
    webDistDir: defaultWebDistDir,
    appPassphrase: (process.env.APP_PASSPHRASE || "").trim(),
    authDisabled: process.env.AUTH_DISABLED === "true",
    trustProxy: process.env.TRUST_PROXY === "true",
    trustCloudflareIp: process.env.TRUST_CLOUDFLARE_IP === "true",
    sessionTtlDays: Number.isFinite(ttlParsed) && ttlParsed >= 1 ? Math.min(365, ttlParsed) : 30,
    ...overrides,
  };
}
