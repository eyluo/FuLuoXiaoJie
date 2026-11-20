import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { unzipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { hashPassphrase, LoginRateLimiter, verifyPassphrase } from "../src/auth/auth.js";
import { loadServerConfig } from "../src/config.js";
import { loadStaticDataStore, type StaticDataStore } from "../src/data/staticLoader.js";
import { openDatabase, type AppDatabase } from "../src/db/database.js";
import { buildComponentChoices, buildListeningChoices } from "../src/services/srs.js";

function extractCookie(res: Response): string {
  const raw = res.headers.get("set-cookie") ?? "";
  const m = raw.match(/(flxj_session=[^;]+)/);
  return m ? m[1]! : "";
}

describe("FuLuoXiaoJie Backend API Integration", () => {
  const staticDataDir = resolve(process.cwd(), "../../data");
  let store: StaticDataStore;
  let db: AppDatabase;

  beforeAll(() => {
    store = loadStaticDataStore(staticDataDir);
  });

  afterAll(() => {
    try {
      db?.close();
    } catch {
      // ignore
    }
  });

  function makeTestContext(overrides: { authDisabled?: boolean; maxLoginAttempts?: number } = {}) {
    const testDb = openDatabase(":memory:");
    const config = loadServerConfig({
      dbPath: ":memory:",
      staticDataDir,
      authDisabled: overrides.authDisabled ?? false,
      trustProxy: true,
    });
    const limiter = new LoginRateLimiter(overrides.maxLoginAttempts ?? 4, 60_000);
    const app = createApp({ db: testDb, store, config, rateLimiter: limiter });
    return { app, db: testDb, config };
  }

  it("validates stored scrypt N/r/p parameters strictly and rejects malformed/0-byte hashes", async () => {
    const customHash = await hashPassphrase("strong-pass-123", { N: 4096, r: 8, p: 1 });
    expect(customHash.startsWith("scrypt:4096:8:1:")).toBe(true);
    expect(await verifyPassphrase("strong-pass-123", customHash)).toBe(true);
    expect(await verifyPassphrase("wrong-pass-123", customHash)).toBe(false);

    // Malformed / non-hex / 0-byte digest / bad N must ALWAYS return false (never 0-byte timingSafeEqual bypass)
    expect(await verifyPassphrase("anything", "scrypt:16384:8:1:0123456789abcdef:zzzz")).toBe(false);
    expect(await verifyPassphrase("anything", "scrypt:16384:8:1:0123456789abcdef:")).toBe(false);
    expect(await verifyPassphrase("anything", "scrypt:12345:8:1:0123456789abcdef:" + "aa".repeat(64))).toBe(false);
  });

  it("enforces atomic setup, rightmost proxy IP rate-limiting, scheme+Referer+Sec-Fetch-Site CSRF, and session rotation", async () => {
    const ctx = makeTestContext({ maxLoginAttempts: 3 });
    db = ctx.db;

    const health = await ctx.app.request("/api/health");
    expect(health.status).toBe(200);
    expect((await health.json()).app).toBe("FuLuoXiaoJie");

    const st0 = await (await ctx.app.request("/api/auth/status")).json();
    expect(st0).toEqual({ authDisabled: false, configured: false, authenticated: false });
    expect((await ctx.app.request("/api/progress")).status).toBe(401);
    expect((await ctx.app.request("/api/data/graph")).status).toBe(401);

    // Concurrent first-run setup race: strictly one succeeds (200) and the second gets 409
    const [r1, r2] = await Promise.all([
      ctx.app.request("/api/auth/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forwarded-Proto": "https" },
        body: JSON.stringify({ passphrase: "mandarin-dag-secret" }),
      }),
      ctx.app.request("/api/auth/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forwarded-Proto": "https" },
        body: JSON.stringify({ passphrase: "competing-setup-pass" }),
      }),
    ]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 409]);

    const winner = r1.status === 200 ? r1 : r2;
    const winnerPass = r1.status === 200 ? "mandarin-dag-secret" : "competing-setup-pass";
    const setCookieHeader = winner.headers.get("set-cookie") ?? "";
    expect(setCookieHeader).toContain("HttpOnly");
    expect(setCookieHeader).toContain("SameSite=Lax");
    expect(setCookieHeader).toContain("Secure");
    expect(winner.headers.get("cache-control")).toBe("no-store");
    const cookie1 = extractCookie(winner);

    // CSRF checks: cross-origin Origin, scheme mismatch (http vs https), cross-site Sec-Fetch-Site, cross-origin Referer
    const csrfOrigin = await ctx.app.request("http://pi.local:3000/api/progress/%E9%9D%92", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: cookie1, Origin: "https://evil.example.com" },
      body: JSON.stringify({ status: "known" }),
    });
    expect(csrfOrigin.status).toBe(403);

    const csrfScheme = await ctx.app.request("http://pi.local:3000/api/progress/%E9%9D%92", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie1,
        "X-Forwarded-Proto": "https",
        Origin: "http://pi.local:3000",
      },
      body: JSON.stringify({ status: "known" }),
    });
    expect(csrfScheme.status).toBe(403);

    const csrfFetchSite = await ctx.app.request("http://pi.local:3000/api/progress/%E9%9D%92", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: cookie1, "Sec-Fetch-Site": "cross-site" },
      body: JSON.stringify({ status: "known" }),
    });
    expect(csrfFetchSite.status).toBe(403);

    const csrfReferer = await ctx.app.request("http://pi.local:3000/api/progress/%E9%9D%92", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: cookie1, Referer: "https://evil.example.com/attack" },
      body: JSON.stringify({ status: "known" }),
    });
    expect(csrfReferer.status).toBe(403);

    // Same-origin mutating request succeeds
    const okPut = await ctx.app.request("http://pi.local:3000/api/progress/%E9%9D%92", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: cookie1, Origin: "http://pi.local:3000" },
      body: JSON.stringify({ status: "known", notes: "green/blue radical family" }),
    });
    expect(okPut.status).toBe(200);

    // Rate limiting uses RIGHTMOST X-Forwarded-For and ignores spoofed leftmost XFF & untrusted CF-Connecting-IP
    for (let i = 0; i < 3; i++) {
      const bad = await ctx.app.request("/api/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "CF-Connecting-IP": `198.51.100.${i}`,
          "X-Forwarded-For": `192.0.2.${i}, 203.0.113.10`,
        },
        body: JSON.stringify({ passphrase: "wrong-passphrase" }),
      });
      expect(bad.status).toBe(401);
    }
    const throttled = await ctx.app.request("/api/auth/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "CF-Connecting-IP": "198.51.100.99",
        "X-Forwarded-For": "192.0.2.99, 203.0.113.10",
      },
      body: JSON.stringify({ passphrase: winnerPass }),
    });
    expect(throttled.status).toBe(429);

    // Change passphrase rotates session atomically and revokes old session
    const changeRes = await ctx.app.request("/api/auth/change-passphrase", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie1 },
      body: JSON.stringify({ currentPassphrase: winnerPass, newPassphrase: "brand-new-secret-2026" }),
    });
    expect(changeRes.status).toBe(200);
    const cookie2 = extractCookie(changeRes);
    expect(cookie2).not.toBe(cookie1);
    expect((await ctx.app.request("/api/progress", { headers: { Cookie: cookie1 } })).status).toBe(401);
    expect((await ctx.app.request("/api/progress", { headers: { Cookie: cookie2 } })).status).toBe(200);

    // Logout sets HttpOnly/SameSite on deletion and revokes cookie2
    const logoutRes = await ctx.app.request("/api/auth/logout", { method: "POST", headers: { Cookie: cookie2 } });
    expect(logoutRes.headers.get("set-cookie")).toContain("HttpOnly");
    expect((await ctx.app.request("/api/progress", { headers: { Cookie: cookie2 } })).status).toBe(401);

    ctx.db.close();
  });

  it("serves protected static data with private Cache-Control, blocks path traversal, and handles %25 URI params cleanly", async () => {
    const { app, db: tdb } = makeTestContext({ authDisabled: true });

    const graphRes = await app.request("/api/data/graph");
    expect(graphRes.status).toBe(200);
    expect(graphRes.headers.get("cache-control")).toContain("private");

    const strokeOk = await app.request("/api/data/strokes/u9752.json");
    expect(strokeOk.status).toBe(200);
    expect(strokeOk.headers.get("cache-control")).toContain("private");

    const audioOk = await app.request("/api/data/audio/qing1.mp3");
    expect(audioOk.status).toBe(200);
    expect(audioOk.headers.get("cache-control")).toContain("private");

    // Path traversal strictly rejected
    expect((await app.request("/api/data/strokes/..%2Fgraph.json")).status).toBe(404);
    expect((await app.request("/api/data/audio/..%2F..%2Fpackage.json")).status).toBe(404);

    // Malformed percent param (%25 -> "%") returns clean 404/200 instead of 500 URIError
    const badPut = await app.request("/api/progress/%25", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "known" }),
    });
    expect(badPut.status).toBe(404);

    const badDel = await app.request("/api/srs/node/%25", { method: "DELETE" });
    expect(badDel.status).toBe(200);

    tdb.close();
  });

  it("keeps variant-merged progress/SRS/stats consistent and ensures solvable listening & non-ancestor component distractors", async () => {
    const { app, db: tdb } = makeTestContext({ authDisabled: true });

    await app.request("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ srs: { masteryStabilityDays: 1 } }),
    });

    // PUT on variant alias '氵' resolves canonically to '水' under mergeVariants=true
    const varPut = await app.request(`/api/progress/${encodeURIComponent("氵")}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "learning", notes: "three drops of water" }),
    });
    expect(varPut.status).toBe(200);
    expect((await varPut.json()).nodeId).toBe("水");

    // Enroll 水 -> due card sees canonical notes written via '氵'
    await app.request("/api/srs/enroll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nodeIds: ["水", "晴"] }),
    });

    const dueRes = await app.request("/api/srs/due?limit=20");
    const dueJson = await dueRes.json();
    const shuiCard = dueJson.cards.find((c: { node: { id: string } }) => c.node.id === "水");
    expect(shuiCard.notes).toBe("three drops of water");

    // Component choices for 晴 (日 + 青, where 青 contains 月) must NOT include transitive ancestor 月 as a distractor!
    const qingComp = dueJson.cards.find(
      (c: { node: { id: string }; card: { card_type: string } }) =>
        c.node.id === "晴" && c.card.card_type === "component"
    );
    expect(qingComp.componentChoices.some((ch: { id: string }) => ch.id === "月")).toBe(false);
    // Non-component cards don't waste CPU building componentChoices
    const qingRecog = dueJson.cards.find(
      (c: { node: { id: string }; card: { card_type: string } }) =>
        c.node.id === "晴" && c.card.card_type === "recognition"
    );
    expect(qingRecog.componentChoices).toEqual([]);
    expect(qingRecog.listeningChoices).toEqual([]);

    // Verify listening choices NEVER include exact homophones (same primary syllable / audio) across difficult chars
    const proj = store.mergedProjection;
    for (const ch of ["晴", "钚", "仨", "叁", "艘"]) {
      const idx = proj.idToIndex.get(ch);
      if (idx === undefined) continue;
      const node = proj.nodes[idx]!;
      const choices = buildListeningChoices(proj, node);
      expect(choices.length).toBe(4);
      const exactSameAudio = choices.filter((c) => {
        const cn = proj.nodes[proj.idToIndex.get(c.id)!]!;
        return cn.id !== node.id && (cn.audio === node.audio || cn.syllables[0] === node.syllables[0]);
      });
      expect(exactSameAudio).toEqual([]);
    }

    // Verify component distractor exclusion directly on 晴
    const qingIdx = proj.idToIndex.get("晴")!;
    const compChoices = buildComponentChoices(proj, qingIdx, ["日", "青"]);
    expect(compChoices.some((c) => c.id === "月")).toBe(false);

    // Review 晴 recognition card -> auto-promotes to known, and stats.dueNow matches due.dueCount
    const revRes = await app.request("/api/srs/review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cardId: qingRecog.card.id, rating: 4, durationMs: 2100 }),
    });
    expect(revRes.status).toBe(200);
    expect((await revRes.json()).promotedToKnown).toBe(true);

    // Disabling 'stroke' mode updates both /api/srs/due and /api/srs/stats consistently
    await app.request("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ srs: { enabledModes: { stroke: false } } }),
    });
    const dueAfter = await (await app.request("/api/srs/due")).json();
    const statsAfter = await (await app.request("/api/srs/stats")).json();
    expect(statsAfter.dueNow).toBe(dueAfter.dueCount);

    // Deleting by variant alias '氵' removes canonical '水' SRS cards cleanly
    const delRes = await app.request(`/api/srs/node/${encodeURIComponent("氵")}`, { method: "DELETE" });
    expect((await delRes.json()).deletedCards).toBeGreaterThan(0);

    tdb.close();
  });

  it("escapes Anki .apkg HTML & validates empty exports, and rejects invalid/duplicate/corrupt backup imports with 400", async () => {
    const { app, db: tdb } = makeTestContext({ authDisabled: true });

    // Unknown-only Anki export returns 400 instead of empty 200 deck
    const emptyAnki = await app.request("/api/export/anki", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ format: "apkg", nodeIds: ["NOT_A_HANZI"] }),
    });
    expect(emptyAnki.status).toBe(400);

    // Export 研 (gloss contains 'R&D') + 品 + 青 and verify HTML escaping, req array, and string curModel
    const apkgRes = await app.request("/api/export/anki", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ format: "apkg", nodeIds: ["研", "品", "青"], deckTitle: "Audit Deck" }),
    });
    expect(apkgRes.status).toBe(200);
    const unpacked = unzipSync(new Uint8Array(await apkgRes.arrayBuffer()));
    const tmp = mkdtempSync(join(tmpdir(), "flxj-apkg-audit-"));
    try {
      const colPath = join(tmp, "collection.anki2");
      writeFileSync(colPath, unpacked["collection.anki2"]!);
      const ankiDb = new DatabaseSync(colPath);
      const colRow = ankiDb.prepare("SELECT conf, models FROM col WHERE id = 1").get() as {
        conf: string;
        models: string;
      };
      const conf = JSON.parse(colRow.conf);
      expect(typeof conf.curModel).toBe("string");
      const models = JSON.parse(colRow.models);
      const model = Object.values(models)[0] as { req: unknown };
      expect(model.req).toEqual([[0, "all", [0]]]);

      const yanRow = ankiDb.prepare("SELECT flds FROM notes WHERE sfld = ?").get("研") as { flds: string };
      expect(yanRow.flds).toContain("&amp;");
      expect(yanRow.flds).not.toContain("R&D");
      ankiDb.close();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }

    // Reject corrupt backup imports with 400 (bad ISO date, negative stability, duplicate nodeId)
    const badDateBackup = await app.request("/api/backup/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        version: 1,
        progress: [],
        srsCards: [
          {
            id: "c1",
            node_id: "青",
            card_type: "recognition",
            due: "not-a-date",
            stability: -5,
            difficulty: 999,
            elapsed_days: 0,
            scheduled_days: 0,
            reps: 1,
            lapses: 0,
            state: 2,
            last_review: null,
          },
        ],
      }),
    });
    expect(badDateBackup.status).toBe(400);

    const dupProgBackup = await app.request("/api/backup/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        version: 1,
        progress: [
          { nodeId: "青", status: "known", source: "manual", notes: "", updatedAt: "2026-01-01T00:00:00Z" },
          { nodeId: "青", status: "known", source: "manual", notes: "", updatedAt: "2026-01-01T00:00:00Z" },
        ],
        srsCards: [],
      }),
    });
    expect(dupProgBackup.status).toBe(400);

    // Valid backup with an orphan reviewLog returns accurate restoredLogs = 0 (not 1)
    const orphanRes = await app.request("/api/backup/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        version: 1,
        progress: [
          { nodeId: "青", status: "known", source: "manual", notes: "ok", updatedAt: "2026-01-01T00:00:00Z" },
        ],
        srsCards: [],
        reviewLogs: [
          {
            id: "orphan-log-1",
            card_id: "missing-card",
            node_id: "青",
            card_type: "recognition",
            rating: 3,
            duration_ms: 1000,
            reviewed_at: "2026-01-01T00:00:00Z",
            fsrs_snapshot_json: "{}",
          },
        ],
      }),
    });
    expect(orphanRes.status).toBe(200);
    expect((await orphanRes.json()).restoredLogs).toBe(0);

    tdb.close();
  });
});
