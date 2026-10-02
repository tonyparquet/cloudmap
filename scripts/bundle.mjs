// Bundle esbuild d'une application Node (server | cli) : seules les dépendances natives restent externes.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const target = process.argv[2];
const entries = { server: 'apps/server/src/main.ts', cli: 'apps/cli/src/main.ts' };
if (!(target in entries)) throw new Error(`Cible inconnue : ${target}`);

const root = fileURLToPath(new URL('..', import.meta.url));
await build({
  absWorkingDir: root,
  entryPoints: [entries[target]],
  outfile: `apps/${target}/dist/main.mjs`,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  external: ['better-sqlite3', 'argon2'],
  banner: {
    js: [
      "import { createRequire as __cr } from 'node:module';",
      "import { fileURLToPath as __fu } from 'node:url';",
      "import { dirname as __dn } from 'node:path';",
      'const require = __cr(import.meta.url);',
      'const __filename = __fu(import.meta.url);',
      'const __dirname = __dn(__filename);',
    ].join('\n'),
  },
  logLevel: 'warning',
});
