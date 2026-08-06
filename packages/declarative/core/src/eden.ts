import type { StaticEncode, TSchema } from '@sinclair/typebox';
import type { CreateEden, Elysia } from 'elysia';
import type { HttpMethod, RouteInstance } from './route';

/**
 * Type-level bridge from framework routes to Eden treaty (types only — no
 * runtime). Eden's `Treaty.Create<App>` reads exactly one thing from the app
 * type: the `~Routes` record (Elysia's 5th generic). Routes defined through
 * the RouteFactory carry their method/path/schemas as generics, so that
 * record can be derived here without the routes ever being built as Elysia
 * method chains — `mountRoutes` stays a type-erased transport.
 *
 * Usage (composition root / client):
 *   const routes = [...moderationRoutes(deps), ...internalRoutes(deps)] as const;
 *   export type V2App = EdenApp<typeof routes>;
 *   // client side:
 *   const api = treaty<V2App>(baseUrl);
 *
 * Wire types are `StaticEncode` (what crosses HTTP), not the `StaticDecode`
 * handlers see — the two differ once schemas use Transform.
 */

type RouteLeaf<Route> =
	Route extends RouteInstance<
		infer Method,
		infer Path,
		infer Params,
		infer Query,
		infer Body,
		infer Response
	>
		? CreateEden<
				Path,
				{
					[K in Lowercase<Method>]: {
						body: StaticEncode<Body>;
						params: StaticEncode<Params>;
						query: StaticEncode<Query>;
						headers: unknown;
						response: { 200: StaticEncode<Response> };
					};
				}
			>
		: never;

type UnionToIntersection<U> = (
	U extends unknown
		? (x: U) => void
		: never
) extends (x: infer I) => void
	? I
	: never;

export type EdenRoutes<
	Routes extends readonly RouteInstance<
		HttpMethod,
		string,
		TSchema,
		TSchema,
		TSchema,
		TSchema
	>[],
> = UnionToIntersection<RouteLeaf<Routes[number]>>;

/**
 * A phantom Elysia type carrying the routes' Eden record — never instantiated,
 * it exists purely to satisfy `treaty<App>`'s constraint and feed its
 * `~Routes` lookup. All other generics are Elysia's defaults.
 */
export type EdenApp<
	Routes extends readonly RouteInstance<
		HttpMethod,
		string,
		TSchema,
		TSchema,
		TSchema,
		TSchema
	>[],
> = Elysia<
	'',
	{ decorator: {}; store: {}; derive: {}; resolve: {} },
	{ typebox: {}; error: {} },
	{
		schema: {};
		standaloneSchema: {};
		macro: {};
		macroFn: {};
		parser: {};
		response: {};
	},
	EdenRoutes<Routes> & Record<string, unknown>
>;
