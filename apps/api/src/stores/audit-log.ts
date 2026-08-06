import { type Db, id, schema } from '@workspace/db';
import { desc } from 'drizzle-orm';

export interface AuditEntry {
	actorUserId?: string;
	action: string;
	targetType: string;
	targetId?: string;
	meta?: Record<string, unknown>;
	ip?: string;
}

export interface AuditLogStore {
	record(entry: AuditEntry): Promise<void>;
	list(
		limit: number,
		offset: number
	): Promise<(typeof schema.auditLog.$inferSelect)[]>;
}

export function createAuditLogStore(db: Db): AuditLogStore {
	return {
		async record(entry) {
			await db.insert(schema.auditLog).values({
				id: id(),
				actorUserId: entry.actorUserId ?? null,
				action: entry.action,
				targetType: entry.targetType,
				targetId: entry.targetId ?? null,
				metaJson:
					entry.meta === undefined
						? null
						: JSON.stringify(entry.meta),
				ip: entry.ip ?? null,
				createdAt: new Date(),
			});
		},
		async list(limit, offset) {
			return db
				.select()
				.from(schema.auditLog)
				.orderBy(desc(schema.auditLog.createdAt))
				.limit(limit)
				.offset(offset);
		},
	};
}
