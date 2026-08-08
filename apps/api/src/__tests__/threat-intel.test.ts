import { beforeEach, describe, expect, test } from 'bun:test';
import { createDb, type Db, runMigrations, schema } from '@workspace/db';
import { eq } from 'drizzle-orm';
import {
	createThreatIntelService,
	parseEpssPage,
	parseKevCatalogue,
} from '../services/threat-intel-service';
import {
	type AdvisoriesStore,
	createAdvisoriesStore,
} from '../stores/advisories';

const EPSS_URL = 'https://epss.test/epss';
const KEV_URL = 'https://kev.test/kev.json';

const KEV_BODY = {
	title: 'CISA Catalog of Known Exploited Vulnerabilities',
	vulnerabilities: [
		{
			cveID: 'CVE-2021-44228',
			dateAdded: '2021-12-10',
			knownRansomwareCampaignUse: 'Known',
		},
		{
			cveID: 'CVE-2020-8203',
			dateAdded: '2022-05-03',
			knownRansomwareCampaignUse: 'Unknown',
		},
		// Malformed rows must not take the whole catalogue down.
		{ cveID: 'CVE-BROKEN', dateAdded: 'not-a-date' },
		{ dateAdded: '2020-01-01' },
	],
};

const EPSS_BODY = {
	status: 'OK',
	data: [
		// The API returns numbers as strings.
		{ cve: 'CVE-2021-44228', epss: '0.97553', percentile: '0.99998' },
		{ cve: 'CVE-2020-8203', epss: '0.00042', percentile: '0.10500' },
	],
};

interface Harness {
	db: Db;
	advisories: AdvisoriesStore;
	calls: string[];
}

async function seedAdvisory(
	db: Db,
	id: string,
	aliases: string[]
): Promise<void> {
	await db.insert(schema.advisories).values({
		id,
		summary: `${id} summary`,
		severity: 'moderate',
		updatedAt: new Date(),
	});
	for (const alias of [id, ...aliases]) {
		await db
			.insert(schema.advisoryAliases)
			.values({ alias, advisoryId: id })
			.onConflictDoNothing();
	}
}

function makeHarness(): Harness {
	const { db } = createDb(':memory:');
	runMigrations(db);
	return { db, advisories: createAdvisoriesStore(db), calls: [] };
}

/** A fetch double routing by URL prefix, with per-feed failure injection. */
function makeFetch(
	harness: Harness,
	options: { failKev?: boolean; failEpss?: boolean } = {}
): typeof fetch {
	return (async (input: string) => {
		const url = String(input);
		harness.calls.push(url);
		if (url.startsWith(KEV_URL)) {
			if (options.failKev === true) {
				return new Response('nope', { status: 503 });
			}
			return Response.json(KEV_BODY);
		}
		if (url.startsWith(EPSS_URL)) {
			if (options.failEpss === true) {
				return new Response('nope', { status: 500 });
			}
			return Response.json(EPSS_BODY);
		}
		return new Response('not found', { status: 404 });
	}) as unknown as typeof fetch;
}

function makeService(harness: Harness, fetchImpl: typeof fetch) {
	return createThreatIntelService({
		advisories: harness.advisories,
		fetchImpl,
		epssApiUrl: EPSS_URL,
		kevFeedUrl: KEV_URL,
		enabled: true,
	});
}

async function readAdvisory(db: Db, id: string) {
	const row = await db.query.advisories.findFirst({
		where: eq(schema.advisories.id, id),
	});
	if (row === undefined) throw new Error(`missing advisory ${id}`);
	return row;
}

/* -------------------------------------------------------------------------- */

describe('feed parsers', () => {
	test('parseKevCatalogue skips rows without a usable CVE and date', () => {
		const kev = parseKevCatalogue(KEV_BODY);
		expect(kev.size).toBe(2);
		expect(kev.get('CVE-2021-44228')?.knownRansomware).toBe(true);
		expect(kev.get('CVE-2020-8203')?.knownRansomware).toBe(false);
		expect(kev.get('CVE-2021-44228')?.addedAt.toISOString()).toBe(
			'2021-12-10T00:00:00.000Z'
		);
	});

	test('parseKevCatalogue tolerates a garbage document', () => {
		expect(parseKevCatalogue(null).size).toBe(0);
		expect(parseKevCatalogue({ vulnerabilities: 'nope' }).size).toBe(0);
	});

	test('parseEpssPage coerces the string figures', () => {
		const epss = parseEpssPage(EPSS_BODY);
		expect(epss.get('CVE-2021-44228')).toEqual({
			score: 0.97553,
			percentile: 0.99998,
		});
	});
});

/* -------------------------------------------------------------------------- */

