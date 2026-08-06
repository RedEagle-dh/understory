import type { FrameworkConfig } from '@declarativejs/core/config';
import { describe, expect, it } from 'bun:test';
import { serializeConfig } from '../config';
import { generateManifestSource } from '../gen';

const config: FrameworkConfig = {
	environment: './src/environment.ts',
	modules: {
		hello: { package: './src/modules/hello', export: 'helloModule' },
	},
	telemetry: {
		observability: {
			enabled: true,
			package: '@declarativejs/module-observability',
			export: 'observabilityModule',
			options: { serviceName: 'x' },
		},
		'off-one': {
			enabled: false,
			package: '@declarativejs/module-error-tracking',
			export: 'errorTrackingModule',
		},
	},
};

describe('generateManifestSource', () => {
	it('emits enabled telemetry + modules, omits disabled, derives Eden', () => {
		const src = generateManifestSource(config, '/proj');
		expect(src).toContain(
			"import { observabilityModule } from '@declarativejs/module-observability';"
		);
		expect(src).toContain(
			"import { helloModule } from '../modules/hello';"
		);
		// Disabled telemetry entry is not imported at all.
		expect(src).not.toContain('module-error-tracking');
		expect(src).toContain(
			'telemetry: [observabilityModule({"serviceName":"x"})],'
		);
		expect(src).toContain('modules: [helloModule()] as const,');
		expect(src).toContain(
			'export type AppEden = ManifestEden<typeof manifest.modules>;'
		);
	});

	it('is deterministic (safe for `gen --check`)', () => {
		expect(generateManifestSource(config, '/proj')).toBe(
			generateManifestSource(config, '/proj')
		);
	});
});

describe('serializeConfig', () => {
	it('round-trips to a defineConfig module', () => {
		const src = serializeConfig(config);
		expect(src).toContain(
			"import { defineConfig } from '@declarativejs/core/config';"
		);
		expect(src).toContain('export default defineConfig(');
		expect(src).toContain('"environment": "./src/environment.ts"');
	});
});
