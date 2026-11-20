# syntax=docker/dockerfile:1

# =============================================================================
# 弗洛小姐 · FuLuoXiaoJie — Multi-stage ARM64 (Raspberry Pi) & AMD64 Dockerfile
# Zero native C++ builds (uses Node 22 built-in node:sqlite) & 100% offline media
# =============================================================================

# Stage 1: Build & invariant-test the Simplified Mandarin DAG, stroke JSONs, and offline MP3 pack
FROM python:3.12-slim AS data-builder
WORKDIR /build

COPY scripts/build-data ./scripts/build-data
RUN python3 scripts/build-data/build_all.py

# Stage 2: Build TypeScript workspace (graph-engine, server, and Vite React frontend)
FROM node:22-slim AS app-builder
WORKDIR /app

RUN npm install -g pnpm@12.21.0

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/graph-engine/package.json ./packages/graph-engine/
COPY apps/server/package.json ./apps/server/
COPY apps/web/package.json ./apps/web/

RUN pnpm install --frozen-lockfile

COPY packages ./packages
COPY apps ./apps

RUN pnpm -r build

# Stage 3: Install production-only dependencies for @fuluoxiaojie/server (pure JS, no devDeps/React/Vite)
FROM node:22-slim AS prod-deps
WORKDIR /app

RUN npm install -g pnpm@12.21.0

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/graph-engine/package.json ./packages/graph-engine/
COPY apps/server/package.json ./apps/server/
COPY apps/web/package.json ./apps/web/

RUN pnpm install --prod --frozen-lockfile --filter @fuluoxiaojie/server...

# Stage 4: Slim non-root runtime image (read-only /app, writable /data volume for SQLite)
FROM node:22-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DATA_DIR=/data \
    STATIC_DATA_DIR=/app/data \
    WEB_DIST_DIR=/app/apps/web/dist

COPY --from=prod-deps /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/packages/graph-engine/package.json ./packages/graph-engine/
COPY --from=app-builder /app/packages/graph-engine/dist ./packages/graph-engine/dist
COPY --from=prod-deps /app/apps/server/package.json ./apps/server/
COPY --from=prod-deps /app/apps/server/node_modules ./apps/server/node_modules
COPY --from=app-builder /app/apps/server/dist ./apps/server/dist
COPY --from=app-builder /app/apps/web/dist ./apps/web/dist
COPY --from=data-builder /build/data ./data
COPY NOTICE.md ./NOTICE.md

# Only /data is writable by the non-root node user; /app stays immutable
RUN mkdir -p /data && chown node:node /data

USER node
EXPOSE 3000
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "apps/server/dist/index.js"]
