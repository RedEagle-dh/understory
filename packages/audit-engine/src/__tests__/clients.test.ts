import { describe, expect, test } from 'bun:test';
import { createOsvClient, OsvError } from '../osv/client';
import { createMemoryCache } from '../registry/cache';
import {
	BULK_ADVISORY_CHUNK_SIZE,
	chunkAdvisoryMap,
	createNpmClient,
	encodePackageName,
	RegistryError,
} from '../registry/npm-client';
import type { NpmBulkAdvisoryResponse, OsvVuln } from '../types';
import { fakeFetch, fixtureJson, jsonResponse } from './helpers';

const LODASH_BULK = fixtureJson<NpmBulkAdvisoryResponse>(
	'npm-bulk',
	'lodash.json'
);
const OSV_BATCH = fixtureJson('osv', 'querybatch-response.json');
const OSV_VULN = fixtureJson<OsvVuln>('osv', 'GHSA-35jh-r3h4-6jhm.json');

const PACKUMENT = {
	name: 'lodash',
	'dist-tags': { latest: '4.17.21' },
	versions: {
		'4.17.20': { version: '4.17.20' },
		'4.17.21': { version: '4.17.21' },
	},
};

/* -------------------------------------------------------------------------- */

describe('npm client — packument caching', () => {
	test('sends If-None-Match and returns the cached body on 304', async () => {
		const cache = createMemoryCache();
		cache.set('npm:packument:lodash', {
			etag: 'W/"abc123"',
			body: PACKUMENT,
			fetchedAt: '2024-01-01T00:00:00.000Z',
			expiresAt: '2024-01-01T06:00:00.000Z',
		});

		const { fetch, calls } = fakeFetch(
			() => new Response(null, { status: 304 })
		);
		const client = createNpmClient({
			fetch,
			cache,
			now: () => Date.parse('2025-01-01'),
		});

		const packument = await client.getPackument('lodash');

		expect(packument).toEqual(PACKUMENT);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe('https://registry.npmjs.org/lodash');
		expect(calls[0]?.headers['if-none-match']).toBe('W/"abc123"');
		expect(calls[0]?.headers.accept).toBe(
			'application/vnd.npm.install-v1+json'
		);
		// The 304 refreshes the freshness window without dropping the ETag.
		const stored = cache.get('npm:packument:lodash');
		expect(stored?.etag).toBe('W/"abc123"');
		expect(stored?.fetchedAt).toBe('2025-01-01T00:00:00.000Z');
	});

	test('stores body and ETag on 200', async () => {
		const cache = createMemoryCache();
		const { fetch, calls } = fakeFetch(() =>
			jsonResponse(PACKUMENT, { headers: { etag: '"v1"' } })
		);
		const client = createNpmClient({
			fetch,
			cache,
			now: () => Date.parse('2025-01-01'),
		});

		await client.getPackument('lodash');

		expect(calls[0]?.headers['if-none-match']).toBeUndefined();
		expect(cache.get('npm:packument:lodash')).toMatchObject({
			etag: '"v1"',
			body: PACKUMENT,
			expiresAt: '2025-01-01T06:00:00.000Z',
		});
	});

	test('serves a fresh, ETag-less cache entry without any request', async () => {
		const cache = createMemoryCache();
		cache.set('npm:dist-tags:lodash', {
			body: { latest: '4.17.21' },
			fetchedAt: '2025-01-01T00:00:00.000Z',
			expiresAt: '2025-01-01T06:00:00.000Z',
		});
		const { fetch, calls } = fakeFetch(() =>
			jsonResponse({ latest: 'should-not-be-used' })
		);
		const client = createNpmClient({
			fetch,
			cache,
			now: () => Date.parse('2025-01-01T01:00:00Z'),
		});

		expect(await client.getDistTags('lodash')).toEqual({
			latest: '4.17.21',
		});
		expect(calls).toHaveLength(0);
	});

	test('refetches once the TTL expired', async () => {
		const cache = createMemoryCache();
		cache.set('npm:dist-tags:lodash', {
			body: { latest: 'stale' },
			fetchedAt: '2025-01-01T00:00:00.000Z',
			expiresAt: '2025-01-01T06:00:00.000Z',
		});
		const { fetch, calls } = fakeFetch(() =>
			jsonResponse({ latest: '4.17.21' })
		);
		const client = createNpmClient({
			fetch,
			cache,
			now: () => Date.parse('2025-01-02T00:00:00Z'),
		});

		expect(await client.getDistTags('lodash')).toEqual({
			latest: '4.17.21',
		});
		expect(calls).toHaveLength(1);
	});

	test('works without a cache at all', async () => {
		const { fetch, calls } = fakeFetch(() =>
			jsonResponse({ latest: '1.0.0' })
		);
		const client = createNpmClient({ fetch });
		expect(await client.getDistTags('left-pad')).toEqual({
			latest: '1.0.0',
		});
		expect(calls).toHaveLength(1);
	});
});

