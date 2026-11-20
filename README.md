# 弗洛小姐 · FuLuoXiaoJie

**FuLuoXiaoJie (弗洛小姐)** is a self-hosted, 100% offline-runtime web application that models **Simplified Mandarin characters as a frequency-weighted Directed Acyclic Graph (DAG)** — pairing an interactive component explorer and real-time graph-ranking sandbox with a dynamic study planner, Anki `.apkg` / `.csv` deck exporter, and a built-in 4-mode FSRS spaced-repetition studio.

Built to run effortlessly in a single Docker container on a **Raspberry Pi (ARM64)** or any Linux/macOS/Windows machine, using **Node.js 22's built-in `node:sqlite`** (zero native C++ compilation).

---

## Why a Character Composition DAG?

Written Simplified Mandarin characters decompose hierarchically into smaller standalone characters and bound semantic/phonetic primitives (for example, `晴 = 日 + 青`, `请 = 讠 + 青`, `品 = 3 × 口`). After pruning rare structural cycles in the CJKVI IDS / Make Me a Hanzi decomposition tables, the resulting structure is a verified **strict DAG** covering **4,242 nodes** (3,845 core Simplified characters + 397 bound primitives) and **8,515 weighted edges**, spanning **99.94% of spoken SUBTLEX-CH**, **99.65% of written Jun Da**, and **100% of HSK 3.0 Bands 1–9**.

Because the graph is acyclic, FuLuoXiaoJie computes exact character leverage scores in **under 5 ms directly in your browser**:

- **Raw Corpus Frequency:** Baseline spoken (`SUBTLEX-CH`), written (`Jun Da`), `HSK 3.0`, or custom blend with tunable Zipf transforms (`log`, `power`, `rank`, `raw`).
- **Reverse-Topological Propagation:** Propagates frequency mass downstream-to-upstream from compound characters to their building blocks in exact $O(V + E)$ time, weighted by semantic (`meaning`), phonetic (`sound`), and structural edge roles and optional component multiplicity (`品 = 3 × 口`).
- **Exact DAG Personalized PageRank:** Solves the exact closed-form DAG PPR recurrence in $O(V + E)$ with tunable damping $d \in [0, 1]$ — zero power-iteration drift or oscillation.
- **Bitset / CSR Ancestor Coverage:** Computes exact deduplicated corpus share across every character's reachable compound family without double-counting shared descendants.
- **Live Radical-Variant Merging:** Toggle contracted radical merging (`氵 → 水`, `讠 → 言`, `忄 → 心`, etc.) live and watch rankings, prerequisite chains, and coverage curves update instantaneously.

---

## Core Features