describe('threat-intel refresh', () => {
	let harness: Harness;

	beforeEach(async () => {
		harness = makeHarness();
		await seedAdvisory(harness.db, 'GHSA-log4j', ['CVE-2021-44228']);
		await seedAdvisory(harness.db, 'GHSA-lodash', ['CVE-2020-8203']);
		// No CVE alias at all — nothing either feed can say about it.
		await seedAdvisory(harness.db, 'GHSA-orphan', []);
	});

	test('writes both signals onto the matching advisories', async () => {
		const service = makeService(harness, makeFetch(harness));
		const result = await service.refresh(new Date('2026-08-08T04:00:00Z'));

		expect(result).toMatchObject({
			examined: 2,
			epssScored: 2,
			kevListed: 2,
			errors: 0,
		});

		const log4j = await readAdvisory(harness.db, 'GHSA-log4j');
		expect(log4j.epssScore).toBeCloseTo(0.97553, 5);
		expect(log4j.kevKnownRansomware).toBe(true);
		expect(log4j.kevAddedAt).not.toBeNull();
		expect(log4j.threatIntelUpdatedAt).not.toBeNull();

		const lodash = await readAdvisory(harness.db, 'GHSA-lodash');
		expect(lodash.epssScore).toBeCloseTo(0.00042, 6);
		expect(lodash.kevKnownRansomware).toBe(false);
	});

	test('never queries an advisory without a CVE alias', async () => {
		const service = makeService(harness, makeFetch(harness));
		await service.refresh(new Date('2026-08-08T04:00:00Z'));

		const orphan = await readAdvisory(harness.db, 'GHSA-orphan');
		expect(orphan.threatIntelUpdatedAt).toBeNull();

		const epssCall = harness.calls.find((url) => url.startsWith(EPSS_URL));
		expect(epssCall).toContain('CVE-2021-44228');
		expect(epssCall).not.toContain('GHSA');
	});

	test('skips advisories refreshed recently and re-checks stale ones', async () => {
		const service = makeService(harness, makeFetch(harness));
		const first = new Date('2026-08-08T04:00:00Z');
		await service.refresh(first);

		const sameDay = await service.refresh(
			new Date('2026-08-08T10:00:00Z')
		);
		expect(sameDay.examined).toBe(0);

		const nextDay = await service.refresh(
			new Date('2026-08-09T04:00:00Z')
		);
		expect(nextDay.examined).toBe(2);
	});

	test('a KEV outage never erases a stored KEV listing', async () => {
		await makeService(harness, makeFetch(harness)).refresh(
			new Date('2026-08-08T04:00:00Z')
		);

		const degraded = makeService(
			harness,
			makeFetch(harness, { failKev: true })
		);
		const result = await degraded.refresh(new Date('2026-08-09T04:00:00Z'));

		expect(result.errors).toBe(1);
		const log4j = await readAdvisory(harness.db, 'GHSA-log4j');
		expect(log4j.kevAddedAt).not.toBeNull();
		expect(log4j.kevKnownRansomware).toBe(true);
		// EPSS answered, so its half of the write still went through.
		expect(log4j.epssScore).toBeCloseTo(0.97553, 5);
	});

	test('an EPSS outage never erases a stored score', async () => {
		await makeService(harness, makeFetch(harness)).refresh(
			new Date('2026-08-08T04:00:00Z')
		);

		const degraded = makeService(
			harness,
			makeFetch(harness, { failEpss: true })
		);
		await degraded.refresh(new Date('2026-08-09T04:00:00Z'));

		const log4j = await readAdvisory(harness.db, 'GHSA-log4j');
		expect(log4j.epssScore).toBeCloseTo(0.97553, 5);
	});

	test('a total outage writes nothing and leaves the work due', async () => {
		const service = makeService(
			harness,
			makeFetch(harness, { failKev: true, failEpss: true })
		);
		const result = await service.refresh(new Date('2026-08-08T04:00:00Z'));

		expect(result.updated).toBe(0);
		expect(result.errors).toBe(2);
		const log4j = await readAdvisory(harness.db, 'GHSA-log4j');
		// Not stamped — so the next run retries instead of waiting a day.
		expect(log4j.threatIntelUpdatedAt).toBeNull();
	});

	test('does nothing when disabled', async () => {
		const service = createThreatIntelService({
			advisories: harness.advisories,
			fetchImpl: makeFetch(harness),
			epssApiUrl: EPSS_URL,
			kevFeedUrl: KEV_URL,
			enabled: false,
		});
		const result = await service.refresh(new Date());
		expect(result.examined).toBe(0);
		expect(harness.calls).toEqual([]);
	});

	test('stamps advisories the feeds had nothing to say about', async () => {
		await seedAdvisory(harness.db, 'GHSA-quiet', ['CVE-2099-0001']);
		const service = makeService(harness, makeFetch(harness));
		await service.refresh(new Date('2026-08-08T04:00:00Z'));

		const quiet = await readAdvisory(harness.db, 'GHSA-quiet');
		expect(quiet.epssScore).toBeNull();
		expect(quiet.kevAddedAt).toBeNull();
		// Stamped anyway, so an unscored CVE is not re-queried every run.
		expect(quiet.threatIntelUpdatedAt).not.toBeNull();
	});
});

describe('kevListedIds', () => {
	test('reports only advisories carrying a KEV date', async () => {
		const harness = makeHarness();
		await seedAdvisory(harness.db, 'GHSA-log4j', ['CVE-2021-44228']);
		await seedAdvisory(harness.db, 'GHSA-quiet', ['CVE-2099-0001']);
		await makeService(harness, makeFetch(harness)).refresh(
			new Date('2026-08-08T04:00:00Z')
		);

		const listed = await harness.advisories.kevListedIds([
			'GHSA-log4j',
			'GHSA-quiet',
			'GHSA-missing',
		]);
		expect([...listed]).toEqual(['GHSA-log4j']);
	});

	test('short-circuits on an empty input', async () => {
		const harness = makeHarness();
		expect((await harness.advisories.kevListedIds([])).size).toBe(0);
	});
});
