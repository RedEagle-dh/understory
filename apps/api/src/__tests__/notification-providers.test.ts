import { describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import type { NotificationMessage } from '../adapters/notifications/port';
import { providers } from '../adapters/notifications/registry';
import { createSlackWebhookProvider } from '../adapters/notifications/slack-webhook';
import {
	escapeSlack,
	toSlackBlocks,
	toWebhookPayload,
} from '../adapters/notifications/templates/render';
import {
	createWebhookProvider,
	signWebhookBody,
} from '../adapters/notifications/webhook';

const MESSAGE: NotificationMessage = {
	event: 'new_vulnerabilities',
	projectId: 'proj_1',
	projectName: 'web & api',
	title: '2 new vulnerabilities in web',
	url: 'https://understory.test/projects/proj_1/vulnerabilities',
	severity: 'critical',
	summary: '1 critical, 1 high <found>',
	sections: [
		{
			heading: 'Critical',
			lines: [
				{
					text: 'lodash@4.17.20',
					url: 'https://understory.test/a/GHSA-1',
					severity: 'critical',
				},
			],
		},
		{
			heading: 'High',
			lines: [{ text: 'minimist@1.2.0', severity: 'high' }],
		},
	],
	footer: 'understory',
};

interface Recorded {
	url: string;
	headers: Record<string, string>;
	body: string;
}

function recordingFetch(
	response: () => Response
): { fetch: typeof fetch; calls: Recorded[] } {
	const calls: Recorded[] = [];
	const impl = (async (input: string, init?: RequestInit) => {
		calls.push({
			url: String(input),
			headers: Object.fromEntries(
				Object.entries(
					(init?.headers ?? {}) as Record<string, string>
				).map(([key, value]) => [key.toLowerCase(), value])
			),
			body: typeof init?.body === 'string' ? init.body : '',
		});
		return response();
	}) as unknown as typeof fetch;
	return { fetch: impl, calls };
}

/* -------------------------------------------------------------------------- */

describe('registry', () => {
	test('every channel type resolves to a provider', () => {
		expect(Object.keys(providers).sort()).toEqual([
			'discord_webhook',
			'email_resend',
			'slack_webhook',
			'webhook',
		]);
		for (const [type, provider] of Object.entries(providers)) {
			expect(provider.type).toBe(
				type as (typeof provider)['type']
			);
		}
	});
});

/* -------------------------------------------------------------------------- */

describe('Slack block rendering', () => {
	test('escapes only the three characters Slack cares about', () => {
		expect(escapeSlack('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d');
		// Markdown punctuation is NOT escaped — package names must stay readable.
		expect(escapeSlack('@scope/pkg_name-1.0')).toBe('@scope/pkg_name-1.0');
	});

	test('renders a header, a summary, one section per group and a context line', () => {
		const blocks = toSlackBlocks(MESSAGE);
		expect(blocks[0]).toEqual({
			type: 'header',
			text: { type: 'plain_text', text: MESSAGE.title },
		});
		expect(blocks[1]?.type).toBe('section');
		expect(blocks).toHaveLength(5);
		expect(blocks.at(-1)?.type).toBe('context');
	});

	test('uses Slack link syntax, not Markdown', () => {
		const rendered = JSON.stringify(toSlackBlocks(MESSAGE));
		expect(rendered).toContain(
			'<https://understory.test/a/GHSA-1|lodash@4.17.20>'
		);
		expect(rendered).not.toContain('](');
	});

	test('escapes the summary rather than passing raw angle brackets through', () => {
		const blocks = toSlackBlocks(MESSAGE);
		const summary = blocks[1];
		expect(
			summary?.type === 'section' ? summary.text.text : ''
		).toContain('&lt;found&gt;');
	});

	test('collapses overflow instead of dropping sections silently', () => {
		const many: NotificationMessage = {
			...MESSAGE,
			sections: Array.from({ length: 80 }, (_, index) => ({
				heading: `Group ${index}`,
				lines: [{ text: `pkg-${index}` }],
			})),
		};
		const blocks = toSlackBlocks(many);
		expect(blocks.length).toBeLessThanOrEqual(50);
		expect(JSON.stringify(blocks)).toContain('more section(s) omitted');
	});
});

describe('Slack provider', () => {
	test('posts blocks plus a fallback text line', async () => {
		const recorder = recordingFetch(() => new Response('ok'));
		const provider = createSlackWebhookProvider({
			fetchImpl: recorder.fetch,
		});

		const result = await provider.send(
			{ webhookUrl: 'https://hooks.slack.com/services/T1/B2/secret' },
			MESSAGE
		);

		expect(result.ok).toBe(true);
		const payload = JSON.parse(recorder.calls[0]?.body ?? '{}');
		// Without `text`, Slack push notifications read "can't be displayed".
		expect(payload.text).toBe(MESSAGE.title);
		expect(Array.isArray(payload.blocks)).toBe(true);
	});

	test('prefixes the mention onto the fallback text', async () => {
		const recorder = recordingFetch(() => new Response('ok'));
		const provider = createSlackWebhookProvider({
			fetchImpl: recorder.fetch,
		});
		await provider.send(
			{
				webhookUrl: 'https://hooks.slack.com/services/T1/B2/secret',
				mention: '<!here>',
			},
			MESSAGE
		);
		expect(JSON.parse(recorder.calls[0]?.body ?? '{}').text).toBe(
			`<!here> ${MESSAGE.title}`
		);
	});

	test('treats a revoked webhook as permanent and a 500 as retryable', async () => {
		const revoked = createSlackWebhookProvider({
			fetchImpl: recordingFetch(
				() => new Response('invalid_token', { status: 403 })
			).fetch,
		});
		const dead = await revoked.send(
			{ webhookUrl: 'https://hooks.slack.com/services/T1/B2/x' },
			MESSAGE
		);
		expect(dead).toMatchObject({ ok: false, retryable: false });

		const flaky = createSlackWebhookProvider({
			fetchImpl: recordingFetch(
				() => new Response('server error', { status: 500 })
			).fetch,
		});
		const transient = await flaky.send(
			{ webhookUrl: 'https://hooks.slack.com/services/T1/B2/x' },
			MESSAGE
		);
		expect(transient).toMatchObject({ ok: false, retryable: true });
	});

	test('never exposes the webhook token in the public view', () => {
		const provider = createSlackWebhookProvider();
		const view = provider.publicView({
			webhookUrl: 'https://hooks.slack.com/services/T123/B456/sUpErSeCrEt',
		});
		expect(JSON.stringify(view)).not.toContain('sUpErSeCrEt');
		expect(view).toMatchObject({
			host: 'hooks.slack.com',
			workspaceId: 'T123',
		});
	});
});

/* -------------------------------------------------------------------------- */

describe('generic webhook', () => {
	const NOW = new Date('2026-08-08T12:00:00.000Z');
	const options = { now: () => NOW };

	test('sends a versioned, structured payload', async () => {
		const recorder = recordingFetch(() => new Response('', { status: 204 }));
		const provider = createWebhookProvider({
			...options,
			fetchImpl: recorder.fetch,
		});

		const result = await provider.send(
			{ url: 'https://example.test/hook' },
			MESSAGE
		);

		expect(result.ok).toBe(true);
		const body = JSON.parse(recorder.calls[0]?.body ?? '{}');
		expect(body).toMatchObject({
			version: 1,
			event: 'new_vulnerabilities',
			severity: 'critical',
			project: { id: 'proj_1', name: 'web & api' },
		});
		expect(body.sections).toHaveLength(2);
		expect(typeof body.text).toBe('string');
		expect(recorder.calls[0]?.headers['x-understory-event']).toBe(
			'new_vulnerabilities'
		);
	});

	test('signs the exact body it sends', async () => {
		const recorder = recordingFetch(() => new Response('ok'));
		const provider = createWebhookProvider({
			...options,
			fetchImpl: recorder.fetch,
		});

		await provider.send(
			{ url: 'https://example.test/hook', secret: 'hunter2hunter2' },
			MESSAGE
		);

		const call = recorder.calls[0];
		const timestamp = call?.headers['x-understory-timestamp'] ?? '';
		const expected = `sha256=${createHmac('sha256', 'hunter2hunter2')
			.update(`${timestamp}.${call?.body ?? ''}`)
			.digest('hex')}`;
		expect(call?.headers['x-understory-signature']).toBe(expected);
	});

	test('omits the signature when no secret is configured', async () => {
		const recorder = recordingFetch(() => new Response('ok'));
		const provider = createWebhookProvider({
			...options,
			fetchImpl: recorder.fetch,
		});
		await provider.send({ url: 'https://example.test/hook' }, MESSAGE);
		expect(
			recorder.calls[0]?.headers['x-understory-signature']
		).toBeUndefined();
	});

	test('binds the timestamp into the signature so a replay cannot be re-stamped', () => {
		const a = signWebhookBody('secret12', '1000', '{"a":1}');
		const b = signWebhookBody('secret12', '2000', '{"a":1}');
		expect(a).not.toBe(b);
	});

	test('refuses to let custom headers overwrite the signature', async () => {
		const recorder = recordingFetch(() => new Response('ok'));
		const provider = createWebhookProvider({
			...options,
			fetchImpl: recorder.fetch,
		});

		await provider.send(
			{
				url: 'https://example.test/hook',
				secret: 'hunter2hunter2',
				headers: {
					'X-Understory-Signature': 'sha256=forged',
					'Content-Type': 'text/plain',
					Authorization: 'Bearer legit',
				},
			},
			MESSAGE
		);

		const headers = recorder.calls[0]?.headers ?? {};
		expect(headers['x-understory-signature']).not.toBe('sha256=forged');
		expect(headers['content-type']).toBe('application/json');
		// Non-reserved headers still pass through.
		expect(headers.authorization).toBe('Bearer legit');
	});

	test('classifies 4xx as permanent and 5xx as retryable', async () => {
		const gone = createWebhookProvider({
			...options,
			fetchImpl: recordingFetch(() => new Response('', { status: 410 }))
				.fetch,
		});
		expect(
			await gone.send({ url: 'https://example.test/hook' }, MESSAGE)
		).toMatchObject({ ok: false, retryable: false });

		const down = createWebhookProvider({
			...options,
			fetchImpl: recordingFetch(() => new Response('', { status: 502 }))
				.fetch,
		});
		expect(
			await down.send({ url: 'https://example.test/hook' }, MESSAGE)
		).toMatchObject({ ok: false, retryable: true });
	});

	test('honours a Retry-After on 429', async () => {
		const limited = createWebhookProvider({
			...options,
			fetchImpl: recordingFetch(
				() =>
					new Response('', {
						status: 429,
						headers: { 'retry-after': '30' },
					})
			).fetch,
		});
		const result = await limited.send(
			{ url: 'https://example.test/hook' },
			MESSAGE
		);
		expect(result).toMatchObject({ ok: false, retryable: true });
		expect(result.ok === false && result.retryAfterMs).toBe(30_000);
	});

	test('never exposes the secret or header values in the public view', () => {
		const view = createWebhookProvider().publicView({
			url: 'https://example.test/hooks/abc',
			secret: 'sUpErSeCrEt',
			headers: { Authorization: 'Bearer tOkEn' },
		});
		const serialized = JSON.stringify(view);
		expect(serialized).not.toContain('sUpErSeCrEt');
		expect(serialized).not.toContain('tOkEn');
		expect(view).toMatchObject({
			host: 'example.test',
			path: '/hooks/abc',
			signed: true,
			customHeaders: 1,
		});
	});

	test('payload keeps a null project when the message has none', () => {
		const payload = toWebhookPayload(
			{ ...MESSAGE, projectId: undefined, projectName: undefined },
			NOW
		);
		expect(payload.project).toBeNull();
		expect(payload.sentAt).toBe('2026-08-08T12:00:00.000Z');
	});
});
