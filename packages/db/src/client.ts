import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import * as schema from './schema/index';

/**
 * Opens (or creates) a SQLite database at `path` and returns a Drizzle
 * client wired to it. Pass `:memory:` for tests.
 *
 * PRAGMAs applied: WAL journaling, NORMAL synchronous (safe under WAL),
 * foreign key enforcement, a 5s busy timeout so concurrent writers back off
 * instead of erroring immediately, and a 16MB page cache.
 */
export function createDb(path: string) {
	const sqlite = new Database(path, { create: true });

	sqlite.exec('PRAGMA journal_mode = WAL;');
	sqlite.exec('PRAGMA synchronous = NORMAL;');
	sqlite.exec('PRAGMA foreign_keys = ON;');
	sqlite.exec('PRAGMA busy_timeout = 5000;');
	sqlite.exec('PRAGMA cache_size = -16000;');

	const db = drizzle(sqlite, { schema });

	return { db, sqlite };
}

export type Db = ReturnType<typeof createDb>['db'];
