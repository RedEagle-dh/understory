import type { Database } from 'bun:sqlite';

/**
 * "First user becomes admin, then registration closes" — race-free.
 *
 * The naive `count(users) === 0` check races two concurrent signups into two
 * admins. Instead the app_settings singleton carries a latch column; the
 * UPDATE below flips it exactly once (SQLite serializes writers), so exactly
 * one signup ever wins the claim.
 */
export function claimBootstrap(sqlite: Database, now: Date): boolean {
	const result = sqlite
		.query(
			`UPDATE app_settings SET setup_completed_at = ?1, updated_at = ?1
			 WHERE id = 1 AND setup_completed_at IS NULL`
		)
		.run(now.getTime());
	return result.changes === 1;
}

export function isSetupRequired(sqlite: Database): boolean {
	const row = sqlite
		.query(
			'SELECT setup_completed_at AS done FROM app_settings WHERE id = 1'
		)
		.get() as { done: number | null } | null;
	return row === null || row.done === null;
}

/** Idempotently creates the app_settings singleton row. */
export function ensureAppSettings(sqlite: Database, now: Date): void {
	sqlite
		.query(
			`INSERT INTO app_settings (id, created_at, updated_at)
			 VALUES (1, ?1, ?1) ON CONFLICT (id) DO NOTHING`
		)
		.run(now.getTime());
}
