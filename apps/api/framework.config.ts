import { defineConfig } from '@declarativejs/core/config';

/**
 * Source of truth for `dcl gen`, which generates src/generated/manifest.ts.
 * Add modules here (or via `dcl add`), then regenerate.
 */
export default defineConfig({
	environment: './src/environment.ts',
	modules: {
		health: { package: './src/modules/health', export: 'healthModule' },
		projects: {
			package: './src/modules/projects',
			export: 'projectsModule',
		},
		scans: { package: './src/modules/scans', export: 'scansModule' },
		dependencies: {
			package: './src/modules/dependencies',
			export: 'dependenciesModule',
		},
		vulnerabilities: {
			package: './src/modules/vulnerabilities',
			export: 'vulnerabilitiesModule',
		},
		pullRequests: {
			package: './src/modules/pull-requests',
			export: 'pullRequestsModule',
		},
		notifications: {
			package: './src/modules/notifications',
			export: 'notificationsModule',
		},
		admin: { package: './src/modules/admin', export: 'adminModule' },
		dashboard: {
			package: './src/modules/dashboard',
			export: 'dashboardModule',
		},
		system: { package: './src/modules/system', export: 'systemModule' },
		jobs: { package: './src/modules/jobs', export: 'jobsModule' },
	},
	telemetry: {
		observability: {
			enabled: true,
			package: '@declarativejs/module-observability',
			export: 'observabilityModule',
			options: { serviceName: 'understory-api' },
		},
	},
});
