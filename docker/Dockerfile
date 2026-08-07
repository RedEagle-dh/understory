# ── pruner: compute per-app subsets of the workspace ────────────────────────
FROM oven/bun:1.3-slim AS pruner
WORKDIR /app
COPY . .
# Keep the turbo version in sync with the root package.json catalog.
RUN bunx turbo@2.10.8 prune @workspace/api --docker --out-dir out/api \
	&& bunx turbo@2.10.8 prune web --docker --out-dir out/web

# ── web-build: static SPA bundle ────────────────────────────────────────────
FROM oven/bun:1.3-slim AS web-build
WORKDIR /app
COPY --from=pruner /app/out/web/json/ ./
RUN bun install --frozen-lockfile
COPY --from=pruner /app/out/web/full/ ./
RUN bun run --filter web build

# ── api-deps: install only what the api (and its workspace deps) need ───────
FROM oven/bun:1.3-slim AS api-deps
WORKDIR /app
COPY --from=pruner /app/out/api/json/ ./
RUN bun install --frozen-lockfile

# ── runtime ─────────────────────────────────────────────────────────────────
FROM oven/bun:1.3-slim AS runtime
WORKDIR /app

# node + npm are needed only for PR lockfile regeneration
# (`npm install --package-lock-only`); bun handles bun.lock repos natively.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends nodejs npm ca-certificates \
	&& rm -rf /var/lib/apt/lists/*

# uv regenerates uv.lock for Python auto-PRs — a single static binary.
# poetry is NOT bundled (it drags in a Python toolchain); poetry projects get
# manifest-only PRs with a "run `poetry lock`" note unless the operator adds it.
# Pinned by version AND digest: this binary runs against third-party
# repository content, so the build must not track a mutable upstream tag.
COPY --from=ghcr.io/astral-sh/uv:0.12.3@sha256:2d890623d310b57771ce840f0da5eed5fc6d657da05ffaa45d82797b53fa3abc /uv /usr/local/bin/uv

# The whole installed tree, not just the root node_modules: bun's isolated
# layout gives every workspace package its own node_modules of symlinks.
COPY --from=api-deps /app ./
COPY --from=pruner /app/out/api/full/ ./
# Shared tsconfig bases live outside any workspace package, so prune skips them.
COPY tsconfig.base.json ./tsconfig.base.json
COPY packages/tsconfig.base.json ./packages/tsconfig.base.json
COPY packages/declarative/tsconfig.base.json ./packages/declarative/tsconfig.base.json
COPY docker/entrypoint.sh /app/docker/entrypoint.sh
COPY --from=web-build /app/apps/web/dist/client ./web

RUN chmod +x /app/docker/entrypoint.sh && mkdir -p /data && chown bun:bun /data

USER bun
VOLUME /data
# Stamped by CI from the release tag (v0.0.1 → the app strips the v);
# 'dev' disables the update check.
ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION}
ENV DATABASE_PATH=/data/app.db \
	PORT=3001 \
	HOST=0.0.0.0 \
	WEB_DIST_DIR=/app/web \
	NODE_ENV=production

EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
	CMD bun -e "fetch('http://127.0.0.1:3001/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/app/docker/entrypoint.sh"]
