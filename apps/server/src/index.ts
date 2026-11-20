import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { bootstrapPassphraseFromEnv } from "./auth/auth.js";
import { loadServerConfig } from "./config.js";
import { loadStaticDataStore } from "./data/staticLoader.js";
import { openDatabase } from "./db/database.js";

async function main() {
  const config = loadServerConfig();
  const db = openDatabase(config.dbPath);
  await bootstrapPassphraseFromEnv(db, config);
  const store = loadStaticDataStore(config.staticDataDir);

  const app = createApp({ db, store, config });

  const server = serve(
    {
      fetch: app.fetch,
      port: config.port,
      hostname: config.host,
    },
    (info) => {
      console.log(
        `FuLuoXiaoJie (弗洛小姐) listening on http://${info.address}:${info.port} ` +
          `(nodes=${store.graph.meta.nodeCount}, auth=${config.authDisabled ? "disabled" : "passphrase"})`
      );
    }
  );

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}, shutting down cleanly...`);

    const forceTimer = setTimeout(() => {
      try {
        db.close();
      } catch {
        // Ignore close error
      }
      process.exit(0);
    }, 5000);
    forceTimer.unref();

    const httpSrv = server as unknown as {
      close: (cb: () => void) => void;
      closeIdleConnections?: () => void;
    };
    httpSrv.closeIdleConnections?.();
    httpSrv.close(() => {
      clearTimeout(forceTimer);
      try {
        db.close();
      } catch {
        // Ignore close error
      }
      process.exit(0);
    });
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("Fatal server startup error:", err);
  process.exit(1);
});