describe('npm client — publish times', () => {
	const FULL_PACKUMENT = {
		name: 'lodash',
		'dist-tags': { latest: '4.17.21' },
		versions: { '4.17.21': { version: '4.17.21' } },
		time: {
			created: '2012-04-23T16:37:11.912Z',
			modified: '2024-01-01T00:00:00.000Z',
			'4.17.20': '2020-08-13T16:53:54.152Z',
			'4.17.21': '2021-02-20T15:42:16.891Z',
		},
	};

	test('extracts and caches ONLY the time map, stripping created/modified', async () => {
		const cache = createMemoryCache();
		const { fetch, calls } = fakeFetch(() =>
			jsonResponse(FULL_PACKUMENT, { headers: { etag: 'W/"t1"' } })
		);
		const client = createNpmClient({ fetch, cache });

		const times = await client.getPublishTimes('lodash');
		expect(times).toEqual({
			'4.17.20': '2020-08-13T16:53:54.152Z',
			'4.17.21': '2021-02-20T15:42:16.891Z',
		});
		expect(calls).toHaveLength(1);
		// Full packument requested (no abbreviated accept header).
		expect(calls[0]?.headers.accept).toBe('application/json');

		const entry = await cache.get(client.publishTimesCacheKey('lodash'));
		expect(entry?.etag).toBe('W/"t1"');
		// The cached body is the small extracted map, not the packument.
		expect(entry?.body).toEqual(times);
	});

	test('returns the cached map on 304 without re-downloading', async () => {
		const cache = createMemoryCache();
		cache.set('npm:times:lodash', {
			etag: 'W/"t1"',
			body: { '4.17.21': '2021-02-20T15:42:16.891Z' },
			fetchedAt: '2025-01-01T00:00:00.000Z',
			expiresAt: '2025-01-01T06:00:00.000Z',
		});
		const { fetch, calls } = fakeFetch(
			() => new Response(null, { status: 304 })
		);
		const client = createNpmClient({ fetch, cache });

		expect(await client.getPublishTimes('lodash')).toEqual({
			'4.17.21': '2021-02-20T15:42:16.891Z',
		});
		expect(calls[0]?.headers['if-none-match']).toBe('W/"t1"');
	});

	test('surfaces registry failures as RegistryError', async () => {
		const { fetch } = fakeFetch(
			() => new Response('nope', { status: 404 })
		);
		const client = createNpmClient({ fetch });
		expect(client.getPublishTimes('does-not-exist')).rejects.toThrow(
			RegistryError
		);
	});
});

