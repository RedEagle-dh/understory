# Vendored: @declarativejs/* framework

These packages are vendored (copied, not forked-on-npm) from the private `declarative` monorepo.

- **Upstream**: `~/developer/modlog/declarative` (private)
- **Upstream commit**: `18dc094c11196a536365130b8347ed8f08a3eb99`
- **Vendored on**: 2026-08-06
- **Packages**: `core`, `logger`, `cli`, `modules/observability`, `modules/rate-limit`, `modules/cache`
  (upstream `packages/modules/*` maps to `packages/declarative/modules/*` here)

## Rules

- Package names are kept as upstream (`@declarativejs/core`, …) so internal `workspace:*` and
  `catalog:` references resolve unchanged. The root catalog of THIS repo must provide every
  `catalog:` entry these packages reference (`elysia`, `@sinclair/typebox`, `pino`, `pino-pretty`,
  `prom-client`, `@types/bun`, `@types/node`, `typescript`).
- Do not edit vendored sources casually — keep the diff against upstream at zero where possible so
  re-syncing stays a plain copy. If a local patch is unavoidable, document it below.
- TypeScript: upstream typechecks against 5.7.3; this repo pins the newest TypeScript (7.x native
  compiler) via the root catalog. If a vendored package ever breaks under the newest TS, document
  the pin-down here.

## Re-sync procedure

```sh
cd ~/developer/modlog/declarative && git pull
for p in core logger cli; do rsync -a --delete --exclude node_modules packages/$p/ <this-repo>/packages/declarative/$p/; done
for m in observability rate-limit cache; do rsync -a --delete --exclude node_modules packages/modules/$m/ <this-repo>/packages/declarative/modules/$m/; done
# update the commit SHA above, re-run: bun install && bun run typecheck && bun test packages/declarative
```

## Local patches

- None to vendored sources. The vendored tsconfigs extend `../../tsconfig.base.json` /
  `../../../tsconfig.base.json` relative to their upstream location; since this repo nests them one
  level deeper, two shim files outside the vendored trees re-route those paths:
  `packages/tsconfig.base.json` and `packages/declarative/tsconfig.base.json` (both just extend the
  repo-root `tsconfig.base.json`).
