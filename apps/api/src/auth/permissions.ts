import { createAccessControl } from 'better-auth/plugins/access';
import { adminAc, defaultStatements } from 'better-auth/plugins/admin/access';

/**
 * RBAC statements. Roles are global at v1:
 * - viewer      — read dashboards and reports
 * - maintainer  — manage projects, trigger scans, open PRs, configure notifications
 * - admin       — additionally manage users and global settings
 */
const statement = {
	...defaultStatements,
	project: ['read', 'create', 'update', 'delete', 'scan'],
	pr: ['create'],
	notification: ['read', 'manage'],
	settings: ['read', 'manage'],
} as const;

export const ac = createAccessControl(statement);

export const viewer = ac.newRole({
	project: ['read'],
	notification: ['read'],
});

export const maintainer = ac.newRole({
	project: ['read', 'create', 'update', 'delete', 'scan'],
	pr: ['create'],
	notification: ['read', 'manage'],
});

export const admin = ac.newRole({
	...adminAc.statements,
	project: ['read', 'create', 'update', 'delete', 'scan'],
	pr: ['create'],
	notification: ['read', 'manage'],
	settings: ['read', 'manage'],
});

export const roles = { viewer, maintainer, admin } as const;
export type Role = keyof typeof roles;

/** Per-route permission requirement, checked in-process by the auth stage. */
export type Permissions = {
	readonly [K in keyof typeof statement]?: readonly (typeof statement)[K][number][];
};

export function isKnownRole(role: string): role is Role {
	return role in roles;
}
