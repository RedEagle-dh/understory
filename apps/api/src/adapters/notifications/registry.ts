import { Value } from '@sinclair/typebox/value';
import { InvalidInputError } from '../../errors';
import { discordWebhookProvider } from './discord-webhook';
import { emailResendProvider } from './email-resend';
import { slackWebhookProvider } from './slack-webhook';
import { webhookProvider } from './webhook';
import type {
	NotificationProviderPort,
	NotificationProviderType,
} from './port';

/**
 * The only place provider types are enumerated. Adding a provider is one file
 * plus one entry here — the dispatcher, the stores and the routes are all
 * written against `NotificationProviderPort`.
 */
export const providers: Record<
	NotificationProviderType,
	NotificationProviderPort
> = {
	email_resend: emailResendProvider as NotificationProviderPort,
	discord_webhook: discordWebhookProvider as NotificationProviderPort,
	slack_webhook: slackWebhookProvider as NotificationProviderPort,
	webhook: webhookProvider as NotificationProviderPort,
};

export function providerFor(
	type: NotificationProviderType
): NotificationProviderPort {
	return providers[type];
}

/**
 * Validates AND normalizes a config against the provider's schema:
 * `Value.Parse` strips unknown keys, so a caller cannot smuggle extra fields
 * into `configEnc`. Schema violations surface as a 422, never a 500.
 */
export function parseProviderConfig(
	type: NotificationProviderType,
	config: unknown
): Record<string, unknown> {
	try {
		return Value.Parse(providers[type].configSchema, config) as Record<
			string,
			unknown
		>;
	} catch (error) {
		const detail =
			error instanceof Error ? error.message : 'invalid configuration';
		throw new InvalidInputError(`Invalid ${type} configuration: ${detail}`);
	}
}

/** Redacts secrets for logging/audit: `{apiKey: 'set'}` rather than the key. */
export function redactConfig(
	type: NotificationProviderType,
	config: Record<string, unknown>
): Record<string, unknown> {
	const secrets = new Set(providers[type].secretFields);
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(config)) {
		out[key] = secrets.has(key) ? '[redacted]' : value;
	}
	return out;
}
