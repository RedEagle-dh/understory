import { describe, expect, test } from 'bun:test';
import type { LoggerPort } from '@declarativejs/core';
import { createUpdateCheckService } from '../services/update-check-service';

const API_URL = 'https://api.github.example';
const REPO = 'acme/widget';

const silentLog: LoggerPort = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
	child: () => silentLog,
};

function makeFetch(
	handler: (url: string) => Response | Promise<Response>
): typeof fetch {
	return (async (input: string | URL | Request) =>
		handler(String(input))) as typeof fetch;
}

function releaseResponse(tagName: string): Response {
	return Response.json({
		tag_name: tagName,
		html_url: `https://github.com/${REPO}/releases/tag/${tagName}`,
	});
}

function makeService(overrides: {
	currentVersion?: string;
	enabled?: boolean;
	fetchImpl?: typeof fetch;
}) {
	return createUpdateCheckService({
		fetchImpl:
			overrides.fetchImpl ?? makeFetch(() => releaseResponse('v9.9.9')),
		currentVersion: overrides.currentVersion ?? '0.0.1',
		repo: REPO,
		apiUrl: API_URL,
		enabled: overrides.enabled ?? true,
		log: silentLog,
	});
}

describe('update-check service', () => {
	test('reports an update when the latest release is newer', async () => {
		const service = makeService({
			currentVersion: '0.0.1',
			fetchImpl: makeFetch((url) => {
				expect(url).toBe(`${API_URL}/repos/${REPO}/releases/latest`);
				return releaseResponse('v0.2.0');
			}),
		});

		const status = await service.check();
		expect(status.updateAvailable).toBe(true);
		expect(status.latestVersion).toBe('0.2.0');
		expect(status.releaseUrl).toBe(
			`https://github.com/${REPO}/releases/tag/v0.2.0`
		);
		expect(status.checkedAt).not.toBeNull();
	});

	test('same version is not an update', async () => {
		const service = makeService({
			currentVersion: '0.2.0',
			fetchImpl: makeFetch(() => releaseResponse('v0.2.0')),
		});
		const status = await service.check();
		expect(status.updateAvailable).toBe(false);
		expect(status.latestVersion).toBe('0.2.0');
	});

	test('a v-prefixed current version compares correctly', async () => {
		const service = makeService({
			currentVersion: 'v0.3.0',
			fetchImpl: makeFetch(() => releaseResponse('v0.2.0')),
		});
		const status = await service.check();
		expect(status.updateAvailable).toBe(false);
	});

	test('non-semver build version disables checking entirely', async () => {
		let called = 0;
		const service = makeService({
			currentVersion: 'dev',
			fetchImpl: makeFetch(() => {
				called += 1;
				return releaseResponse('v9.9.9');
			}),
		});

		const status = await service.check();
		expect(called).toBe(0);
		expect(status.updateAvailable).toBe(false);
		expect(status.checkedAt).toBeNull();
	});

	test('UPDATE_CHECK=false disables checking', async () => {
		let called = 0;
		const service = makeService({
			enabled: false,
			fetchImpl: makeFetch(() => {
				called += 1;
				return releaseResponse('v9.9.9');
			}),
		});
		await service.check();
		expect(called).toBe(0);
	});

	test('repo without releases (404) reports no update', async () => {
		const service = makeService({
			fetchImpl: makeFetch(
				() => new Response('not found', { status: 404 })
			),
		});
		const status = await service.check();
		expect(status.updateAvailable).toBe(false);
		expect(status.latestVersion).toBeNull();
		expect(status.checkedAt).not.toBeNull();
	});

	test('network failure keeps the previous answer and never throws', async () => {
		let fail = false;
		const service = makeService({
			currentVersion: '0.0.1',
			fetchImpl: makeFetch(() => {
				if (fail) throw new Error('offline');
				return releaseResponse('v0.2.0');
			}),
		});

		const first = await service.check();
		expect(first.updateAvailable).toBe(true);

		fail = true;
		const second = await service.check();
		expect(second.updateAvailable).toBe(true);
		expect(second.latestVersion).toBe('0.2.0');
	});

	test('a malformed release tag reports no update', async () => {
		const service = makeService({
			fetchImpl: makeFetch(() =>
				Response.json({ tag_name: 'nightly', html_url: 'x' })
			),
		});
		const status = await service.check();
		expect(status.updateAvailable).toBe(false);
		expect(status.latestVersion).toBeNull();
	});

	test('status() lazily triggers the first check', async () => {
		const service = makeService({
			currentVersion: '0.0.1',
			fetchImpl: makeFetch(() => releaseResponse('v0.2.0')),
		});

		const before = service.status();
		expect(before.checkedAt).toBeNull();

		// The lazy check is fire-and-forget; one macrotask is enough for the
		// immediate fake fetch to settle.
		await new Promise((resolve) => setTimeout(resolve, 0));

		const after = service.status();
		expect(after.updateAvailable).toBe(true);
		expect(after.checkedAt).not.toBeNull();
	});

	test('concurrent checks share one request', async () => {
		let called = 0;
		const service = makeService({
			fetchImpl: makeFetch(async () => {
				called += 1;
				await new Promise((resolve) => setTimeout(resolve, 5));
				return releaseResponse('v0.2.0');
			}),
		});

		await Promise.all([service.check(), service.check()]);
		expect(called).toBe(1);
	});
});
