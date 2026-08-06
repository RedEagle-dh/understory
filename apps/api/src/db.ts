import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createDb, runMigrations } from '@workspace/db';
import { env } from './env';

/**
 * Process-wide database handle. Migrations run at import time — idempotent
 * and fast; the Docker entrypoint additionally runs them pre-start.
 */
if (env.DATABASE_PATH !== ':memory:') {
	mkdirSync(dirname(env.DATABASE_PATH), { recursive: true });
}

const handle = createDb(env.DATABASE_PATH);
runMigrations(handle.db);

export const db = handle.db;
export const sqlite = handle.sqlite;
