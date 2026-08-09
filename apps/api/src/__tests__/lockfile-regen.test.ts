import { describe, expect, test } from 'bun:test';
import { regenerateLockfile } from '../services/lockfile-regen';

const ROOT_MANIFEST = {
	path: 'package.json',
	content: '{"name":"app","dependencies":{"lodash":"^4.17.21"}}',
};

const BERRY_LOCK = {
	path: 'yarn.lock',
	content: '__metadata:\n  version: 6\n',
};

const V1_LOCK = {
	path: 'yarn.lock',
	content: '# yarn lockfile v1\n\n\nlodash@^4.17.21:\n  version "4.17.21"\n',
};

/** Fails the test if the regen path ever reaches a subprocess. */
const forbiddenSpawn = (() => {
	throw new Error('regenerateLockfile should not have spawned a process');
}) as unknown as typeof Bun.spawn;

describe('regenerateLockfile — yarn gating', () => {
	test('refuses a yarn 1 lockfile without spawning anything', async () => {
		const result = await regenerateLockfile({
			manager: 'yarn',
			manifests: [ROOT_MANIFEST],
			lockfile: V1_LOCK,
			spawn: forbiddenSpawn,
		});
		expect(result.ok).toBe(false);
		expect(result.ok === false && result.reason).toContain(
			'no lockfile-only install mode'
		);
	});

	test('refuses locked-version bumps for berry, which would rewrite package.json', async () => {
		const result = await regenerateLockfile({
			manager: 'yarn',
			manifests: [ROOT_MANIFEST],
			lockfile: BERRY_LOCK,
			updateTargets: ['lodash'],
			spawn: forbiddenSpawn,
		});
		expect(result.ok).toBe(false);
		expect(result.ok === false && result.reason).toContain(
			'without also rewriting package.json'
		);
	});
});

describe('regenerateLockfile — manager support', () => {
	test('pip has no lockfile to regenerate', async () => {
		const result = await regenerateLockfile({
			manager: 'pip',
			manifests: [ROOT_MANIFEST],
			lockfile: { path: 'requirements.txt', content: 'lodash==1' },
			spawn: forbiddenSpawn,
		});
		expect(result.ok).toBe(false);
		expect(result.ok === false && result.reason).toContain('not supported');
	});

	test('pnpm passes the gating checks', async () => {
		const commands: string[][] = [];
		const spawn = ((options: { cmd: string[] }) => {
			commands.push(options.cmd);
			return {
				exited: Promise.resolve(0),
				stderr: new Response('').body,
				kill: () => {},
			};
		}) as unknown as typeof Bun.spawn;

		const result = await regenerateLockfile({
			manager: 'pnpm',
			manifests: [ROOT_MANIFEST],
			lockfile: {
				path: 'pnpm-lock.yaml',
				content: "lockfileVersion: '9.0'\n",
			},
			spawn,
		});

		// The sandbox writes no new lockfile, and the dev machine running this
		// suite may not have pnpm on PATH at all — so this asserts only what is
		// environment-independent: pnpm is never turned away as an unsupported
		// manager the way yarn 1 is.
		expect(result.ok).toBe(false);
		const reason = result.ok === false ? result.reason : '';
		expect(reason).not.toContain('not supported');
		expect(reason).not.toContain('lockfile-only install mode');
		if (Bun.which('pnpm') !== null) {
			expect(commands.at(-1)).toContain('--lockfile-only');
		}
	});
});
