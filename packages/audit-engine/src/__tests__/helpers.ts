import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FileEntry } from '../types';

const FIXTURE_ROOT = join(import.meta.dir, 'fixtures');

export function fixture(...parts: string[]): string {
	return readFileSync(join(FIXTURE_ROOT, ...parts), 'utf8');
}

export function fixtureJson<T = unknown>(...parts: string[]): T {
	return JSON.parse(fixture(...parts)) as T;
}

export function file(path: string, content: string): FileEntry {
	return { path, content };
}

/** A `Response` a fake `fetch` can hand back. */
export function jsonResponse(
	body: unknown,
	init: { status?: number; headers?: Record<string, string> } = {}
): Response {
	return new Response(JSON.stringify(body), {
		status: init.status ?? 200,
		headers: { 'content-type': 'application/json', ...init.headers },
	});
}

export interface RecordedCall {
	url: string;
	method: string;
	headers: Record<string, string>;
	body?: string;
}

export interface FakeFetch {
	fetch: typeof fetch;
	calls: RecordedCall[];
}

/** Deterministic `fetch` double: each call consumes the next handler result. */
export function fakeFetch(
	handler: (call: RecordedCall, index: number) => Response | Promise<Response>
): FakeFetch {
	const calls: RecordedCall[] = [];
	const impl = (async (
		input: Parameters<typeof fetch>[0],
		init?: RequestInit
	) => {
		const headers: Record<string, string> = {};
		const rawHeaders = init?.headers;
		if (rawHeaders !== undefined) {
			for (const [key, value] of Object.entries(
				rawHeaders as Record<string, string>
			)) {
				headers[key.toLowerCase()] = value;
			}
		}
		const call: RecordedCall = {
			url: String(input),
			method: init?.method ?? 'GET',
			headers,
			body: typeof init?.body === 'string' ? init.body : undefined,
		};
		calls.push(call);
		return handler(call, calls.length - 1);
	}) as unknown as typeof fetch;
	return { fetch: impl, calls };
}
