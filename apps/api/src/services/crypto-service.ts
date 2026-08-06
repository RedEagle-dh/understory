import { createSecretBox } from '@workspace/db/crypto';
import { env } from '../env';

/**
 * Process-wide secret box sealing GitHub PATs and notification-channel
 * secrets at rest. AAD binds a sealed value to its owning row so ciphertexts
 * cannot be swapped between rows.
 */
export const secretBox = createSecretBox({
	current: env.APP_ENCRYPTION_KEY,
	previous: env.APP_ENCRYPTION_KEY_PREVIOUS,
});

export function projectTokenAad(projectId: string): string {
	return `project-token:${projectId}`;
}

export function globalTokenAad(): string {
	return 'app-settings:github-default-token';
}

export function channelConfigAad(channelId: string): string {
	return `notification-channel:${channelId}`;
}
