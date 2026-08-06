import { describe, expect, test } from 'bun:test';

/**
 * Boots the REAL manifest (every module, against an in-memory DB) and asserts
 * every declared route carries non-empty `docs.summary` + `docs.tag`. This is
 * the only test in the suite that imports `../environment` / `../generated/
 * manifest`, so the required env vars are set here, before the dynamic
 * import — `env.ts` reads `process.env` at module-evaluation time, and a
 * static top-level import would run before a test body ever gets a chance to
 * set them.
 */

process.env.APP_ENCRYPTION_KEY ??= Buffer.from(
	crypto.getRandomValues(new Uint8Array(32))
).toString('base64');
process.env.BETTER_AUTH_SECRET ??= Buffer.from(
	crypto.getRandomValues(new Uint8Array(32))
).toString('base64');
process.env.DATABASE_PATH ??= ':memory:';
process.env.APP_URL ??= 'http://localhost:3001';
process.env.TRUSTED_ORIGINS ??= 'http://localhost:3001';

const { manifest } = await import('../generated/manifest');

describe('manifest routes', () => {
	test('every declared route has a non-empty docs.summary and docs.tag', () => {
		const env = manifest.createEnvironment({});
		const contributions = manifest.modules.map((mod) => mod.build(env));
		const routes = contributions.flatMap((c) => c.routes ?? []);

		expect(routes.length).toBeGreaterThan(0);

		const undocumented = routes.filter(
			(route) =>
				route.docs === undefined ||
				route.docs.summary.trim() === '' ||
				route.docs.tag.trim() === ''
		);
		expect(
			undocumented.map((route) => `${route.method} ${route.path}`)
		).toEqual([]);
	});

	test('every route id and path is unique across modules', () => {
		const env = manifest.createEnvironment({});
		const contributions = manifest.modules.map((mod) => mod.build(env));
		const routes = contributions.flatMap((c) => c.routes ?? []);

		const ids = routes.map((route) => route.id);
		expect(new Set(ids).size).toBe(ids.length);

		const methodPaths = routes.map(
			(route) => `${route.method} ${route.path}`
		);
		expect(new Set(methodPaths).size).toBe(methodPaths.length);
	});

	test('every declared job has an id and a schedule', () => {
		const env = manifest.createEnvironment({});
		const contributions = manifest.modules.map((mod) => mod.build(env));
		const jobs = contributions.flatMap((c) => c.jobs ?? []);

		expect(jobs.length).toBeGreaterThan(0);
		for (const job of jobs) {
			expect(job.id.length).toBeGreaterThan(0);
			expect(job.schedule).toBeDefined();
		}
	});
});
