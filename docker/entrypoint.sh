#!/bin/sh
set -eu

if [ -z "${APP_ENCRYPTION_KEY:-}" ]; then
	echo "FATAL: APP_ENCRYPTION_KEY is not set. Generate one with: openssl rand -base64 32" >&2
	exit 1
fi
if [ -z "${BETTER_AUTH_SECRET:-}" ]; then
	echo "FATAL: BETTER_AUTH_SECRET is not set. Generate one with: openssl rand -base64 32" >&2
	exit 1
fi

DB_PATH="${DATABASE_PATH:-/data/app.db}"
mkdir -p "$(dirname "$DB_PATH")"

echo "Running database migrations..."
bun run --cwd /app/packages/db db:migrate

echo "Starting understory..."
exec bun run /app/apps/api/src/index.ts
