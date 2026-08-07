import { describe, expect, test } from 'bun:test';
import { createMemoryCache } from '../registry/cache';
import { RegistryError } from '../registry/npm-client';
import {
	createPypiClient,
	DEFAULT_PYPI_URL,
	type PypiProject,
} from '../registry/pypi-client';
import { fakeFetch, jsonResponse } from './helpers';

/** Raw `/pypi/<name>/json` body exercising every normalization rule. */
const DJANGO_RAW = {
	info: { name: 'Django', version: '5.0.1' },
	releases: {
		// Fully yanked: every file yanked, reason from the first non-empty one.
		'4.0.0': [
			{
				upload_time_iso_8601: '2021-12-07T09:19:16.000Z',
				yanked: true,
				yanked_reason: '',
			},
			{
				upload_time_iso_8601: '2021-12-07T09:20:02.000Z',
				yanked: true,
				yanked_reason: 'broken wheel',
			},
		],
		// Partially yanked: pip still installs it, so not yanked.
		'4.1.0': [
			{
				upload_time_iso_8601: '2022-08-03T08:00:00.000Z',
				yanked: true,
				yanked_reason: 'bad sdist',
			},
			{
				upload_time_iso_8601: '2022-08-03T07:59:00.000Z',
				yanked: false,
				yanked_reason: null,
			},
		],
		// No files at all: neither yanked nor dated.
		'0.9.0': [],
		// Earliest upload wins; unparseable timestamps are ignored.
		'5.0.1': [
			{ upload_time_iso_8601: 'not-a-date', yanked: false },
			{
				upload_time_iso_8601: '2024-01-02T10:00:00.000Z',
				yanked: false,
			},
			{
				upload_time_iso_8601: '2024-01-02T09:30:00.000Z',
				yanked: false,
			},
		],
		// An empty version key is registry garbage; drop it.
		'': [{ upload_time_iso_8601: '2020-01-01T00:00:00.000Z' }],
	},
};

function releaseOf(project: PypiProject, version: string) {
	return project.releases.find((release) => release.version === version);
}

/* -------------------------------------------------------------------------- */

describe('pypi client — urls and normalization', () => {
	test('normalizes the name for the URL and cache key', async () => {
		const { fetch, calls } = fakeFetch(() => jsonResponse(DJANGO_RAW));
		const client = createPypiClient({ fetch });

		const project = await client.getProject('Django');

		expect(DEFAULT_PYPI_URL).toBe('https://pypi.org');
		expect(calls[0]?.url).toBe('https://pypi.org/pypi/django/json');
		expect(calls[0]?.headers.accept).toBe('application/json');
		expect(project.name).toBe('django');
		expect(client.projectCacheKey('Django')).toBe('pypi:project:django');
		expect(client.projectCacheKey('typing_extensions.foo')).toBe(
			'pypi:project:typing-extensions-foo'
		);
	});

	test('normalizes releases: yanked, partial yank, empty files, earliest upload', async () => {
		const { fetch } = fakeFetch(() => jsonResponse(DJANGO_RAW));
		const project = await createPypiClient({ fetch }).getProject('django');

		expect(project.latest).toBe('5.0.1');
		// The empty version key is dropped.
		expect(project.releases).toHaveLength(4);

		expect(releaseOf(project, '4.0.0')).toEqual({
			version: '4.0.0',
			yanked: true,
			yankedReason: 'broken wheel',
			uploadedAt: '2021-12-07T09:19:16.000Z',
		});

		// One live file keeps the release installable, but the reason of the
		// yanked file is still surfaced.
		expect(releaseOf(project, '4.1.0')).toMatchObject({
			yanked: false,
			yankedReason: 'bad sdist',
			uploadedAt: '2022-08-03T07:59:00.000Z',
		});

		expect(releaseOf(project, '0.9.0')).toEqual({
			version: '0.9.0',
			yanked: false,
		});

		// Earliest parseable timestamp wins; the garbage one is skipped.
		expect(releaseOf(project, '5.0.1')?.uploadedAt).toBe(
			'2024-01-02T09:30:00.000Z'
		);
	});

	test('respects a custom base URL with a trailing slash', async () => {
		const { fetch, calls } = fakeFetch(() => jsonResponse(DJANGO_RAW));
		await createPypiClient({
			fetch,
			baseUrl: 'https://pypi.internal/',
		}).getProject('django');
		expect(calls[0]?.url).toBe('https://pypi.internal/pypi/django/json');
	});
});

