/**
 * Minimal 5-field cron matcher (minute hour day-of-month month day-of-week),
 * minute resolution — enough for `job()` schedules without a dependency.
 * Supports `*`, numbers, ranges (`a-b`), lists (`a,b,c`) and `/n` steps on
 * star or range. Names and seconds are not supported on purpose; sub-minute
 * cadence is `{ everyMs }` on the job schedule.
 */

interface CronField {
	/** Allowed values, already normalized (dow 7 -> 0). */
	readonly values: ReadonlySet<number>;
}

export interface CronSpec {
	readonly minute: CronField;
	readonly hour: CronField;
	readonly dayOfMonth: CronField;
	readonly month: CronField;
	readonly dayOfWeek: CronField;
	/** True when the field was `*` — needed for the dom/dow OR rule. */
	readonly anyDayOfMonth: boolean;
	readonly anyDayOfWeek: boolean;
}

interface FieldRange {
	readonly min: number;
	readonly max: number;
}

const FIELD_RANGES: readonly FieldRange[] = [
	{ min: 0, max: 59 }, // minute
	{ min: 0, max: 23 }, // hour
	{ min: 1, max: 31 }, // day of month
	{ min: 1, max: 12 }, // month
	{ min: 0, max: 7 }, // day of week (7 = Sunday = 0)
];

function parseField(
	expr: string,
	range: FieldRange,
	field: string
): { values: Set<number>; isAny: boolean } {
	const values = new Set<number>();
	let isAny = false;
	for (const part of expr.split(',')) {
		const [body, stepRaw, ...rest] = part.split('/');
		if (body === undefined || body === '' || rest.length > 0) {
			throw new Error(`cron: malformed part "${part}" in ${field}`);
		}
		const step = stepRaw === undefined ? 1 : Number(stepRaw);
		if (!Number.isInteger(step) || step < 1) {
			throw new Error(`cron: invalid step "${stepRaw}" in ${field}`);
		}
		let from: number;
		let to: number;
		if (body === '*') {
			if (part === '*') isAny = true;
			from = range.min;
			to = range.max;
		} else if (body.includes('-')) {
			const [a, b, ...more] = body.split('-');
			from = Number(a);
			to = Number(b);
			if (more.length > 0 || Number.isNaN(from) || Number.isNaN(to)) {
				throw new Error(`cron: malformed range "${body}" in ${field}`);
			}
		} else {
			from = Number(body);
			to = from;
			if (stepRaw !== undefined) to = range.max;
		}
		if (
			!Number.isInteger(from) ||
			!Number.isInteger(to) ||
			from < range.min ||
			to > range.max ||
			from > to
		) {
			throw new Error(
				`cron: value out of range in ${field}: "${part}" (${range.min}-${range.max})`
			);
		}
		for (let value = from; value <= to; value += step) {
			values.add(value === 7 && range.max === 7 ? 0 : value);
		}
	}
	return { values, isAny };
}

export function parseCron(expression: string): CronSpec {
	const fields = expression.trim().split(/\s+/);
	if (fields.length !== 5) {
		throw new Error(
			`cron: expected 5 fields (minute hour dom month dow), got "${expression}"`
		);
	}
	const names = ['minute', 'hour', 'day-of-month', 'month', 'day-of-week'];
	const parsed = fields.map((field, index) => {
		const range = FIELD_RANGES[index];
		const name = names[index];
		if (range === undefined || name === undefined) {
			throw new Error('cron: internal field mismatch');
		}
		return parseField(field, range, name);
	});
	const [minute, hour, dayOfMonth, month, dayOfWeek] = parsed;
	if (
		minute === undefined ||
		hour === undefined ||
		dayOfMonth === undefined ||
		month === undefined ||
		dayOfWeek === undefined
	) {
		throw new Error('cron: internal field mismatch');
	}
	return {
		minute: { values: minute.values },
		hour: { values: hour.values },
		dayOfMonth: { values: dayOfMonth.values },
		month: { values: month.values },
		dayOfWeek: { values: dayOfWeek.values },
		anyDayOfMonth: dayOfMonth.isAny,
		anyDayOfWeek: dayOfWeek.isAny,
	};
}

function matchesDay(spec: CronSpec, date: Date): boolean {
	const domMatch = spec.dayOfMonth.values.has(date.getDate());
	const dowMatch = spec.dayOfWeek.values.has(date.getDay());
	// Standard cron rule: when BOTH dom and dow are restricted, either matches.
	if (!spec.anyDayOfMonth && !spec.anyDayOfWeek) return domMatch || dowMatch;
	return domMatch && dowMatch;
}

export function cronMatches(spec: CronSpec, date: Date): boolean {
	return (
		spec.minute.values.has(date.getMinutes()) &&
		spec.hour.values.has(date.getHours()) &&
		spec.month.values.has(date.getMonth() + 1) &&
		matchesDay(spec, date)
	);
}

/**
 * The next matching minute strictly after `after` (local time). Scans minute
 * by minute with a 4-year bound — any valid spec matches well within it.
 */
export function nextCronOccurrence(spec: CronSpec, after: Date): Date {
	const candidate = new Date(after.getTime());
	candidate.setSeconds(0, 0);
	candidate.setMinutes(candidate.getMinutes() + 1);
	const limit = after.getTime() + 4 * 366 * 24 * 60 * 60 * 1000;
	while (candidate.getTime() <= limit) {
		if (cronMatches(spec, candidate)) return candidate;
		candidate.setMinutes(candidate.getMinutes() + 1);
	}
	throw new Error('cron: no occurrence within 4 years');
}
