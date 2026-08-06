import type { Stage } from './pipeline';
import { halt, provide } from './pipeline';
import { defineRouteStage, type RequestContext } from './route';

/**
 * Who a flag is evaluated for. Overrides target user ids: the requesting user
 * wins over the dashboard owner (whose override covers every mod acting on
 * that dashboard) — same precedence as the strangled v1 evaluation.
 */
export interface FlagSubject {
	readonly userId?: string;
	readonly dashboardOwnerUserId?: string;
}

export interface FlagsPort<Key extends string = string> {
	isEnabled(key: Key, subject: FlagSubject): Promise<boolean>;
}

export interface FlagDecl<Key extends string = string> {
	/** Route exists only while the flag is on — a 404 hides it entirely. */
	readonly flag?: Key;
}

/**
 * The feature-flag gate. Runs after the auth stages — targeting needs the
 * resolved actor/tenant, which the framework cannot name (ADR-0012), so the
 * composition root supplies the subject extractor. A disabled flag answers
 * 404: the route does not exist for this caller.
 */
export function createFlagStage<
	Requires extends object,
	Key extends string = string,
>(
	flags: FlagsPort<Key>,
	subjectFrom: (
		ctx: RequestContext & Requires
	) => FlagSubject | Promise<FlagSubject>
): Stage<RequestContext, FlagDecl<Key>, Requires, object> {
	return defineRouteStage<FlagDecl<Key>, Requires, object>(
		'flag',
		async (decl, ctx) => {
			if (decl.flag === undefined) return provide({});
			const enabled = await flags.isEnabled(
				decl.flag,
				await subjectFrom(ctx)
			);
			if (!enabled) {
				ctx.log.info('feature flag disabled', { flag: decl.flag });
				return halt(404, 'NOT_FOUND');
			}
			return provide({});
		}
	);
}
