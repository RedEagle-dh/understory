import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { PackageManager } from '@workspace/audit-engine';

/**
 * Regenerating the lockfile is what keeps an opened PR green in the target
 * repo's CI: a `package.json` edit without a matching `package-lock.json`
 * makes `npm ci` fail on arrival, so every PR the tool opens would be red.
 *
 * Failure is never fatal — the caller falls back to a manifest-only PR and
 * says so in the body. That contract is why every exit here is a value, not a
 * throw.
 *
 * The sandbox materialises EVERY manifest the repo snapshot holds (root plus
 * every workspace package.json) at its repository-relative path, so a
 * workspaces monorepo resolves exactly the way it does in the real checkout.
 * That is what makes `catalog:` ranges — which only the root manifest can
 * answer — regenerate correctly.
 */

export interface LockfileRegenFile {
	path: string;
	content: string;
}

export interface LockfileRegenInput {
	manager: PackageManager;
	/**
	 * Every manifest of the manager's ecosystem (package.json / pyproject.toml)
	 * in the repository, already carrying the PR's edits, at
	 * repository-relative paths. The shallowest one is the install root.
	 */
	manifests: readonly LockfileRegenFile[];
	lockfile: LockfileRegenFile;
	/**
	 * Packages whose LOCKED version must move even though no manifest range
	 * changed (the `lockfileOnly` bumps). Empty means "just refresh the
	 * lockfile against the edited manifests".
	 */
	updateTargets?: readonly string[];
	/** Test seam: overrides the spawner. */
	spawn?: typeof Bun.spawn;
	timeoutMs?: number;
}

export type LockfileRegenResult =
	| { ok: true; content: string }
	| { ok: false; reason: string };

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * `install` refreshes the lockfile against changed manifests but deliberately
 * KEEPS every already-locked version that still satisfies its range, so it can
 * never realise an in-range bump. `update <name...>` (or uv's
 * `--upgrade-package`) is the only command in each manager that forces one.
 */
const INSTALL_COMMANDS: Partial<Record<PackageManager, string[]>> = {
	npm: [
		'npm',
		'install',
		'--package-lock-only',
		'--ignore-scripts',
		'--no-audit',
		'--no-fund',
		'--loglevel=error',
	],
	bun: ['bun', 'install', '--lockfile-only', '--ignore-scripts'],
	uv: ['uv', 'lock'],
	poetry: ['poetry', 'lock'],
};

const UPDATE_COMMANDS: Partial<Record<PackageManager, string[]>> = {
	npm: [
		'npm',
		'update',
		'--package-lock-only',
		'--ignore-scripts',
		'--no-audit',
		'--no-fund',
		'--loglevel=error',
	],
	bun: ['bun', 'update', '--lockfile-only', '--ignore-scripts'],
	uv: ['uv', 'lock'],
	poetry: ['poetry', 'update', '--lock'],
};

/** How a manager wants its update targets spelled on the command line. */
const TARGET_ARGS: Partial<
	Record<PackageManager, (names: readonly string[]) => string[]>
> = {
	uv: (names) => names.flatMap((name) => ['--upgrade-package', name]),
};

/** The manifest file a manager's resolver reads. */
const MANIFEST_BASENAMES: Partial<Record<PackageManager, string>> = {
	npm: 'package.json',
	bun: 'package.json',
	uv: 'pyproject.toml',
	poetry: 'pyproject.toml',
};

/** `a/b/c` → rejects anything that could escape the sandbox. */
function isSafeRelativePath(path: string): boolean {
	if (path === '' || path.startsWith('/') || path.includes('\\'))
		return false;
	return !path
		.split('/')
		.some((segment) => segment === '..' || segment === '');
}

function pathDepth(path: string): number {
	return path.split('/').length;
}

/** The shallowest, lexicographically-first manifest — the install root. */
function findRoot(
	manifests: readonly LockfileRegenFile[],
	basename: string
): LockfileRegenFile | undefined {
	let best: LockfileRegenFile | undefined;
	for (const manifest of manifests) {
		if ((manifest.path.split('/').at(-1) ?? '') !== basename) continue;
		if (
			best === undefined ||
			pathDepth(manifest.path) < pathDepth(best.path) ||
			(pathDepth(manifest.path) === pathDepth(best.path) &&
				manifest.path < best.path)
		) {
			best = manifest;
		}
	}
	return best;
}

async function writeAll(
	directory: string,
	files: readonly LockfileRegenFile[]
): Promise<void> {
	for (const file of files) {
		const absolute = join(directory, file.path);
		await mkdir(dirname(absolute), { recursive: true });
		await writeFile(absolute, file.content, 'utf8');
	}
}

interface RunOutcome {
	ok: boolean;
	reason?: string;
}

