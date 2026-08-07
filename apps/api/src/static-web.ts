import { existsSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { Elysia } from 'elysia';

/**
 * Serves the built SPA for non-/api paths in production (single-container
 * deployment). Unknown paths fall back to index.html so client-side routing
 * works on deep links. Disabled when WEB_DIST_DIR is ''.
 */
export function staticWeb(distDir: string) {
	const app = new Elysia({ name: 'static-web' });
	if (distDir === '' || !existsSync(distDir)) return app;

	// TanStack Start's SPA build (`spa: { enabled: true }`) emits `_shell.html`
	// as the client entry point, not `index.html`; fall back to `index.html`
	// for any other static build that follows the usual convention.
	const shellName = existsSync(join(distDir, '_shell.html'))
		? '_shell.html'
		: 'index.html';
	const index = Bun.file(join(distDir, shellName));

	return app.get('/*', ({ path, set }) => {
		const safePath = normalize(path).replace(/^(\.\.[/\\])+/, '');
		if (safePath.startsWith('/api')) {
			// Unmatched API path — a bare `return` would send an empty 200,
			// and index.html would be nonsense for an API client.
			set.status = 404;
			return { error: 'not found' };
		}
		const file = Bun.file(join(distDir, safePath));
		set.headers['x-content-type-options'] = 'nosniff';
		if (safePath !== '/' && existsSync(join(distDir, safePath))) {
			// Hashed assets are immutable; everything else revalidates.
			if (safePath.includes('/assets/')) {
				set.headers['cache-control'] =
					'public, max-age=31536000, immutable';
			}
			return file;
		}
		set.headers['cache-control'] = 'no-cache';
		return index;
	});
}
