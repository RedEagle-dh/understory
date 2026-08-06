import type { Stage } from './pipeline';
import { halt, provide } from './pipeline';
import type { RateLimiterPort } from './ports';
import { defineRouteStage, type RequestContext } from './route';

/**
 * Which identity a preset counts against. `actor`/`tenant` come from the
 * composition root's subject extractor (the framework cannot name the domain
 * types, ADR-0012); `ip` comes from the transport.
 */
export type RateLimitScope = 'actor' | 'tenant' | 'ip';

export interface RateLimitPreset {
	readonly limit: number;
	readonly windowSeconds: number;
	readonly scope: RateLimitScope;
}

export interface RateLimitSubject {
	readonly actorId?: string;
	readonly tenantId?: string;
}

export interface RateLimitDecl<PresetName extends string = string> {
	/** Names a preset from the factory's set — routes never carry raw numbers (ADR-0005). */
	readonly rateLimit?: PresetName;
}

/**
 * The rate-limit stage. Buckets are per route + preset, keyed by the preset's
 * scope. Denies with 429 + Retry-After. An unresolvable key (e.g. no client
 * ip behind a misconfigured transport) fails OPEN with a warning — limits
 * protect capacity and must never become an outage of their own.
 */
export function createRateLimitStage<
	Requires extends object,
	Presets extends Record<string, RateLimitPreset>,
>(
	limiter: RateLimiterPort,
	presets: Presets,
	subjectFrom: (ctx: RequestContext & Requires) => RateLimitSubject
): Stage<
	RequestContext,
	RateLimitDecl<Extract<keyof Presets, string>>,
	Requires,
	object
> {
	return defineRouteStage<
		RateLimitDecl<Extract<keyof Presets, string>>,
		Requires,
		object
	>('rate-limit', async (decl, ctx) => {
		if (decl.rateLimit === undefined) return provide({});
		const preset = presets[decl.rateLimit];
		if (preset === undefined) {
			ctx.log.warn('unknown rate limit preset — allowing', {
				preset: decl.rateLimit,
			});
			return provide({});
		}

		const subject = subjectFrom(ctx);
		const key =
			preset.scope === 'ip'
				? ctx.ip
				: preset.scope === 'actor'
					? subject.actorId
					: subject.tenantId;
		if (key === undefined) {
			ctx.log.warn('rate limit key unresolvable — allowing', {
				preset: decl.rateLimit,
				scope: preset.scope,
			});
			return provide({});
		}

		const decision = await limiter.consume(
			`${ctx.surface}:${ctx.routeId}:${decl.rateLimit}`,
			key,
			preset.limit,
			preset.windowSeconds
		);
		if (!decision.allowed) {
			ctx.log.info('rate limited', {
				preset: decl.rateLimit,
				scope: preset.scope,
			});
			return halt(
				429,
				'RATE_LIMITED',
				undefined,
				decision.retryAfterSeconds === undefined
					? undefined
					: { 'retry-after': String(decision.retryAfterSeconds) }
			);
		}
		return provide({});
	});
}