describe('npm client — urls and errors', () => {
	test('encodes scoped names for both endpoints', () => {
		expect(encodePackageName('@scope/pkg')).toBe('@scope%2fpkg');
		expect(encodePackageName('lodash')).toBe('lodash');
	});

	test('uses the dist-tags endpoint path', async () => {
		const { fetch, calls } = fakeFetch(() =>
			jsonResponse({ latest: '1.7.0' })
		);
		const client = createNpmClient({
			fetch,
			registryUrl: 'https://npm.internal/',
		});
		await client.getDistTags('@base-ui/react');
		expect(calls[0]?.url).toBe(
			'https://npm.internal/-/package/@base-ui%2freact/dist-tags'
		);
	});

	test('fetches a single version manifest', async () => {
		const { fetch, calls } = fakeFetch(() =>
			jsonResponse({ version: '4.17.21' })
		);
		const client = createNpmClient({ fetch });
		await client.getVersionManifest('lodash', '4.17.21');
		expect(calls[0]?.url).toBe('https://registry.npmjs.org/lodash/4.17.21');
	});

	test('throws a typed RegistryError on non-2xx', async () => {
		const { fetch } = fakeFetch(
			() => new Response('nope', { status: 503 })
		);
		const client = createNpmClient({ fetch });
		const error = await client
			.getPackument('lodash')
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(RegistryError);
		expect((error as RegistryError).status).toBe(503);
		expect((error as RegistryError).body).toBe('nope');
	});

	test('sends a bearer token when configured', async () => {
		const { fetch, calls } = fakeFetch(() =>
			jsonResponse({ latest: '1.0.0' })
		);
		await createNpmClient({ fetch, authToken: 'secret' }).getDistTags('x');
		expect(calls[0]?.headers.authorization).toBe('Bearer secret');
	});
});

describe('npm client — bulk advisories', () => {
	test('chunks the map at 400 names per request and merges the responses', async () => {
		const map: Record<string, string[]> = {};
		for (let index = 0; index < 401; index++)
			map[`pkg-${index}`] = ['1.0.0'];

		const { fetch, calls } = fakeFetch((call) => {
			const body = JSON.parse(call.body ?? '{}') as Record<
				string,
				string[]
			>;
			const names = Object.keys(body);
			return jsonResponse({
				[names[0] as string]: [{ id: names.length }],
			});
		});

		const client = createNpmClient({ fetch });
		const result = await client.bulkAdvisories(map);

		expect(calls).toHaveLength(2);
		expect(calls[0]?.method).toBe('POST');
		expect(calls[0]?.url).toBe(
			'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk'
		);
		expect(Object.keys(JSON.parse(calls[0]?.body ?? '{}'))).toHaveLength(
			BULK_ADVISORY_CHUNK_SIZE
		);
		expect(Object.keys(JSON.parse(calls[1]?.body ?? '{}'))).toHaveLength(1);
		expect(result['pkg-0']?.[0]?.id).toBe(400);
		expect(result['pkg-400']?.[0]?.id).toBe(1);
	});

	test('returns the parsed advisories of a single chunk', async () => {
		const { fetch, calls } = fakeFetch(() => jsonResponse(LODASH_BULK));
		const client = createNpmClient({ fetch });
		const result = await client.bulkAdvisories({
			lodash: ['4.17.15', '4.17.15'],
		});
		expect(calls).toHaveLength(1);
		// Duplicate versions are collapsed before the request goes out.
		expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({
			lodash: ['4.17.15'],
		});
		expect(result.lodash).toHaveLength(2);
	});

	test('skips packages with no versions and makes no call for an empty map', async () => {
		expect(chunkAdvisoryMap({ a: [], b: ['1.0.0'] })).toEqual([
			{ b: ['1.0.0'] },
		]);
		const { fetch, calls } = fakeFetch(() => jsonResponse({}));
		expect(await createNpmClient({ fetch }).bulkAdvisories({})).toEqual({});
		expect(calls).toHaveLength(0);
	});

	test('throws RegistryError when the bulk endpoint fails', async () => {
		const { fetch } = fakeFetch(() => new Response('bad', { status: 400 }));
		const client = createNpmClient({ fetch });
		await expect(
			client.bulkAdvisories({ lodash: ['1.0.0'] })
		).rejects.toBeInstanceOf(RegistryError);
	});
});

/* -------------------------------------------------------------------------- */