export async function regenerateLockfile(
	input: LockfileRegenInput
): Promise<LockfileRegenResult> {
	const installCommand = INSTALL_COMMANDS[input.manager];
	const updateCommand = UPDATE_COMMANDS[input.manager];
	const manifestBasename = MANIFEST_BASENAMES[input.manager];
	if (
		installCommand === undefined ||
		updateCommand === undefined ||
		manifestBasename === undefined
	) {
		return {
			ok: false,
			reason: `lockfile regeneration is not supported for ${input.manager}`,
		};
	}

	const manifests = input.manifests.filter(
		(manifest) =>
			(manifest.path.split('/').at(-1) ?? '') === manifestBasename
	);
	const root = findRoot(manifests, manifestBasename);
	if (root === undefined) {
		return {
			ok: false,
			reason: `no root ${manifestBasename} in the change set`,
		};
	}

	const materialised = [...manifests, input.lockfile];
	const unsafe = materialised.find((file) => !isSafeRelativePath(file.path));
	if (unsafe !== undefined) {
		return {
			ok: false,
			reason: `refusing to materialise the unexpected path ${unsafe.path}`,
		};
	}

	const executable = Bun.which(installCommand[0] as string);
	if (executable === null) {
		return {
			ok: false,
			reason: `${installCommand[0]} is not available in this container`,
		};
	}

	const targets = [...new Set(input.updateTargets ?? [])].filter(
		(name) => name !== ''
	);
	const rootDirectory = dirname(root.path) === '.' ? '' : dirname(root.path);

	const directory = await mkdtemp(join(tmpdir(), 'understory-lock-'));
	const deadline = Date.now() + (input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	try {
		await writeAll(directory, materialised);

		// Scrubbed env: nothing from the server process leaks into a child that
		// resolves third-party metadata. `--ignore-scripts` covers the rest.
		const environment: Record<string, string> = {
			PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
			HOME: directory,
			NPM_CONFIG_CACHE: join(directory, '.npm-cache'),
			NPM_CONFIG_UPDATE_NOTIFIER: 'false',
			UV_CACHE_DIR: join(directory, '.uv-cache'),
			POETRY_CACHE_DIR: join(directory, '.poetry-cache'),
			...(process.env.npm_config_registry === undefined
				? {}
				: { npm_config_registry: process.env.npm_config_registry }),
		};

		const cwd =
			rootDirectory === '' ? directory : join(directory, rootDirectory);
		const spawn = input.spawn ?? Bun.spawn;

		async function run(command: readonly string[]): Promise<RunOutcome> {
			const remaining = deadline - Date.now();
			if (remaining <= 0) {
				return {
					ok: false,
					reason: `${command[0]} timed out after ${Math.round((input.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000)}s`,
				};
			}
			const child = spawn({
				cmd: [executable as string, ...command.slice(1)],
				cwd,
				env: environment,
				stdin: 'ignore',
				stdout: 'pipe',
				stderr: 'pipe',
			});

			let timedOut = false;
			const timer = setTimeout(() => {
				timedOut = true;
				child.kill(9);
			}, remaining);

			let exitCode: number;
			try {
				exitCode = await child.exited;
			} finally {
				clearTimeout(timer);
			}

			if (timedOut) {
				return {
					ok: false,
					reason: `${command[0]} timed out after ${Math.round((input.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000)}s`,
				};
			}
			if (exitCode !== 0) {
				const stderr = await new Response(
					child.stderr as ReadableStream
				)
					.text()
					.catch(() => '');
				return {
					ok: false,
					reason: `${command.slice(0, 2).join(' ')} exited with ${exitCode}: ${stderr.trim().slice(0, 200)}`,
				};
			}
			return { ok: true };
		}

		if (targets.length > 0) {
			const targetArgs = TARGET_ARGS[input.manager]?.(targets) ?? [
				...targets,
			];
			const updated = await run([...updateCommand, ...targetArgs]);
			if (!updated.ok) {
				return {
					ok: false,
					reason: updated.reason ?? 'the update command failed',
				};
			}
			// `bun update <name>` ADDS the name to the manifest it was invoked
			// from when that manifest does not already declare it — in a
			// workspaces repo that means a phantom root dependency, in the
			// lockfile as well as on disk. Our manifests are the source of
			// truth for the PR, so they are restored and the lockfile is
			// normalised against them; the already-updated resolutions survive
			// because `install` never walks a locked version backwards.
			await writeAll(directory, manifests);
		}

		const refreshed = await run(installCommand);
		if (!refreshed.ok) {
			return {
				ok: false,
				reason: refreshed.reason ?? 'the install command failed',
			};
		}

		const content = await readFile(
			join(directory, input.lockfile.path),
			'utf8'
		).catch(() => null);
		if (content === null) {
			return {
				ok: false,
				reason: `${input.lockfile.path} was not written by ${installCommand[0]}`,
			};
		}
		if (content === input.lockfile.content) {
			const pinnedHint =
				input.manager === 'uv' || input.manager === 'poetry'
					? 'the targets may already be at the highest versions their constraints allow — a requires-python floor can keep an older fork of a package locked'
					: 'targets may be pinned by catalog: or exact versions';
			return {
				ok: false,
				reason:
					targets.length > 0
						? `update produced no lockfile change (${pinnedHint})`
						: 'the lockfile did not change',
			};
		}
		return { ok: true, content };
	} catch (error) {
		return {
			ok: false,
			reason:
				error instanceof Error
					? error.message
					: `lockfile regeneration failed: ${String(error)}`,
		};
	} finally {
		await rm(directory, { recursive: true, force: true }).catch(() => {
			/* a leaked temp dir is not worth failing a PR over */
		});
	}
}
