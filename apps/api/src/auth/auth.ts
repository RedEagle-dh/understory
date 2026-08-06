import { schema } from '@workspace/db';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError } from 'better-auth/api';
import { admin as adminPlugin } from 'better-auth/plugins/admin';
import { db, sqlite } from '../db';
import { env } from '../env';
import { claimBootstrap, ensureAppSettings } from './bootstrap';
import { ac, roles } from './permissions';

ensureAppSettings(sqlite, new Date());

export const auth = betterAuth({
	baseURL: env.APP_URL,
	basePath: '/api/auth',
	secret: env.BETTER_AUTH_SECRET,
	database: drizzleAdapter(db, { provider: 'sqlite', schema }),
	emailAndPassword: {
		enabled: true,
		autoSignIn: true,
		minPasswordLength: 12,
		requireEmailVerification: false,
	},
	session: {
		expiresIn: 60 * 60 * 24 * 7,
		updateAge: 60 * 60 * 24,
		cookieCache: { enabled: true, maxAge: 60 },
	},
	advanced: {
		defaultCookieAttributes: {
			sameSite: 'lax',
			secure: env.APP_URL.startsWith('https'),
		},
	},
	trustedOrigins: env.TRUSTED_ORIGINS,
	rateLimit: { enabled: true, window: 60, max: 20 },
	databaseHooks: {
		user: {
			create: {
				// Gate INVERTED for safety: only the public sign-up path is
				// subject to the bootstrap latch. Admin-initiated creation
				// (/admin/create-user) and internal paths pass through.
				before: async (user, ctx) => {
					const isSelfSignup = ctx?.path === '/sign-up/email';
					if (!isSelfSignup) return { data: user };
					if (claimBootstrap(sqlite, new Date())) {
						return { data: { ...user, role: 'admin' } };
					}
					throw new APIError('FORBIDDEN', {
						code: 'REGISTRATION_CLOSED',
						message:
							'Registration is closed. Ask an administrator to create your account.',
					});
				},
			},
		},
	},
	plugins: [
		adminPlugin({
			ac,
			roles,
			defaultRole: 'viewer',
			adminRoles: ['admin'],
		}),
	],
});

export type Auth = typeof auth;
