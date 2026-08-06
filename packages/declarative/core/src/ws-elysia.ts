import type { Elysia } from 'elysia';
import type { WsConnection, WsHub } from './ws';

export interface MountWsOptions {
	/** Endpoint path, e.g. `/internal/ws`. */
	readonly path: string;
	/** Same trust rule as mountRoutes: only behind a sanitizing proxy. */
	readonly trustProxy?: boolean;
}

function headersToRecord(headers: Headers): Record<string, string | undefined> {
	const record: Record<string, string | undefined> = {};
	headers.forEach((value, key) => {
		record[key] = value;
	});
	return record;
}

/**
 * Binds a WsHub to an Elysia websocket endpoint — transport only, exactly
 * like mountRoutes: the hub owns protocol, authorization and fan-out. The
 * upgrade is always accepted (subscribe is the policy moment, ADR-0005); the
 * upgrade request's headers (session cookie et al.) authenticate each
 * subsequent subscribe.
 */
export function mountWsHub(
	app: Elysia,
	hub: WsHub,
	options: MountWsOptions
): Elysia {
	const connections = new Map<string, WsConnection>();
	app.ws(options.path, {
		open: (ws) => {
			const headers = headersToRecord(ws.data.request.headers);
			const forwarded = headers['x-forwarded-for']?.split(',')[0]?.trim();
			const ip =
				options.trustProxy === true &&
				forwarded !== undefined &&
				forwarded !== ''
					? forwarded
					: ws.remoteAddress;
			const connection = hub.connection(
				{
					send: (text) => {
						ws.send(text);
					},
					close: (code, reason) => {
						ws.close(code, reason);
					},
				},
				{ headers, ip }
			);
			connections.set(ws.id, connection);
		},
		message: (ws, message) => {
			connections.get(ws.id)?.onMessage(message);
		},
		close: (ws) => {
			connections.get(ws.id)?.onClose();
			connections.delete(ws.id);
		},
	});
	return app;
}