describe('pypi client — caching', () => {
	test('caches ONLY the normalized project, never the raw releases map', async () => {
		const cache = createMemoryCache();
		const { fetch, calls } = fakeFetch(() =>
			jsonResponse(DJANGO_RAW, { headers: { etag: 'W/"p1"' } })
		);
		const client = createPypiClient({
			fetch,
			cache,
			now: () => Date.parse('2025-01-01'),
		});

		const project = await client.getProject('Django');
		expect(calls).toHaveLength(1);

		const entry = cache.get('pypi:project:django');
		expect(entry?.etag).toBe('W/"p1"');
		expect(entry?.expiresAt).toBe('2025-01-01T06:00:00.000Z');
		// The stored body is the small normalized shape: `releases` is an
		// ARRAY of flat release objects, not PyPI's dict of file lists.
		const body = entry?.body as PypiProject;
		expect(body).toEqual(project);
		expect(Array.isArray(body.releases)).toBe(true);
		for (const release of body.releases) {
			expect(Object.keys(release).sort()).toEqual(
				expect.arrayContaining(['version', 'yanked'])
			);
			expect(release).not.toHaveProperty('files');
			expect(release).not.toHaveProperty('upload_time_iso_8601');
		}
		expect(body).not.toHaveProperty('info');
	});

	test('sends If-None-Match and serves the cached body on 304', async () => {
		const cache = createMemoryCache();
		const { fetch, calls } = fakeFetch((_, index) =>
			index === 0
				? jsonResponse(DJANGO_RAW, { headers: { etag: 'W/"p1"' } })
				: new Response(null, { status: 304 })
		);
		const client = createPypiClient({
			fetch,
			cache,
			now: () => Date.parse('2025-01-01'),
		});

		const first = await client.getProject('django');
		const second = await client.getProject('django');

		expect(calls).toHaveLength(2);
		expect(calls[1]?.headers['if-none-match']).toBe('W/"p1"');
		expect(second).toEqual(first);
		// The 304 refreshes the freshness window without dropping the ETag.
		expect(cache.get('pypi:project:django')?.etag).toBe('W/"p1"');
	});

	test('serves a fresh, ETag-less entry without any request, refetches after the TTL', async () => {
		const cache = createMemoryCache();
		cache.set('pypi:project:django', {
			body: { name: 'django', latest: '5.0.0', releases: [] },
			fetchedAt: '2025-01-01T00:00:00.000Z',
			expiresAt: '2025-01-01T06:00:00.000Z',
		});
		const { fetch, calls } = fakeFetch(() => jsonResponse(DJANGO_RAW));

		let currentNow = Date.parse('2025-01-01T01:00:00Z');
		const client = createPypiClient({
			fetch,
			cache,
			now: () => currentNow,
		});

		// Fresh: the stale-but-valid entry answers without a request.
		expect((await client.getProject('django')).latest).toBe('5.0.0');
		expect(calls).toHaveLength(0);

		// Past the TTL the entry is no longer trusted.
		currentNow = Date.parse('2025-01-02T00:00:00Z');
		expect((await client.getProject('django')).latest).toBe('5.0.1');
		expect(calls).toHaveLength(1);
	});

	test('works without a cache at all', async () => {
		const { fetch, calls } = fakeFetch(() => jsonResponse(DJANGO_RAW));
		const client = createPypiClient({ fetch });
		expect((await client.getProject('django')).latest).toBe('5.0.1');
		expect(calls).toHaveLength(1);
	});
});

describe('pypi client — publish times and errors', () => {
	test('derives version -> earliest upload time, skipping undated releases', async () => {
		const { fetch, calls } = fakeFetch(() => jsonResponse(DJANGO_RAW));
		const times = await createPypiClient({ fetch }).getPublishTimes(
			'django'
		);
		expect(times).toEqual({
			'4.0.0': '2021-12-07T09:19:16.000Z',
			'4.1.0': '2022-08-03T07:59:00.000Z',
			'5.0.1': '2024-01-02T09:30:00.000Z',
		});
		// Derived from the same endpoint — exactly one fetch.
		expect(calls).toHaveLength(1);
	});

	test('throws a typed RegistryError on 404', async () => {
		const { fetch } = fakeFetch(
			() => new Response('not found', { status: 404 })
		);
		const client = createPypiClient({ fetch });
		const error = await client
			.getProject('does-not-exist')
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(RegistryError);
		expect((error as RegistryError).status).toBe(404);
		expect((error as RegistryError).url).toBe(
			'https://pypi.org/pypi/does-not-exist/json'
		);
		expect((error as RegistryError).body).toBe('not found');
	});
});