1. **Interactive DAG Explorer** — Cytoscape.js + Dagre focused neighborhood graph (upstream building blocks + downstream compound families), instant search by Hanzi/pinyin/English, offline stroke-order animation (Make Me a Hanzi), bundled offline syllable MP3s + Web Speech word audio, everyday SUBTLEX-ranked compound words, mastery toggles, and personal mnemonic notes.
2. **Real-Time Algorithm Sandbox** — Tune corpus presets, Zipf transforms, damping, edge-role weights, remaining-mass mode, and radical merging with a live log-scale Raw-vs-Algo rank scatter plot, cumulative corpus coverage curves, virtualized 4,200-row sortable table, and saved presets.
3. **Dynamic Study Planner & Anki Export** — Switch between **Priority-Weighted Topological** and **Greedy Marginal-Gain Unlock** queues with a tunable **Holistic Bypass (Top-N)** slider (so ultra-common words like `的` aren't held hostage by rare parts like `勺`), 4-mode Bulk Progress Import (HSK 3.0, Top-N frequency, pasted Chinese text, CSV/file), and one-click Anki `.apkg` (with embedded syllable MP3s) and `.csv` export.
4. **4-Mode FSRS Review Studio (`ts-fsrs`)** — Practice **Recognition** (with optional toned/numbered pinyin typing), **Interactive Stroke-Order Recall** (`hanzi-writer` quiz mode), **Component Breakdown** (with guaranteed non-ancestor distractors), and **Listening & Tone Drills** (offline MP3 + masked homophone context clues), with keyboard shortcuts (`Space`, `1–4`, `R`) and automatic stability-based promotion to `Known`.
5. **Progress Analytics, Backup & Security** — Spoken & written corpus coverage KPIs, HSK 3.0 mastery bars, 90-day review activity heatmap, 14-day due forecast, portable JSON backup & restore, and hardened single-user passphrase authentication (`scrypt`, `HttpOnly` + `SameSite=Lax` + `Secure` cookies, CSRF origin/fetch-metadata guard, and login rate limiting).

---

## Quick Start (Docker Compose — Raspberry Pi & Desktop)

### 1. Clone and configure

```bash
git clone https://github.com/<your-username>/FuLuoXiaoJie.git
cd FuLuoXiaoJie
cp .env.example .env
```

By default, `docker-compose.yml` binds strictly to `127.0.0.1:3000` (loopback only).
- If you want to open FuLuoXiaoJie directly from phones/tablets on your home Wi-Fi LAN (`http://<pi-lan-ip>:3000`), set `BIND_HOST=0.0.0.0` in `.env`.
- Leave `APP_PASSPHRASE` empty to create your passphrase through the browser on first visit, or set an initial passphrase (`>= 8` characters) in `.env`.

### 2. Build and start

```bash
docker compose up -d --build
```

> **First build note:** Stage 1 (`data-builder`) downloads ~75 MB of pinned open-source Mandarin datasets and audio archives, compiles `data/graph.json`, `data/examples.json`, 4,164 stroke JSONs, and 1,246 syllable MP3s (~23 MB compiled audio), and runs all 12 DAG invariant tests inside Docker. Subsequent builds reuse the cached data layer and rebuild in seconds.

Verify the container is healthy:

```bash
docker compose ps
curl http://127.0.0.1:3000/api/health
```

---

## Hosting on a Raspberry Pi & Accessing Outside Your Home Network

If you host FuLuoXiaoJie on a Raspberry Pi (Pi 4, Pi 5, or Pi Zero 2 W / 64-bit Raspberry Pi OS) on your home LAN and want to study from your phone or laptop away from home, **do not open ports on your home router**. Below are the recommended options ranked by security:

### Option 1 (Strongly Recommended): Tailscale + `tailscale serve`

**Why it is the safest choice for a single-user personal study app:**
- **Zero open router ports** — nothing is exposed to the public internet or automated vulnerability scanners.
- **WireGuard end-to-end encryption** across your private tailnet (only your signed-in phone/laptop/Pi can even see the service).
- **Automatic trusted HTTPS** (`https://<your-pi>.<tailnet>.ts.net`) with zero manual Let's Encrypt or Dynamic DNS maintenance, which also automatically activates `Secure` cookies and works cleanly on iOS/Android browsers.

**Setup on your Raspberry Pi:**
1. Keep `BIND_HOST=127.0.0.1` in `.env` and set `TRUST_PROXY=true`.
2. Restart the container: `docker compose up -d`
3. Install Tailscale on your Pi and phone/laptop, then publish the local port exclusively to your tailnet over HTTPS:
   ```bash
   sudo tailscale serve --bg http://127.0.0.1:3000
   ```
4. Open the `https://<pi-name>.<tailnet>.ts.net` URL printed by Tailscale from anywhere in the world.

### Option 2 (Best if You Want a Public Domain Without Installing a VPN Client): Cloudflare Tunnel + Cloudflare Access

If you want to access FuLuoXiaoJie from a browser where you cannot install Tailscale (such as a work laptop or shared device):
- Run `cloudflared` on your Raspberry Pi pointing at `http://127.0.0.1:3000` (again, **zero open router ports**, your home IP stays hidden).
- **Put Cloudflare Access (Zero Trust) in front of the hostname** (free for personal use) so visitors must authenticate with your email OTP / Google / GitHub identity *before* any packet reaches your Raspberry Pi.
- In `.env`, keep `BIND_HOST=127.0.0.1` and set:
  ```env
  TRUST_PROXY=true
  TRUST_CLOUDFLARE_IP=true
  ```

### Option 3 (Not Recommended): Direct Router Port Forwarding (Ports 80/443)

Port-forwarding your home router directly to a Raspberry Pi is **discouraged** for a personal self-hosted study app:
- Exposes your residential IP and Pi to continuous internet scanning and brute-force traffic.
- Requires you to maintain Dynamic DNS, TLS certificate renewals (e.g., Caddy/Nginx), firewall rules, and OS security updates continuously.
- Any misconfiguration sits directly on your home LAN.

Tailscale takes ~2 minutes to set up, is free for personal use, eliminates all of those operational risks, and keeps your Raspberry Pi completely invisible to the public internet.

### Raspberry Pi SD-Card Longevity & Backups

- FuLuoXiaoJie configures SQLite with `PRAGMA journal_mode = WAL` and `PRAGMA synchronous = NORMAL` to minimize write amplification on microSD cards while preserving crash safety.
- Still, microSD cards eventually wear out. Back up regularly using either:
  - **Built-in UI Export:** Go to **Stats & Settings → Download JSON Backup** to download a complete portable snapshot (`progress`, mnemonic notes, `srsCards`, `reviewLogs`, settings, and presets).
  - **Automated nightly crash-safe SQLite snapshot (`VACUUM INTO`) on the Pi:**
    ```bash
    # Creates an atomic, MVCC-consistent standalone snapshot without racing live WAL writes
    mkdir -p ~/fuluoxiaojie-backups
    docker compose exec -T fuluoxiaojie node -e '
      const fs = require("node:fs");
      const { DatabaseSync } = require("node:sqlite");
      const snap = "/tmp/fuluoxiaojie-backup.db";
      fs.rmSync(snap, { force: true });
      const db = new DatabaseSync("/data/fuluoxiaojie.db");
      db.exec("PRAGMA busy_timeout = 5000;");
      db.prepare("VACUUM INTO ?").run(snap);
      db.close();
    ' && docker cp fuluoxiaojie:/tmp/fuluoxiaojie-backup.db ~/fuluoxiaojie-backups/fuluoxiaojie-$(date +%F).db \
      && docker compose exec -T fuluoxiaojie rm -f /tmp/fuluoxiaojie-backup.db
    ```
  - If your Pi runs 24/7, booting from a USB SSD instead of a microSD card is an inexpensive reliability upgrade.

---

## Local Development (Without Docker)

**Prerequisites:** Node.js `>= 22.0.0`, `pnpm >= 9.0.0` (tested on `pnpm 12.21.0`), Python `3.12+` (stdlib only).

```bash
# 1. Install workspace dependencies
pnpm install

# 2. Build & verify the offline Mandarin DAG, stroke JSONs, and syllable MP3 pack
pnpm run data:build

# 3. Run typecheck, unit/integration tests, and production builds
pnpm run typecheck
pnpm run test
pnpm run build

# 4. Run dev servers (backend on :3000, Vite frontend on :5173 with /api proxy)
pnpm run dev
```

To run the built production server locally without Docker:

```bash
pnpm run build
node apps/server/dist/index.js
```

---

## Environment Variables Reference

| Variable | Default | Description |
| --- | --- | --- |
| `BIND_HOST` | `127.0.0.1` | Host interface published by `docker-compose.yml` (`127.0.0.1` for Tailscale/Tunnel, `0.0.0.0` for home LAN). |
| `HOST_PORT` | `3000` | Host port published by `docker-compose.yml` mapped to container port `3000`. |
| `PORT` | `3000` | HTTP port the Node server listens on inside the container. |
| `HOST` | `0.0.0.0` | Bind interface inside the container. |
| `DATA_DIR` | `./fuluoxiaojie-data` (`/data` in Docker) | Directory holding the persistent SQLite database (`fuluoxiaojie.db`). |
| `STATIC_DATA_DIR` | `./data` (`/app/data` in Docker) | Compiled read-only DAG JSON, examples, stroke JSONs, and offline MP3s. |
| `WEB_DIST_DIR` | `./apps/web/dist` (`/app/apps/web/dist` in Docker) | Built Vite SPA bundle served by Hono in production. |
| `APP_PASSPHRASE` | *(empty)* | Optional initial passphrase (`>= 8` chars) bootstrapped once if no passphrase exists yet in SQLite. |
| `AUTH_DISABLED` | `false` | Set `true` only for isolated local development or when an upstream Zero Trust proxy handles all authentication. |
| `TRUST_PROXY` | `false` | Set `true` when behind a local reverse proxy (Tailscale Serve, Caddy, cloudflared) so `X-Forwarded-Proto` and rightmost `X-Forwarded-For` are honored. |
| `TRUST_CLOUDFLARE_IP` | `false` | Set `true` (alongside `TRUST_PROXY=true`) only when traffic enters exclusively via Cloudflare Tunnel/Proxy to use `CF-Connecting-IP` for login rate limiting. |
| `SESSION_TTL_DAYS` | `30` | Persistent login session lifetime in days (`1–365`). |

---

## Architecture

```text
FuLuoXiaoJie/
├── scripts/build-data/      # Python 3.12 stdlib ETL pipeline + 12 hard DAG invariant tests
├── packages/graph-engine/   # Pure TypeScript CSR DAG engine, exact PPR, reverse-topo, planners
├── apps/server/             # Hono + Node 22 node:sqlite API, scrypt auth, FSRS scheduler, Anki .apkg
├── apps/web/                # React 19 + Vite + Vanilla CSS UI (Cytoscape.js, Hanzi Writer, offline audio)
├── Dockerfile               # 4-stage ARM64/AMD64 build (non-root runtime, read-only /app)
├── docker-compose.yml       # Loopback-bound self-hosted compose config with persistent volume
└── NOTICE.md                # Open-source dataset, stroke, and Mandarin audio attributions
```

---

## Data & Media Attributions

FuLuoXiaoJie bundles exclusively open-source and public-domain linguistic datasets, stroke-order vectors, and Mandarin syllable recordings so the runtime requires **zero external API or CDN calls**. Full dataset licenses and attributions are documented in [NOTICE.md](NOTICE.md).
