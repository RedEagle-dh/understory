#!/usr/bin/env bun
import { basename, join } from 'node:path';
import type { FrameworkConfig } from '@declarativejs/core/config';
import { serializeConfig } from './config';
import { generateManifestSource } from './gen';

interface Flags {
	readonly name?: string;
	readonly observability: boolean;
}

function parseFlags(rest: readonly string[]): Flags {
	let name: string | undefined;
	let observability = true;
	for (let i = 0; i < rest.length; i += 1) {
		const token = rest[i];
		if (token === '--no-observability') observability = false;
		else if (token === '--name') {
			i += 1;
			name = rest[i];
		}
	}
	return { name, observability };
}

function packageJson(name: string, observability: boolean): string {
	const dependencies: Record<string, string> = {
		'@declarativejs/core': 'workspace:*',
		elysia: 'catalog:',
	};
	if (observability) {
		dependencies['@declarativejs/module-observability'] = 'workspace:*';
	}
	const pkg = {
		name,
		version: '0.0.0',
		private: true,
		type: 'module',
		scripts: {
			typecheck: 'tsc --noEmit',
			start: 'bun run src/index.ts',
			gen: 'dcl gen',
			'gen:check': 'dcl gen --check',
		},
		dependencies: Object.fromEntries(
			Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b))
		),
		devDependencies: {
			'@declarativejs/cli': 'workspace:*',
			'@types/bun': 'catalog:',
			typescript: 'catalog:',
		},
	};
	return `${JSON.stringify(pkg, null, '\t')}\n`;
}

const TSCONFIG = `${JSON.stringify(
	{
		compilerOptions: {
			target: 'ES2022',
			module: 'ESNext',
			moduleResolution: 'bundler',
			lib: ['ES2022'],
			strict: true,
			esModuleInterop: true,
			skipLibCheck: true,
			forceConsistentCasingInFileNames: true,
			noEmit: true,
			types: ['bun'],
		},
		include: ['src/**/*', 'framework.config.ts'],
		exclude: ['node_modules'],
	},
	null,
	'\t'
)}\n`;

const ENV_TS = `/** Central env access — the single place \`process.env\` is read. */
export const env = {
	PORT: Number(process.env.PORT ?? '3000'),
	HOST: process.env.HOST ?? '127.0.0.1',
	NODE_ENV: process.env.NODE_ENV ?? 'development',
	TRUST_PROXY: process.env.TRUST_PROXY === 'true',
};
`;

const ENVIRONMENT_TS = `import {
	createRouteFactory,
	type FactoryDeps,
	pipeline,
	type RequestContext,
} from '@declarativejs/core';
import {
	type AppEnvironment,
	assembleDeps,
	consoleLogger,
	type EnvironmentInput,
} from '@declarativejs/core/app';

// The public surface's route factory. The pipeline is empty (no auth) — add
// stages with .use(...) and every route gains their Decl requirements.
function makePublicRoute(deps: FactoryDeps) {
	return createRouteFactory({
		surface: 'public',
		pipeline: pipeline<RequestContext>(),
		deps,
	});
}

type PublicRoute = ReturnType<typeof makePublicRoute>;

export interface AppEnv extends AppEnvironment {
	readonly surfaces: { readonly public: PublicRoute };
}

export function createEnvironment(input: EnvironmentInput): AppEnv {
	const deps = assembleDeps({ log: consoleLogger, telemetry: input.telemetry });
	return { deps, surfaces: { public: makePublicRoute(deps) } };
}
`;

const HELLO_TS = `import { t } from '@declarativejs/core';
import { defineModule } from '@declarativejs/core/app';
import type { AppEnv } from '../environment';

export function helloModule() {
	return defineModule({
		id: 'hello',
		build: (env: AppEnv) => {
			const hello = env.surfaces.public({
				id: 'hello',
				method: 'GET',
				path: '/hello',
				params: t.Object({}),
				query: t.Object({ name: t.String({ default: 'world' }) }),
				body: t.Undefined(),
				response: t.Object({ message: t.String() }),
				handler: async (ctx) => ({ message: 'hello, ' + ctx.query.name }),
			});
			return { routes: [hello] as const };
		},
	});
}
`;

function indexTs(name: string): string {
	return `import { createApp } from '@declarativejs/core/app';
import { Elysia } from 'elysia';
import { env } from './env';
import { manifest } from './generated/manifest';

const app = new Elysia()
	.get('/health', () => ({ status: 'ok' }))
	.use(createApp(manifest, { trustProxy: env.TRUST_PROXY }))
	.listen({ port: env.PORT, hostname: env.HOST });

process.stdout.write(
	'${name} listening on http://' + env.HOST + ':' + env.PORT + '\\n'
);

export type { AppEden } from './generated/manifest';
export type App = typeof app;
`;
}

async function write(dir: string, rel: string, content: string): Promise<void> {
	await Bun.write(join(dir, rel), content);
}

async function main(): Promise<void> {
	const [dir, ...rest] = process.argv.slice(2);
	if (dir === undefined) {
		process.stderr.write(
			'usage: create-declarative <dir> [--name <pkg>] [--no-observability]\n'
		);
		process.exit(1);
	}
	const flags = parseFlags(rest);
	const name = flags.name ?? basename(dir);

	const config: FrameworkConfig = {
		environment: './src/environment.ts',
		modules: {
			hello: { package: './src/modules/hello', export: 'helloModule' },
		},
		...(flags.observability
			? {
					telemetry: {
						observability: {
							enabled: true,
							package: '@declarativejs/module-observability',
							export: 'observabilityModule',
							options: { serviceName: name },
						},
					},
				}
			: {}),
	};

	await write(dir, 'package.json', packageJson(name, flags.observability));
	await write(dir, 'tsconfig.json', TSCONFIG);
	await write(dir, '.gitignore', 'node_modules\n*.tsbuildinfo\n');
	await write(dir, 'framework.config.ts', serializeConfig(config));
	await write(dir, 'src/env.ts', ENV_TS);
	await write(dir, 'src/environment.ts', ENVIRONMENT_TS);
	await write(dir, 'src/modules/hello.ts', HELLO_TS);
	await write(dir, 'src/index.ts', indexTs(name));
	await write(dir, 'src/generated/manifest.ts', generateManifestSource(config, dir));

	process.stdout.write(
		`scaffolded '${name}' in ${dir}\n\nnext:\n  cd ${dir}\n  bun install\n  bun run start\n`
	);
}

await main();
