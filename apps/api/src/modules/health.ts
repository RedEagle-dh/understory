import { TypedError, t } from '@declarativejs/core';
import { defineModule } from '@declarativejs/core/app';
import type { AppEnv } from '../environment';

class NotReadyError extends TypedError {
	readonly code = 'NOT_READY';
	readonly status = 503;
	constructor() {
		super('Service is draining');
	}
}

export function healthModule() {
	return defineModule({
		id: 'health',
		build: (env: AppEnv) => {
			const route = env.surfaces.public;

			const ready = route({
				id: 'health.ready',
				method: 'GET',
				path: '/ready',
				params: t.Object({}),
				query: t.Object({}),
				body: t.Undefined(),
				response: t.Object({ status: t.Literal('ready') }),
				errors: [NotReadyError],
				docs: {
					summary: 'Readiness probe (503 while draining)',
					tag: 'Health',
				},
				handler: async () => {
					if (!env.isReady()) throw new NotReadyError();
					return { status: 'ready' as const };
				},
			});

			const bootstrapStatus = route({
				id: 'bootstrap.status',
				method: 'GET',
				path: '/api/bootstrap',
				params: t.Object({}),
				query: t.Object({}),
				body: t.Undefined(),
				response: t.Object({ setupRequired: t.Boolean() }),
				docs: {
					summary:
						'Whether the one-time first-admin signup is still open',
					tag: 'Health',
				},
				handler: async () => ({
					setupRequired: await env.isSetupRequired(),
				}),
			});

			return { routes: [ready, bootstrapStatus] as const };
		},
	});
}
