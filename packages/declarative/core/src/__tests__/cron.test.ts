import { describe, expect, test } from 'bun:test';
import { cronMatches, nextCronOccurrence, parseCron } from '../cron';

describe('parseCron', () => {
	test('rejects malformed expressions', () => {
		expect(() => parseCron('* * * *')).toThrow('expected 5 fields');
		expect(() => parseCron('61 * * * *')).toThrow('out of range');
		expect(() => parseCron('*/0 * * * *')).toThrow('invalid step');
		expect(() => parseCron('1-2-3 * * * *')).toThrow('malformed range');
		expect(() => parseCron('a * * * *')).toThrow('out of range');
	});

	test('normalizes day-of-week 7 to 0 (Sunday)', () => {
		const spec = parseCron('0 0 * * 7');
		// 2026-07-12 is a Sunday.
		expect(cronMatches(spec, new Date(2026, 6, 12, 0, 0))).toBe(true);
	});
});

describe('cronMatches', () => {
	test('steps and lists', () => {
		const spec = parseCron('*/15 9-17 * * 1,3,5');
		// 2026-07-13 is a Monday.
		expect(cronMatches(spec, new Date(2026, 6, 13, 9, 0))).toBe(true);
		expect(cronMatches(spec, new Date(2026, 6, 13, 9, 45))).toBe(true);
		expect(cronMatches(spec, new Date(2026, 6, 13, 9, 50))).toBe(false);
		expect(cronMatches(spec, new Date(2026, 6, 13, 18, 0))).toBe(false);
		// 2026-07-14 is a Tuesday.
		expect(cronMatches(spec, new Date(2026, 6, 14, 9, 0))).toBe(false);
	});

	test('restricted dom OR restricted dow (standard cron rule)', () => {
		const spec = parseCron('0 0 13 * 1');
		// Monday the 13th, Monday the 20th, Tuesday the 13th all match…
		expect(cronMatches(spec, new Date(2026, 6, 13, 0, 0))).toBe(true);
		expect(cronMatches(spec, new Date(2026, 6, 20, 0, 0))).toBe(true);
		expect(cronMatches(spec, new Date(2026, 9, 13, 0, 0))).toBe(true);
		// …but Tuesday the 14th does not.
		expect(cronMatches(spec, new Date(2026, 6, 14, 0, 0))).toBe(false);
	});
});

describe('nextCronOccurrence', () => {
	test('finds the next matching minute strictly after', () => {
		const spec = parseCron('*/5 * * * *');
		const next = nextCronOccurrence(spec, new Date(2026, 6, 12, 10, 0, 30));
		expect(next.getMinutes()).toBe(5);
		expect(next.getSeconds()).toBe(0);
	});

	test('rolls over to the next day', () => {
		const spec = parseCron('30 6 * * *');
		const next = nextCronOccurrence(spec, new Date(2026, 6, 12, 7, 0));
		expect(next.getDate()).toBe(13);
		expect(next.getHours()).toBe(6);
		expect(next.getMinutes()).toBe(30);
	});
});
