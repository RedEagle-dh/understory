import { join } from 'node:path';
import type { FrameworkConfig } from '@declarativejs/core/config';

/** Loads the app's framework.config.ts (its default export). */
export async function loadConfig(projectRoot: string): Promise<FrameworkConfig> {
	const configPath = join(projectRoot, 'framework.config.ts');
	// Dynamic import is untyped; the default export is validated below.
	const loaded = await import(configPath);
	const config: FrameworkConfig = loaded.default;
	if (config === undefined) {
		throw new Error(
			`framework.config.ts has no default export (${configPath})`
		);
	}
	return config;
}

/**
 * Serializes a FrameworkConfig back to a `defineConfig({...})` module. Emitted
 * as tab-indented JSON (valid TS; safe for arbitrary `options` values) so
 * `dcl add`/`remove` can rewrite the file deterministically. The file is
 * tool-managed once you use those commands.
 */
export function serializeConfig(config: FrameworkConfig): string {
	const body = JSON.stringify(config, null, '\t');
	return [
		"import { defineConfig } from '@declarativejs/core/config';",
		'',
		`export default defineConfig(${body});`,
		'',
	].join('\n');
}

export async function writeConfig(
	projectRoot: string,
	config: FrameworkConfig
): Promise<void> {
	await Bun.write(
		join(projectRoot, 'framework.config.ts'),
		serializeConfig(config)
	);
}
