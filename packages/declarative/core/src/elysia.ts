import { Elysia } from 'elysia';
import type { RouteInstance } from './route';

function headersToRecord(headers: Headers): Record<string, string | undefined> {
	const record: Record<string, string | undefined> = {};
	headers.forEach((value, key) => {
		record[key] = value;
	});
	return record;
}

export interface MountOptions {
	/**
	 * Trust `X-Forwarded-For` for the client IP (first hop). Only enable when a
	 * reverse proxy strips/overwrites the header — otherwise it is spoofable.
	 * Off, the socket address is used.
	 */
	readonly trustProxy?: boolean;
}

/** The transport's view of Bun's server — only what IP resolution needs. */
interface RequestIpSource {
	requestIP(request: Request): { address: string } | null;
}

function resolveIp(
	request: Request,
	server: RequestIpSource | null,
	trustProxy: boolean
): string | undefined {
	if (trustProxy) {
		const forwarded = request.headers.get('x-forwarded-for');
		const first = forwarded?.split(',')[0]?.trim();
		if (first !== undefined && first !== '') return first;
	}
	return server?.requestIP(request)?.address;
}

/**
 * Mounts framework routes onto an Elysia app. Validation, auth, metrics and
 * error mapping all live in the route runner — Elysia is transport only: it
 * resolves the client IP, applies the runner's response headers and stamps
 * the security defaults every API response carries.
 */
export function mountRoutes(
	app: Elysia,
	routes: readonly RouteInstance[],
	options: MountOptions = {}
): Elysia {
	const trustProxy = options.trustProxy ?? false;
	for (const route of routes) {
		const handler = async ({
			params,
			query,
			body,
			request,
			server,
			set,
		}: {
			params: unknown;
			query: unknown;
			body: unknown;
			request: Request;
			server: RequestIpSource | null;
			set: {
				status?: number | string;
				headers: Record<string, string | number | undefined>;
			};
		}) => {
			// Elysia hands undefined params/query on routes without dynamic
			// segments / query strings; the schemas expect objects.
			const result = await route.execute({
				params: params ?? {},
				query: query ?? {},
				body,
				headers: headersToRecord(request.headers),
				ip: resolveIp(request, server, trustProxy),
			});
			set.status = result.status;
			set.headers['x-content-type-options'] = 'nosniff';
			set.headers['cache-control'] = 'no-store';
			for (const [key, value] of Object.entries(result.headers)) {
				set.headers[key] = value;
			}
			return result.body;
		};

		switch (route.method) {
			case 'GET':
				app.get(route.path, handler);
				break;
			case 'POST':
				app.post(route.path, handler);
				break;
			case 'PUT':
				app.put(route.path, handler);
				break;
			case 'PATCH':
				app.patch(route.path, handler);
				break;
			case 'DELETE':
				app.delete(route.path, handler);
				break;
		}
	}
	return app;
}
