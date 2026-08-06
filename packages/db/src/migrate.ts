import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { createDb, type Db } from './client';

// Resolved relative to this file (not process.cwd()) so migrations work
// regardless of which directory the caller runs from.
const MIGRATIONS_FOLDER = new URL('../migrations', import.meta.url).pathname;

export function runMigrations(db: Db): void {
	migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}

// CLI entry point: `bun run src/migrate.ts` (wired as the `db:migrate`
// package script, and as the Docker entrypoint's pre-start step).
if (import.meta.main) {
	const path = process.env.DATABASE_PATH ?? './data/app.db';
	if (path !== ':memory:') {
		await mkdir(dirname(path), { recursive: true });
	}
	const { db } = createDb(path);
	runMigrations(db);
	console.log(`Migrated database at ${path}`);
}
