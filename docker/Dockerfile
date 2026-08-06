# ── deps: install the full workspace once ───────────────────────────────────
FROM oven/bun:1.3-slim AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/ui/package.json packages/ui/
COPY packages/db/package.json packages/db/
COPY packages/audit-engine/package.json packages/audit-engine/
COPY packages/declarative/core/package.json packages/declarative/core/
COPY packages/declarative/logger/package.json packages/declarative/logger/
COPY packages/declarative/cli/package.json packages/declarative/cli/
COPY packages/declarative/modules/observability/package.json packages/declarative/modules/observability/
COPY packages/declarative/modules/rate-limit/package.json packages/declarative/modules/rate-limit/
COPY packages/declarative/modules/cache/package.json packages/declarative/modules/cache/
RUN bun install --frozen-lockfile

# ── web-build: static SPA bundle ────────────────────────────────────────────
FROM deps AS web-build
COPY . .
RUN bun run --filter web build

# ── runtime ─────────────────────────────────────────────────────────────────
FROM oven/bun:1.3-slim AS runtime
WORKDIR /app

# node + npm are needed only for PR lockfile regeneration
# (`npm install --package-lock-only`); bun handles bun.lock repos natively.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends nodejs npm ca-certificates \
	&& rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock tsconfig.base.json ./
COPY apps/api ./apps/api
COPY packages/db ./packages/db
COPY packages/audit-engine ./packages/audit-engine
COPY packages/declarative ./packages/declarative
COPY packages/tsconfig.base.json ./packages/tsconfig.base.json
COPY docker/entrypoint.sh /app/docker/entrypoint.sh
COPY --from=web-build /app/apps/web/dist/client ./web

RUN chmod +x /app/docker/entrypoint.sh && mkdir -p /data && chown bun:bun /data

USER bun
VOLUME /data
ENV DATABASE_PATH=/data/app.db \
	PORT=3001 \
	HOST=0.0.0.0 \
	WEB_DIST_DIR=/app/web \
	NODE_ENV=production

EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
	CMD bun -e "fetch('http://127.0.0.1:3001/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/app/docker/entrypoint.sh"]
