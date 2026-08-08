import { type Static, t } from '@declarativejs/core';
import type {
	NotificationMessage,
	NotificationProviderPort,
} from './port';
import { toSlackBlocks } from './templates/render';

export const SlackWebhookConfigSchema = t.Object({
	webhookUrl: t.String({ minLength: 10, maxLength: 500 }),
	/** Optional prefix, e.g. `<!here>` or `<!subteam^S123>`. */
	mention: t.Optional(t.String({ maxLength: 100 })),
});

export type SlackWebhookConfig = Static<typeof SlackWebhookConfigSchema>;

/**
 * Slack answers an incoming webhook with a plain-text body, not JSON:
 * `ok`, or one of these. All of them mean the URL will never work again.
 */
const PERMANENT_BODIES = new Set([
	'invalid_token',
	'no_service',
	'no_team',
	'team_disabled',
	'channel_is_archived',
	'action_prohibited',
]);

const PERMANENT_STATUSES = new Set([400, 403, 404, 410]);

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function readBody(response: Response): Promise<string> {
	try {
		return (await response.text()).trim().slice(0, 200);
	} catch {
		return '';
	}
}

export interface SlackWebhookProviderOptions {
	fetchImpl?: typeof fetch;
}

/**
 * Slack incoming webhook.
 *
 * No `verify()`: unlike Discord, a Slack webhook URL answers GET with 400 and
 * offers no metadata endpoint, so the only way to learn whether it works is to
 * post to it. Omitting `verify` makes `channels.test` fall straight through to
 * a real (visible) message, which is the honest answer anyway.
 */
export function createSlackWebhookProvider(
	options: SlackWebhookProviderOptions = {}
): NotificationProviderPort<SlackWebhookConfig> {
	const doFetch = options.fetchImpl ?? fetch;

	return {
		type: 'slack_webhook',
		configSchema: SlackWebhookConfigSchema,
		secretFields: ['webhookUrl'],

		publicView(config) {
			// The path is `/services/T…/B…/<secret>`: the workspace and channel
			// ids are safe to show, the trailing token is not.
			let host = 'hooks.slack.com';
			let workspaceId = '';
			try {
				const url = new URL(config.webhookUrl);
				host = url.host;
				workspaceId =
					url.pathname.split('/').filter(Boolean).at(1) ?? '';
			} catch {
				/* stored config predates validation — show what we can */
			}
			return {
				host,
				workspaceId,
				...(config.mention === undefined
					? {}
					: { mention: config.mention }),
			};
		},

		async send(config, message: NotificationMessage) {
			const payload = {
				// `text` is the notification/fallback string Slack shows in the
				// sidebar and on mobile push; without it those read "This
				// content can't be displayed".
				text:
					config.mention === undefined
						? message.title
						: `${config.mention} ${message.title}`,
				blocks: toSlackBlocks(message),
			};

			let response: Response;
			try {
				response = await doFetch(config.webhookUrl, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(payload),
				});
			} catch (error) {
				return {
					ok: false,
					retryable: true,
					error: `Slack webhook request failed: ${messageOf(error)}`,
				};
			}

			if (response.status === 429) {
				const header = response.headers.get('retry-after');
				const seconds = header === null ? Number.NaN : Number(header);
				return {
					ok: false,
					retryable: true,
					error: 'Slack rate limited the webhook',
					retryAfterMs: Math.max(
						1000,
						Math.round((Number.isFinite(seconds) ? seconds : 60) * 1000)
					),
				};
			}

			const body = await readBody(response);
			if (response.ok) return { ok: true };

			return {
				ok: false,
				retryable:
					!PERMANENT_STATUSES.has(response.status) &&
					!PERMANENT_BODIES.has(body),
				error: `Slack webhook returned ${response.status}: ${body}`,
			};
		},
	};
}

export const slackWebhookProvider = createSlackWebhookProvider();
