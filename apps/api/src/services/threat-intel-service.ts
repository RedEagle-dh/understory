import type { LoggerPort } from '@declarativejs/core';
import type { AdvisoriesStore } from '../stores/advisories';

/**
 * Exploitation intelligence: how likely is this advisory to be used against
 * us, as opposed to how bad it would be if it were.
 *
 * Two feeds, both CVE-indexed and both free:
 *
 * - **EPSS** (FIRST) — a daily-recomputed probability, per CVE, of
 *   exploitation in the next 30 days. Turns "1,400 open moderates" into a
 *   ranked list.
 * - **KEV** (CISA) — CVEs *observed* being exploited. Not a prediction; a
 *   report. This is the signal that justifies overriding a project's auto-PR
 *   severity threshold.
 *
 * Neither feed is authoritative about severity and neither replaces it — they
 * are stored alongside, and the advisory-refresh job remains the only writer
 * of severity itself.
 */

/**
 * CVEs per EPSS request. The API takes a comma-separated `cve` list and caps a
 * page at 100 rows, so the batch has to stay at or under that or the tail of
 * each response is silently dropped.
 */
const EPSS_CHUNK = 100;

/** Advisories examined per run — a ceiling on a job that would otherwise grow unbounded. */
const MAX_ADVISORIES_PER_RUN = 5000;

/** Re-check cadence. EPSS recomputes daily, KEV changes a few times a week. */
const STALE_AFTER_MS = 20 * 60 * 60 * 1000;

export interface ThreatIntelDeps {
	advisories: AdvisoriesStore;
	fetchImpl?: typeof fetch;
	epssApiUrl: string;
	kevFeedUrl: string;
	/** False in air-gapped installs; `refresh` then reports zero work. */
	enabled: boolean;
	log?: LoggerPort;
}

export interface ThreatIntelResult {
	/** Advisories that were due a refresh and carried at least one CVE alias. */
	examined: number;
	/** Of those, how many got an EPSS score. */
	epssScored: number;
	/** Of those, how many are in the KEV catalogue. */
	kevListed: number;
	/** Rows written (including "checked, nothing found" stamps). */
	updated: number;
	/** Feeds that failed this run; a partial refresh still writes what it got. */
	errors: number;
}

export interface ThreatIntelService {
	refresh(now: Date): Promise<ThreatIntelResult>;
}

const EMPTY: ThreatIntelResult = {
	examined: 0,
	epssScored: 0,
	kevListed: 0,
	updated: 0,
	errors: 0,
};

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** CISA publishes `dateAdded` as `YYYY-MM-DD`, with no timezone. */
function parseKevDate(value: unknown): Date | null {
	if (typeof value !== 'string') return null;
	const parsed = Date.parse(`${value}T00:00:00Z`);
	return Number.isNaN(parsed) ? null : new Date(parsed);
}

function chunk<T>(items: readonly T[], size: number): T[][] {
	const out: T[][] = [];
	for (let index = 0; index < items.length; index += size) {
		out.push(items.slice(index, index + size));
	}
	return out;
}

export interface KevEntry {
	addedAt: Date;
	knownRansomware: boolean;
}

interface KevDocument {
	vulnerabilities?: {
		cveID?: unknown;
		dateAdded?: unknown;
		knownRansomwareCampaignUse?: unknown;
	}[];
}

/** Parses CISA's catalogue into a `CVE → entry` index. Exported for tests. */
export function parseKevCatalogue(body: unknown): Map<string, KevEntry> {
	const out = new Map<string, KevEntry>();
	const document = body as KevDocument | null;
	const list = document?.vulnerabilities;
	if (!Array.isArray(list)) return out;
	for (const entry of list) {
		if (typeof entry?.cveID !== 'string') continue;
		const addedAt = parseKevDate(entry.dateAdded);
		if (addedAt === null) continue;
		out.set(entry.cveID.toUpperCase(), {
			addedAt,
			// CISA writes "Known" / "Unknown"; anything else is treated as unknown.
			knownRansomware: entry.knownRansomwareCampaignUse === 'Known',
		});
	}
	return out;
}

export interface EpssEntry {
	score: number;
	percentile: number | null;
}

interface EpssResponse {
	data?: { cve?: unknown; epss?: unknown; percentile?: unknown }[];
}

