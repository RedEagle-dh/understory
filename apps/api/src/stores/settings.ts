import { type Db, schema } from '@workspace/db';
import { eq } from 'drizzle-orm';

export interface AppSettingsView {
	setupCompleted: boolean;
	defaultScanIntervalMinutes: number;
	retentionScansPerProject: number;
	retentionDeliveryDays: number;
	hasGithubDefaultToken: boolean;
}

export interface AppSettingsUpdate {
	defaultScanIntervalMinutes?: number;
	retentionScansPerProject?: number;
	retentionDeliveryDays?: number;
}

export interface SettingsStore {
	get(): Promise<AppSettingsView>;
	update(patch: AppSettingsUpdate): Promise<AppSettingsView>;
	setGithubDefaultTokenEnc(sealed: string | null): Promise<void>;
	getGithubDefaultTokenEnc(): Promise<string | null>;
}

export function createSettingsStore(db: Db): SettingsStore {
	const load = async () => {
		const row = await db.query.appSettings.findFirst({
			where: eq(schema.appSettings.id, 1),
		});
		if (row === undefined) {
			throw new Error(
				'app_settings singleton missing — migrations not run?'
			);
		}
		return row;
	};

	const toView = (
		row: Awaited<ReturnType<typeof load>>
	): AppSettingsView => ({
		setupCompleted: row.setupCompletedAt !== null,
		defaultScanIntervalMinutes: row.defaultScanIntervalMinutes,
		retentionScansPerProject: row.retentionScansPerProject,
		retentionDeliveryDays: row.retentionDeliveryDays,
		hasGithubDefaultToken: row.githubDefaultTokenEnc !== null,
	});

	return {
		async get() {
			return toView(await load());
		},
		async update(patch) {
			await db
				.update(schema.appSettings)
				.set({ ...patch, updatedAt: new Date() })
				.where(eq(schema.appSettings.id, 1));
			return toView(await load());
		},
		async setGithubDefaultTokenEnc(sealed) {
			await db
				.update(schema.appSettings)
				.set({ githubDefaultTokenEnc: sealed, updatedAt: new Date() })
				.where(eq(schema.appSettings.id, 1));
		},
		async getGithubDefaultTokenEnc() {
			return (await load()).githubDefaultTokenEnc;
		},
	};
}
