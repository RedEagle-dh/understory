import { createApp } from '@declarativejs/core/app';
import type { ObservabilityInstance } from '@declarativejs/module-observability';
import { cors } from '@elysiajs/cors';
import { Elysia } from 'elysia';
import { auth } from './auth/auth';
import { env } from './env';
import { manifest } from './generated/manifest';
import { staticWeb } from './static-web';

/**
 * prom-client's `Registry.PROMETHEUS_CONTENT_TYPE` — hardcoded rather than
 * imported so apps/api does not need `prom-client` as a direct dependency
 * (see the comment on `observability` below).
 */
const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

function isObservabilityInstance(
	provider: unknown
): provider is ObservabilityInstance {
	return (
		typeof provider === 'object' &&
		provider !== null &&
		typeof (provider as { metrics?: unknown }).metrics === 'function'
	);
}

/**
 * `manifest.telemetry` is the SAME provider instance `createApp` below calls
 * `.init()` on (packages/declarative/core/src/app/create-app.ts) — `.metrics()`
 * only returns non-null once that has run, which it always has by the time an
 * HTTP request reaches the `/metrics` handler below (`createApp` runs
 * synchronously during the `.use()` chain, long before `.listen()`).
 *
 * This is the observability module's documented access path
 * (packages/declarative/modules/observability/src/index.ts): it hands back a
 * `PromMetrics` with `metricsText()`, so apps/api never touches `prom-client`
 * itself and does not need it in package.json — `prom-client` is a dependency
 * of `@declarativejs/module-observability` only.
 */
const observability = manifest.telemetry?.find(isObservabilityInstance);

/**
 * Hands the request to better-auth with the socket's client IP stamped into
 * `x-client-ip` (always overwritten, so it is not spoofable from outside).
 * better-auth reads it via `advanced.ipAddress.ipAddressHeaders` — without a
 * resolvable IP its rate limiter degrades to one shared per-path bucket.
 */
function handleAuth({
	request,
	server,
}: {
	request: Request;
	server: { requestIP(request: Request): { address: string } | null } | null;
}): Promise<Response> {
	const ip = server?.requestIP(request)?.address;
	if (ip === undefined) return auth.handler(request);
	const headers = new Headers(request.headers);
	headers.set('x-client-ip', ip);
	return auth.handler(new Request(request, { headers }));
}

/**
 * Transport-only entrypoint. Everything declarative is injected through the
 * generated manifest via a single `.use(createApp(...))`. The raw /health
 * route exists for pre-boot container probes; better-auth is mounted here in
 * the auth phase (`/api/auth/*`); `/metrics` is transport-level
 * (not a declarative route) because it serves Prometheus's own text format,
 * not JSON, and its auth (an optional bearer token, independent of user
 * sessions) doesn't fit the app's route policy model.
 */
const app = new Elysia()
	.get('/health', () => ({ status: 'ok' }))
	.use(
		cors({
			origin: env.TRUSTED_ORIGINS,
			credentials: true,
			methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
			allowedHeaders: ['Content-Type', 'Authorization'],
		})
	)
	// Method-specific mounts, NOT `.all`: Bun's router prefers a
	// method-specific route over a method-wildcard one, so `.all` here would
	// lose every GET (get-session included) to static-web's `.get('/*')`.
	.get('/api/auth/*', handleAuth)
	.post('/api/auth/*', handleAuth)
	.get('/metrics', async ({ request, set }) => {
		if (!env.METRICS_ENABLED) {
			set.status = 404;
			return { error: 'not found' };
		}
		if (env.METRICS_TOKEN !== undefined) {
			const header = request.headers.get('authorization') ?? '';
			if (header !== `Bearer ${env.METRICS_TOKEN}`) {
				set.status = 401;
				return { error: 'unauthorized' };
			}
		}
		const metrics = observability?.metrics() ?? null;
		if (metrics === null) {
			set.status = 404;
			return { error: 'not found' };
		}
		set.headers['content-type'] = PROMETHEUS_CONTENT_TYPE;
		return metrics.metricsText();
	})
	.use(createApp(manifest, { trustProxy: env.TRUST_PROXY }))
	.use(staticWeb(env.WEB_DIST_DIR))
	.listen({ port: env.PORT, hostname: env.HOST });

process.stdout.write(
	`understory api listening on http://${env.HOST}:${env.PORT}\n`
);

export type { AppEden } from './generated/manifest';
export type App = typeof app;
