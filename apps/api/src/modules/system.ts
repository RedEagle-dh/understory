import { t } from '@declarativejs/core';
import { defineModule } from '@declarativejs/core/app';
import type { AppEnv } from '../environment';

const VersionView = t.Object({
	currentVersion: t.String(),
	latestVersion: t.Union([t.String(), t.Null()]),
	releaseUrl: t.Union([t.String(), t.Null()]),
	updateAvailable: t.Boolean(),
	checkedAt: t.Union([t.Date(), t.Null()]),
});

export function systemModule() {
	return defineModule({
		id: 'system',
		build: (env: AppEnv) => {
			const route = env.surfaces.authed;

			const version = route({
				id: 'system.version',
				method: 'GET',
				path: '/api/system/version',
				policy: 'authenticated',
				rateLimit: 'read',
				params: t.Object({}),
				query: t.Object({}),
				body: t.Undefined(),
				response: VersionView,
				docs: {
					summary:
						'Running version and whether a newer release exists',
					tag: 'System',
				},
				handler: async () => env.updateCheckService.status(),
			});

			return { routes: [version] as const };
		},
	});
}
