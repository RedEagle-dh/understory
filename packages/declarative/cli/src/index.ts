#!/usr/bin/env bun
import { join, relative } from 'node:path';
import type {
	FrameworkConfig,
	ModuleConfigEntry,
	TelemetryConfigEntry,
} from '@declarativejs/core/config';
import { loadConfig, writeConfig } from './config';
import { generateManifestSource } from './gen';
import { editDependency } from './pkg';

const BOOLEAN_FLAGS = new Set(['telemetry', 'disabled', 'check']);

interface ParsedArgs {
	readonly positionals: readonly string[];
	readonly strings: ReadonlyMap<string, string>;
	readonly flags: ReadonlySet<string>;
	readonly options: Record<string, unknown>;
}

function parseScalar(value: string): unknown {
	if (value === 'true') return true;
	if (value === 'false') return false;
	if (/^-?\d+$/.test(value)) return Number(value);
	return value;
}

function parseArgs(rest: readonly string[]): ParsedArgs {
	const positionals: string[] = [];
	const strings = new Map<string, string>();
	const flags = new Set<string>();
	const options: Record<string, unknown> = {};
	for (let i = 0; i < rest.length; i += 1) {
		const token = rest[i];
		if (token === undefined) continue;
		if (!token.startsWith('--')) {
			positionals.push(token);
			continue;
		}
		const name = token.slice(2);
		if (BOOLEAN_FLAGS.has(name)) {
			flags.add(name);
			continue;
		}
		i += 1;
		const value = rest[i];
		if (value === undefined) throw new Error(`missing value for --${name}`);
		if (name === 'option') {
			const eq = value.indexOf('=');
			if (eq === -1) {
				throw new Error(`--option expects key=value, got '${value}'`);
			}
			options[value.slice(0, eq)] = parseScalar(value.slice(eq + 1));
		} else {
			strings.set(name, value);
		}
	}
	return { positionals, strings, flags, options };
}

async function runGen(
	projectRoot: string,
	check: boolean,
	// Pass the in-memory config after a mutation: Bun caches dynamic imports by
	// path, so re-loading framework.config.ts in the same process returns the
	// stale pre-write copy. add/remove supply their mutated config here.
	preloaded?: FrameworkConfig
): Promise<void> {
	const config = preloaded ?? (await loadConfig(projectRoot));
	const source = generateManifestSource(config, projectRoot);
	const target = join(projectRoot, 'src', 'generated', 'manifest.ts');
	if (check) {
		const existing = await Bun.file(target)
			.text()
			.catch(() => '');
		if (existing !== source) {
			process.stderr.write(
				'manifest out of sync with framework.config.ts — run `dcl gen`\n'
			);
			process.exit(1);
		}
		process.stdout.write('manifest in sync\n');
		return;
	}
	await Bun.write(target, source);
	process.stdout.write(`generated ${relative(projectRoot, target)}\n`);
}

async function runAdd(projectRoot: string, rest: readonly string[]): Promise<void> {
	const args = parseArgs(rest);
	const name = args.positionals[0];
	const pkg = args.strings.get('package');
	if (name === undefined || pkg === undefined) {
		throw new Error(
			'usage: dcl add <name> --package <pkg> [--export <e>] [--telemetry] [--disabled] [--option k=v]'
		);
	}
	const exportName = args.strings.get('export');
	const options =
		Object.keys(args.options).length > 0 ? args.options : undefined;
	const config = await loadConfig(projectRoot);

	let next: FrameworkConfig;
	if (args.flags.has('telemetry')) {
		const entry: TelemetryConfigEntry = {
			enabled: !args.flags.has('disabled'),
			package: pkg,
			...(exportName !== undefined ? { export: exportName } : {}),
			...(options !== undefined ? { options } : {}),
		};
		next = {
			...config,
			telemetry: { ...config.telemetry, [name]: entry },
		};
	} else {
		const entry: ModuleConfigEntry = {
			package: pkg,
			...(exportName !== undefined ? { export: exportName } : {}),
			...(options !== undefined ? { options } : {}),
		};
		next = { ...config, modules: { ...config.modules, [name]: entry } };
	}

	await writeConfig(projectRoot, next);
	await editDependency(projectRoot, 'add', pkg);
	await runGen(projectRoot, false, next);
	process.stdout.write(
		`added ${args.flags.has('telemetry') ? 'telemetry provider' : 'module'} '${name}' (${pkg})\n`
	);
}

async function runRemove(
	projectRoot: string,
	rest: readonly string[]
): Promise<void> {
	const args = parseArgs(rest);
	const name = args.positionals[0];
	if (name === undefined) throw new Error('usage: dcl remove <name>');
	const config = await loadConfig(projectRoot);

	let next: FrameworkConfig;
	let removedPackage: string;
	const moduleEntry = config.modules[name];
	const telemetryEntry = config.telemetry?.[name];
	if (moduleEntry !== undefined) {
		removedPackage = moduleEntry.package;
		const modules = { ...config.modules };
		delete modules[name];
		next = { ...config, modules };
	} else if (telemetryEntry !== undefined) {
		removedPackage = telemetryEntry.package;
		const telemetry = { ...config.telemetry };
		delete telemetry[name];
		next = { ...config, telemetry };
	} else {
		throw new Error(`no module or telemetry provider named '${name}'`);
	}

	await writeConfig(projectRoot, next);
	await editDependency(projectRoot, 'remove', removedPackage);
	await runGen(projectRoot, false, next);
	process.stdout.write(`removed '${name}' (${removedPackage})\n`);
}

async function main(): Promise<void> {
	const [command, ...rest] = process.argv.slice(2);
	const projectRoot = process.cwd();

	switch (command) {
		case 'gen':
			await runGen(projectRoot, rest.includes('--check'));
			break;
		case 'add':
			await runAdd(projectRoot, rest);
			break;
		case 'remove':
			await runRemove(projectRoot, rest);
			break;
		default:
			process.stderr.write(
				`unknown command: ${command ?? '(none)'}\n\n` +
					'usage:\n' +
					'  dcl gen [--check]\n' +
					'  dcl add <name> --package <pkg> [--export <e>] [--telemetry] [--disabled] [--option k=v]\n' +
					'  dcl remove <name>\n'
			);
			process.exit(1);
	}
}

await main();
