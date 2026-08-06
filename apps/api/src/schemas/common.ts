import { t } from '@declarativejs/core';

/** Shared TypeBox models used across route modules. */

export const Severity = t.Union([
	t.Literal('low'),
	t.Literal('moderate'),
	t.Literal('high'),
	t.Literal('critical'),
]);

export const SeverityCounts = t.Object({
	critical: t.Number(),
	high: t.Number(),
	moderate: t.Number(),
	low: t.Number(),
});

export const Pagination = t.Object({
	page: t.Optional(t.Number({ minimum: 1, default: 1 })),
	pageSize: t.Optional(t.Number({ minimum: 1, maximum: 200, default: 50 })),
});

export const IdParam = t.Object({
	id: t.String({ minLength: 1, maxLength: 64 }),
});

export const Empty = t.Object({});

export const OkResponse = t.Object({ ok: t.Boolean() });
