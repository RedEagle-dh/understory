/**
 * Central env access — the single place `process.env` is read.
 * Fails fast at boot on missing/invalid required configuration.
 */

function required(name: string, hint: string): string {
	const value = process.env[name];
	if (value === undefined || value === '') {
		throw new Error(
			`Missing required environment variable ${name}. ${hint}`
		);
	}
	return value;
}

function optionalNumber(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw === '') return fallback;
	const value = Number(raw);
	if (!Number.isFinite(value)) {
		throw new Error(
			`Environment variable ${name} must be a number, got: ${raw}`
		);
	}
	return value;
}

const KEY_HINT = 'Generate one with: openssl rand -base64 32';

export const env = {
	NODE_ENV: process.env.NODE_ENV ?? 'development',
	PORT: optionalNumber('PORT', 3001),
	HOST: process.env.HOST ?? '127.0.0.1',
	/** Public origin of the app (used by better-auth and links in notifications). */
	APP_URL: process.env.APP_URL ?? 'http://localhost:3000',
	DATABASE_PATH: process.env.DATABASE_PATH ?? './data/app.db',
	/** base64-encoded 32-byte key sealing GitHub PATs + notification secrets at rest. */
	APP_ENCRYPTION_KEY: required('APP_ENCRYPTION_KEY', KEY_HINT),
	APP_ENCRYPTION_KEY_PREVIOUS: process.env.APP_ENCRYPTION_KEY_PREVIOUS,
	BETTER_AUTH_SECRET: required('BETTER_AUTH_SECRET', KEY_HINT),
	/** Fallback GitHub token when neither project nor global settings provide one. */
	GITHUB_TOKEN: process.env.GITHUB_TOKEN,
	GITHUB_API_URL: process.env.GITHUB_API_URL ?? 'https://api.github.com',
	NPM_REGISTRY_URL:
		process.env.NPM_REGISTRY_URL ?? 'https://registry.npmjs.org',
	OSV_API_URL: process.env.OSV_API_URL ?? 'https://api.osv.dev',
	DISABLE_OSV: process.env.DISABLE_OSV === 'true',
	SCAN_CONCURRENCY: optionalNumber('SCAN_CONCURRENCY', 3),
	ENABLE_LOCKFILE_REGEN: process.env.ENABLE_LOCKFILE_REGEN !== 'false',
	TRUST_PROXY: process.env.TRUST_PROXY === 'true',
	TRUSTED_ORIGINS: (process.env.TRUSTED_ORIGINS ?? 'http://localhost:3000')
		.split(',')
		.map((origin) => origin.trim())
		.filter((origin) => origin.length > 0),
	LOG_LEVEL: process.env.LOG_LEVEL ?? 'info',
	METRICS_ENABLED: process.env.METRICS_ENABLED === 'true',
	METRICS_TOKEN: process.env.METRICS_TOKEN,
	/** Static SPA directory served for non-/api paths in production ('' disables). */
	WEB_DIST_DIR: process.env.WEB_DIST_DIR ?? '',
};
