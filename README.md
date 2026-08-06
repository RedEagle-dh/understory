<p align="center">
  <img src="apps/web/public/logo.svg" alt="understory" width="96" height="96" />
</p>

# understory

Self-hosted, open-source npm dependency auditing. Point it at your GitHub
repositories and it scans them every hour: every dependency (prod, dev, peer,
optional — direct and transitive, straight from the lockfile), checked against
the npm advisory database **and** OSV.dev, plus outdated-version detection
against the npm registry. It notifies you through email (Resend) or Discord,
and can open version-bump pull requests — manually from the UI, or
automatically when a fixable vulnerability appears.

## Features

- **Full dependency extraction** from `package-lock.json` (v1/v2/v3) and
  `bun.lock`, including workspaces, peer dependencies, depth, and declared
  ranges (`catalog:` ranges resolved). yarn/pnpm detection with a warning
  (parsers planned).
- **Two advisory sources, one truth** — npm bulk advisories + OSV.dev,
  normalized and merged by canonical ID (GHSA > CVE > OSV) with alias
  cross-referencing. Fix versions are computed across *all* ranges affecting a
  package.
- **Hourly scans without the thundering herd** — a per-minute dispatcher with
  per-project offsets, concurrency limits, ETag caching (unchanged repos cost
  almost no GitHub quota), and exponential backoff for failing projects.
- **Scan diffing** — every scan knows exactly which findings are new, which
  resolved, and which majors just appeared. That diff drives notifications.
- **Notifications** — Resend (email) and Discord (webhook) channels, global or
  per-project rules, severity thresholds, dedupe (a finding never notifies
  twice), retries with backoff, and a daily outdated digest.
- **Pull requests** — select dependencies in the UI, preview the exact
  `package.json` edits (operator-preserving range rewrites), and open a PR via
  the GitHub Git Data API (one commit, lockfile regenerated when possible).
  Auto-PR opens security bumps on its own, gated by severity and bump-kind
  thresholds. Deterministic branch names make retries converge instead of
  littering your repo.
- **Local users + RBAC** — the first account to sign up becomes the admin,
  then registration closes. Admins create users; roles are `viewer`,
  `maintainer`, `admin`.
- **Self-contained** — one container, one SQLite file, no external services
  required. Secrets (GitHub tokens, channel configs) are AES-256-GCM sealed at
  rest.

## Quick start (Docker)

```sh
git clone https://github.com/OWNER/understory && cd understory/docker
export APP_ENCRYPTION_KEY=$(openssl rand -base64 32)
export BETTER_AUTH_SECRET=$(openssl rand -base64 32)
docker compose up -d
```

Open http://localhost:3001, create the admin account (first signup only), add
a repository, and the first scan starts immediately.

Keep `APP_ENCRYPTION_KEY` safe — the database's sealed secrets are worthless
without it. Back up the SQLite file WAL-safely with
`sqlite3 /data/app.db ".backup /data/backup.db"`.

## Configuration

Everything is environment variables — see [.env.example](.env.example) for
the full annotated list. The essentials:

| Variable | Required | Purpose |
|---|---|---|
| `APP_ENCRYPTION_KEY` | yes | 32-byte base64 key sealing tokens/secrets at rest (`openssl rand -base64 32`) |
| `BETTER_AUTH_SECRET` | yes | Session signing secret |
| `APP_URL` | yes (prod) | Public origin — cookies, links in notifications |
| `GITHUB_TOKEN` | no | Fallback token when a project has none. A fine-grained PAT with `contents: read/write` + `pull requests: read/write` on selected repos is recommended; per-project tokens can be set in the UI |
| `SCAN_CONCURRENCY` | no | Parallel scans (default 3) |
| `ENABLE_LOCKFILE_REGEN` | no | Regenerate lockfiles in PRs (default true; needs npm in the image — included) |
| `DISABLE_OSV` | no | Skip the OSV.dev source |
| `METRICS_ENABLED` / `METRICS_TOKEN` | no | Prometheus `/metrics` (optionally bearer-gated) |

**Notifications:** Discord needs only a webhook URL. Email needs a
[Resend](https://resend.com) API key and a verified sending domain — without
one, Discord-only works fine.

## Development

Requirements: [Bun](https://bun.sh) ≥ 1.3.

```sh
bun install
cp .env.example apps/api/.env       # fill the two required keys
bun run --filter @workspace/api dev # API on :3001
bun run --filter web dev            # web on :3000 (proxies /api to :3001)
```

`bun run typecheck` / `bun run lint` / `bun test` / `bun run build` at the
root run everything through turbo. TypeScript 7 (native compiler) everywhere;
lint is biome; web formatting is prettier.

## Architecture

Monorepo (bun workspaces + turbo):

| Path | What it is |
|---|---|
| `apps/api` | Elysia + Bun API built on the vendored **declarative** framework — every route/job is a typed contract (validation, tracing, metrics, error mapping, access log come free), RBAC is a compile-enforced per-route `policy` declaration |
| `apps/web` | TanStack Start SPA (React 19, Tailwind v4, shadcn/ui) — fully typed against the API via Eden treaty, no hand-written client |
| `packages/audit-engine` | Pure domain logic: lockfile parsers, registry/OSV clients, advisory normalization + merge, outdated/fix/peer computation, bump planning. Zero I/O in tests |
| `packages/db` | Drizzle + bun:sqlite schema, migrations, sealed-secret crypto |
| `packages/ui` | Shared shadcn component library |
| `packages/declarative` | Vendored `@declarativejs/*` framework (see `VENDORED.md`) |

Design notes worth reading: `apps/web/DESIGN.md` (UI language) and the schema
comments in `packages/db/src/schema/` (content-addressed dependency snapshots,
the findings lifecycle that makes scan-diffing one indexed query).

## Security notes

- Tokens and channel secrets are AES-256-GCM sealed with AAD binding them to
  their owning row; key rotation is supported via `APP_ENCRYPTION_KEY_PREVIOUS`.
- Lockfile regeneration runs `npm install --package-lock-only --ignore-scripts`
  in a scrubbed temp environment — no dependency code ever executes.
- The API enforces RBAC server-side on every route; the UI's role gating is
  purely cosmetic on top.

## License

MIT
