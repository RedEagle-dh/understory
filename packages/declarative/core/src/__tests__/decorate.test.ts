import { describe, expect, test } from 'bun:test';
import { cacheRead, cacheWrite, withCache } from '../decorate';
import type { CachePort } from '../ports';
import { createTestDeps } from '../testing';

interface Thing {
	readonly id: string;
	readonly value: number;
}

class FakeRepo {
	reads = 0;
	writes = 0;
	nextValue = 1;

	async getThing(tenantId: string, id: string): Promise<Thing | null> {
		this.reads += 1;
		if (id === 'missing') return null;
		return { id: `${tenantId}:${id}`, value: this.nextValue };
	}

	async bump(tenantId: string): Promise<number> {
		this.writes += 1;
		this.nextValue += 1;
		return this.nextValue;
	}

	async unspecced(): Promise<string> {
		return 'passthrough';
	}
}

function inMemoryCache(): CachePort & {
	readonly namespaces: Map<string, Map<string, unknown>>;
} {
	const namespaces = new Map<string, Map<string, unknown>>();
	const bucket = (namespace: string): Map<string, unknown> => {
		let existing = namespaces.get(namespace);
		if (existing === undefined) {
			existing = new Map();
			namespaces.set(namespace, existing);
		}
		return existing;
	};
	return {
		namespaces,
		async get(namespace, key) {
			return bucket(namespace).get(key);
		},
		async set(namespace, key, value) {
			bucket(namespace).set(key, value);
		},
		async delete(namespace, key) {
			bucket(namespace).delete(key);
		},
		async invalidateNamespace(namespace) {
			namespaces.delete(namespace);
		},
	};
}

function throwingCache(): CachePort {
	const boom = async (): Promise<never> => {
		throw new Error('redis down');
	};
	return {
		get: boom,
		set: boom,
		delete: boom,
		invalidateNamespace: boom,
	};
}

function decodeThing(raw: unknown): Thing | null | undefined {
	if (raw === null) return null;
	if (typeof raw !== 'object') return undefined;
	const record: Record<PropertyKey, unknown> = { ...raw };
	if (typeof record.id !== 'string' || typeof record.value !== 'number') {
		return undefined;
	}
	return { id: record.id, value: record.value };
}

function setup(options?: {
	cache?: CachePort;
	cacheIf?: (result: Thing | null) => boolean;
}) {
	const testDeps = createTestDeps();
	const repo = new FakeRepo();
	const cache = options?.cache ?? inMemoryCache();
	const decorated = withCache({
		target: repo,
		cache,
		name: 'things',
		metrics: testDeps.deps.metrics,
		log: testDeps.deps.log,
		spec: {
			getThing: cacheRead({
				entry: (tenantId: string, id: string) => ({
					namespace: `things:${tenantId}`,
					key: id,
					ttlSeconds: 30,
				}),
				decode: decodeThing,
				...(options?.cacheIf === undefined
					? {}
					: { cacheIf: options.cacheIf }),
			}),
			bump: cacheWrite({
				invalidates: (tenantId: string) => [`things:${tenantId}`],
			}),
		},
	});
	return { repo, cache, decorated, ...testDeps };
}

describe('withCache', () => {
	test('miss populates the cache, repeat read is a hit that skips the target', async () => {
		const { decorated, repo, counters } = setup();

		const first = await decorated.getThing('org-1', 'a');
		const second = await decorated.getThing('org-1', 'a');

		expect(first).toEqual({ id: 'org-1:a', value: 1 });
		expect(second).toEqual(first);
		expect(repo.reads).toBe(1);
		const outcomes = counters
			.filter((metric) => metric.name === 'port_cache_events_total')
			.map((metric) => metric.labels?.outcome);
		expect(outcomes).toEqual(['miss', 'hit']);
	});

	test('cache entries are namespaced per tenant', async () => {
		const { decorated, repo } = setup();

		await decorated.getThing('org-1', 'a');
		await decorated.getThing('org-2', 'a');

		expect(repo.reads).toBe(2);
	});

	test('write invalidates its namespaces — the next read refetches', async () => {
		const { decorated, repo } = setup();

		await decorated.getThing('org-1', 'a');
		await decorated.bump('org-1');
		const fresh = await decorated.getThing('org-1', 'a');

		expect(repo.writes).toBe(1);
		expect(repo.reads).toBe(2);
		expect(fresh).toEqual({ id: 'org-1:a', value: 2 });
	});

	test('write leaves other namespaces intact', async () => {
		const { decorated, repo } = setup();

		await decorated.getThing('org-1', 'a');
		await decorated.getThing('org-2', 'a');
		await decorated.bump('org-1');
		await decorated.getThing('org-2', 'a');

		expect(repo.reads).toBe(2);
	});

	test('a value decode rejects is treated as a miss (stale_decode)', async () => {
		const cache = inMemoryCache();
		const { decorated, repo, counters } = setup({ cache });

		await decorated.getThing('org-1', 'a');
		cache.namespaces.get('things:org-1')?.set('a', { corrupt: true });
		const result = await decorated.getThing('org-1', 'a');

		expect(result).toEqual({ id: 'org-1:a', value: 1 });
		expect(repo.reads).toBe(2);
		const outcomes = counters
			.filter((metric) => metric.name === 'port_cache_events_total')
			.map((metric) => metric.labels?.outcome);
		expect(outcomes).toContain('stale_decode');
	});

	test('cacheIf=false results are never stored', async () => {
		const { decorated, repo } = setup({ cacheIf: () => false });

		await decorated.getThing('org-1', 'a');
		await decorated.getThing('org-1', 'a');

		expect(repo.reads).toBe(2);
	});

	test('null results round-trip through the cache', async () => {
		const { decorated, repo } = setup();

		const first = await decorated.getThing('org-1', 'missing');
		const second = await decorated.getThing('org-1', 'missing');

		expect(first).toBeNull();
		expect(second).toBeNull();
		expect(repo.reads).toBe(1);
	});

	test('fails open on a broken cache backend: reads and writes still work', async () => {
		const { decorated, repo, counters, logs } = setup({
			cache: throwingCache(),
		});

		const first = await decorated.getThing('org-1', 'a');
		const second = await decorated.getThing('org-1', 'a');
		await decorated.bump('org-1');

		expect(first).toEqual({ id: 'org-1:a', value: 1 });
		expect(second).toEqual(first);
		expect(repo.reads).toBe(2);
		expect(repo.writes).toBe(1);
		const errorOps = counters
			.filter((metric) => metric.name === 'port_cache_errors_total')
			.map((metric) => metric.labels?.op);
		expect(errorOps).toEqual(['get', 'set', 'get', 'set', 'invalidate']);
		expect(logs.some((log) => log.level === 'warn')).toBe(true);
	});

	test('non-spec’d members pass through untouched', async () => {
		const { decorated, counters } = setup();

		expect(await decorated.unspecced()).toBe('passthrough');
		expect(decorated.reads).toBe(0);
		expect(counters).toHaveLength(0);
	});

	test('write metric counts invalidations', async () => {
		const { decorated, counters } = setup();

		await decorated.bump('org-1');

		const invalidations = counters.filter(
			(metric) => metric.name === 'port_cache_invalidations_total'
		);
		expect(invalidations).toHaveLength(1);
		expect(invalidations[0]?.labels).toEqual({
			port: 'things',
			method: 'bump',
		});
	});
});
