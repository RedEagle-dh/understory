import { defineRouteStage, halt, provide } from '@declarativejs/core';
import type { Auth } from './auth';
import { isKnownRole, type Permissions, type Role, roles } from './permissions';

/**
 * Per-route policy declaration. Installing this stage on a surface makes
 * `policy` a REQUIRED field on every route built from it (compile-enforced by
 * the pipeline's accumulated Decl).
 */
export type Policy = 'authenticated' | { readonly permissions: Permissions };

export interface PolicyDecl {
	readonly policy: Policy;
}

export interface AuthUser {
	readonly id: string;
	readonly email: string;
	readonly name: string;
	readonly role: Role;
}

export interface AuthProvides {
	readonly user: AuthUser;
	readonly role: Role;
	readonly sessionId: string;
}

export function createAuthStage(auth: Auth) {
	return defineRouteStage<PolicyDecl, object, AuthProvides>(
		'auth',
		async (decl, ctx) => {
			const headers = new Headers();
			for (const [key, value] of Object.entries(ctx.headers)) {
				if (value !== undefined) headers.set(key, value);
			}

			const session = await auth.api.getSession({ headers });
			if (session === null) return halt(401, 'UNAUTHENTICATED');
			if (session.user.banned === true) return halt(403, 'USER_BANNED');

			const role = session.user.role ?? 'viewer';
			if (!isKnownRole(role)) return halt(403, 'UNKNOWN_ROLE');

			if (decl.policy !== 'authenticated') {
				// In-process check — roles[role].authorize is public better-auth
				// API; no DB hop per request.
				const decision = roles[role].authorize(
					decl.policy.permissions as Parameters<
						(typeof roles)[Role]['authorize']
					>[0]
				);
				if (!decision.success) return halt(403, 'FORBIDDEN');
			}

			return provide({
				user: {
					id: session.user.id,
					email: session.user.email,
					name: session.user.name,
					role,
				},
				role,
				sessionId: session.session.id,
			});
		}
	);
}