describe('OSV client', () => {
	test('preserves input order and turns {} holes into empty results', async () => {
		const { fetch, calls } = fakeFetch(() => jsonResponse(OSV_BATCH));
		const client = createOsvClient({ fetch });

		const results = await client.queryBatch([
			{ name: 'lodash', version: '4.17.15' },
			{ name: 'left-pad', version: '1.3.0' },
			{ name: 'minimist', version: '1.2.0' },
		]);

		expect(calls[0]?.url).toBe('https://api.osv.dev/v1/querybatch');
		expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({
			queries: [
				{
					package: { name: 'lodash', ecosystem: 'npm' },
					version: '4.17.15',
				},
				{
					package: { name: 'left-pad', ecosystem: 'npm' },
					version: '1.3.0',
				},
				{
					package: { name: 'minimist', ecosystem: 'npm' },
					version: '1.2.0',
				},
			],
		});

		expect(results).toHaveLength(3);
		expect(results[0]?.vulns.map((v) => v.id)).toEqual([
			'GHSA-35jh-r3h4-6jhm',
		]);
		expect(results[1]?.vulns).toEqual([]);
		expect(results[2]?.vulns).toHaveLength(2);
		expect(results[2]?.vulns[1]?.modified).toBe('2023-11-08T04:00:00Z');
	});

	test('chunks large batches while keeping the overall order', async () => {
		const pairs = Array.from({ length: 5 }, (_, index) => ({
			name: `pkg-${index}`,
			version: '1.0.0',
		}));

		const { fetch, calls } = fakeFetch((call) => {
			const body = JSON.parse(call.body ?? '{}') as {
				queries: { package: { name: string } }[];
			};
			return jsonResponse({
				results: body.queries.map((query) => ({
					vulns: [{ id: `V-${query.package.name}` }],
				})),
			});
		});

		const results = await createOsvClient({
			fetch,
			chunkSize: 2,
		}).queryBatch(pairs);

		expect(calls).toHaveLength(3);
		expect(results.map((r) => r.vulns[0]?.id)).toEqual([
			'V-pkg-0',
			'V-pkg-1',
			'V-pkg-2',
			'V-pkg-3',
			'V-pkg-4',
		]);
	});

	test('pads missing trailing results instead of misaligning', async () => {
		const { fetch } = fakeFetch(() =>
			jsonResponse({ results: [{ vulns: [{ id: 'A' }] }] })
		);
		const results = await createOsvClient({ fetch }).queryBatch([
			{ name: 'a', version: '1.0.0' },
			{ name: 'b', version: '1.0.0' },
		]);
		expect(results).toHaveLength(2);
		expect(results[1]?.vulns).toEqual([]);
	});

	test('surfaces the pagination token', async () => {
		const { fetch } = fakeFetch(() =>
			jsonResponse({
				results: [{ vulns: [{ id: 'A' }], next_page_token: 'token' }],
			})
		);
		const results = await createOsvClient({ fetch }).queryBatch([
			{ name: 'a', version: '1.0.0' },
		]);
		expect(results[0]?.nextPageToken).toBe('token');
	});

	test('makes no request for an empty batch', async () => {
		const { fetch, calls } = fakeFetch(() => jsonResponse({}));
		expect(await createOsvClient({ fetch }).queryBatch([])).toEqual([]);
		expect(calls).toHaveLength(0);
	});

	test('fetches vulnerability details', async () => {
		const { fetch, calls } = fakeFetch(() => jsonResponse(OSV_VULN));
		const vuln = await createOsvClient({ fetch }).getVuln(
			'GHSA-35jh-r3h4-6jhm'
		);
		expect(calls[0]?.url).toBe(
			'https://api.osv.dev/v1/vulns/GHSA-35jh-r3h4-6jhm'
		);
		expect(vuln.id).toBe('GHSA-35jh-r3h4-6jhm');
	});

	test('throws a typed OsvError on non-2xx', async () => {
		const { fetch } = fakeFetch(
			() => new Response('missing', { status: 404 })
		);
		const error = await createOsvClient({ fetch })
			.getVuln('GHSA-nope')
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(OsvError);
		expect((error as OsvError).status).toBe(404);
	});
});

/* -------------------------------------------------------------------------- */

describe('createMemoryCache', () => {
	test('stores, reads, deletes and clears', () => {
		const cache = createMemoryCache();
		expect(cache.get('missing')).toBeNull();
		cache.set('a', { body: 1, fetchedAt: 'now' });
		expect(cache.get('a')?.body).toBe(1);
		expect(cache.size).toBe(1);
		expect(cache.keys()).toEqual(['a']);
		cache.delete('a');
		expect(cache.size).toBe(0);
		cache.set('b', { body: 2, fetchedAt: 'now' });
		cache.clear();
		expect(cache.size).toBe(0);
	});
});