/** Parses one EPSS API page into a `CVE → entry` index. Exported for tests. */
export function parseEpssPage(body: unknown): Map<string, EpssEntry> {
	const out = new Map<string, EpssEntry>();
	const list = (body as EpssResponse | null)?.data;
	if (!Array.isArray(list)) return out;
	for (const entry of list) {
		if (typeof entry?.cve !== 'string') continue;
		// The API returns both figures as strings ("0.00042").
		const score = Number(entry.epss);
		if (!Number.isFinite(score)) continue;
		const percentile = Number(entry.percentile);
		out.set(entry.cve.toUpperCase(), {
			score,
			percentile: Number.isFinite(percentile) ? percentile : null,
		});
	}
	return out;
}

export function createThreatIntelService(
	deps: ThreatIntelDeps
): ThreatIntelService {
	const doFetch = deps.fetchImpl ?? fetch;

	async function fetchJson(url: string): Promise<unknown> {
		const response = await doFetch(url, {
			headers: { accept: 'application/json' },
		});
		if (!response.ok) {
			throw new Error(`${url} returned ${response.status}`);
		}
		return response.json();
	}

	return {
		async refresh(now) {
			if (!deps.enabled) return { ...EMPTY };

			const due = await deps.advisories.advisoriesNeedingThreatIntel(
				new Date(now.getTime() - STALE_AFTER_MS),
				MAX_ADVISORIES_PER_RUN
			);
			if (due.length === 0) return { ...EMPTY };

			const cveIds = [
				...new Set(
					due.flatMap((entry) =>
						entry.cveIds.map((cve) => cve.toUpperCase())
					)
				),
			].sort();

			let errors = 0;

			// KEV is one small document covering every CVE, so it is fetched
			// whole rather than queried per advisory.
			let kev = new Map<string, KevEntry>();
			let kevOk = true;
			try {
				kev = parseKevCatalogue(await fetchJson(deps.kevFeedUrl));
			} catch (error) {
				kevOk = false;
				errors += 1;
				deps.log?.warn('threat-intel: KEV fetch failed', {
					error: messageOf(error),
				});
			}

			const epss = new Map<string, EpssEntry>();
			const batches = chunk(cveIds, EPSS_CHUNK);
			let epssFailures = 0;
			for (const batch of batches) {
				const url = `${deps.epssApiUrl}?cve=${batch.join(',')}&limit=${EPSS_CHUNK}`;
				try {
					for (const [cve, entry] of parseEpssPage(
						await fetchJson(url)
					)) {
						epss.set(cve, entry);
					}
				} catch (error) {
					epssFailures += 1;
					errors += 1;
					deps.log?.warn('threat-intel: EPSS fetch failed', {
						cves: batch.length,
						error: messageOf(error),
					});
				}
			}

			// A partially-fetched EPSS run is as dangerous as a failed one: the
			// CVEs in the missing batches would look "not scored" and have real
			// scores erased. All-or-nothing per feed.
			const epssOk = epssFailures === 0;

			if (!kevOk && !epssOk) {
				return { ...EMPTY, examined: due.length, errors };
			}

			let epssScored = 0;
			let kevListed = 0;

			const rows = due.map((entry) => {
				const cves = entry.cveIds.map((cve) => cve.toUpperCase());

				// One advisory can alias several CVEs (a GHSA covering a
				// cluster). Take the worst of each signal: the highest EPSS,
				// and the earliest KEV listing.
				let best: EpssEntry | null = null;
				let kevHit: KevEntry | null = null;
				for (const cve of cves) {
					const scored = epss.get(cve);
					if (scored !== undefined && (best === null || scored.score > best.score)) {
						best = scored;
					}
					const listed = kev.get(cve);
					if (
						listed !== undefined &&
						(kevHit === null ||
							listed.addedAt.getTime() < kevHit.addedAt.getTime())
					) {
						kevHit = listed;
					}
				}

				if (best !== null) epssScored += 1;
				if (kevHit !== null) kevListed += 1;

				return {
					advisoryId: entry.advisoryId,
					epssScore: best?.score ?? null,
					epssPercentile: best?.percentile ?? null,
					kevAddedAt: kevHit?.addedAt ?? null,
					kevKnownRansomware: kevHit?.knownRansomware ?? null,
				};
			});

			const updated = await deps.advisories.applyThreatIntel(rows, now, {
				writeEpss: epssOk,
				writeKev: kevOk,
			});

			return {
				examined: due.length,
				epssScored,
				kevListed,
				updated,
				errors,
			};
		},
	};
}
