// Standalone config for `@better-auth/cli generate` ONLY. The CLI's loader
// (jiti, node-resolution) cannot import the real auth instance because the db
// handle pulls in bun:sqlite. Schema shape depends only on the plugin set, so
// this mirrors src/auth/auth.ts's plugins with a stubbed database.
//
// Regenerate the auth tables with:
//   bunx @better-auth/cli generate --config scripts/auth-schema-config.ts \
//     --output ../../packages/db/src/schema/auth.ts --yes
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { admin as adminPlugin } from 'better-auth/plugins/admin';
import { ac, roles } from '../src/auth/permissions';

export const auth = betterAuth({
	secret: 'generate-only',
	database: drizzleAdapter({} as never, { provider: 'sqlite' }),
	emailAndPassword: { enabled: true },
	plugins: [
		adminPlugin({
			ac,
			roles,
			defaultRole: 'viewer',
			adminRoles: ['admin'],
		}),
	],
});
