// Application de bureau (Electron) : `stage` assemble l'application, `start` la lance en développement,
// `dist [--win|--mac|--linux] [--dir]` produit l'installeur (Windows : NSIS, macOS : DMG + ZIP).
// Modules natifs N-API (better-sqlite3, argon2) : binaires précompilés de chaque plateforme, sans
// recompilation pour Electron. Windows se construit aussi depuis Linux ; macOS seulement depuis
// macOS (DMG, signature, argon2 Intel compilé à l'installation) : voir .github/workflows/bureau.yml.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const desktop = join(root, 'apps', 'desktop');
const stage = join(desktop, 'dist', 'app');
const win = process.platform === 'win32';
const bin = (dir, name) => join(dir, 'node_modules', '.bin', win ? `${name}.cmd` : name);
const [command = 'stage', ...rest] = process.argv.slice(2);

// Caches dans le projet (aucun dossier personnel), sauf si la CI les fixe déjà.
const tmp = join(root, '.tmp');
for (const [k, v] of Object.entries({
  ELECTRON_CACHE: join(tmp, 'electron-cache'),
  electron_config_cache: join(tmp, 'electron-cache'),
  ELECTRON_BUILDER_CACHE: join(tmp, 'electron-builder-cache'),
  npm_config_cache: join(tmp, 'npm-cache'),
}))
  process.env[k] ??= v;

// Outils extraits dans le cache local (icônes…) : scripts CommonJS, alors que le projet est en ESM.
mkdirSync(process.env.ELECTRON_BUILDER_CACHE, { recursive: true });
writeFileSync(join(process.env.ELECTRON_BUILDER_CACHE, 'package.json'), '{ "type": "commonjs" }\n');

const run = (file, args, cwd = root) => execFileSync(file, args, { cwd, stdio: 'inherit', shell: win });

async function assemble() {
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  run(bin(root, 'vite'), ['build', '--logLevel', 'warn'], join(root, 'apps', 'web'));

  await build({
    absWorkingDir: root,
    entryPoints: ['apps/desktop/src/main.ts'],
    outfile: join(stage, 'main.mjs'),
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    external: ['electron', 'better-sqlite3', 'argon2'],
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

  // Ressources lues par le serveur (APP_ROOT) : interface, règles, thème, icônes, fixtures, politiques IAM.
  // Le pack d'icônes AWS téléchargé (licence AWS) n'est pas redistribué : icônes génériques seulement.
  const res = join(stage, 'carto');
  cpSync(join(root, 'apps', 'web', 'dist'), join(res, 'apps', 'web', 'dist'), { recursive: true });
  cpSync(join(root, 'config'), join(res, 'config'), {
    recursive: true,
    filter: (src) => !src.includes(join('icons', 'aws')),
  });
  cpSync(join(root, 'fixtures'), join(res, 'fixtures'), { recursive: true });
  cpSync(join(root, 'docs', 'iam'), join(res, 'docs', 'iam'), { recursive: true });

  const own = JSON.parse(readFileSync(join(desktop, 'package.json'), 'utf8'));
  const runtime = JSON.parse(readFileSync(join(root, 'deploy', 'runtime', 'package.json'), 'utf8'));
  const manifest = {
    name: 'cartographe-aws',
    productName: 'Cartographe AWS',
    version: own.version,
    description: 'Cartographie en lecture seule de vos comptes AWS',
    author: 'Cartographe AWS',
    main: 'main.mjs',
    type: 'module',
    dependencies: runtime.dependencies,
    // npm ≥ 11 : scripts d'installation bloqués par défaut ; argon2 compile seulement sans binaire précompilé.
    allowScripts: { argon2: true },
  };
  writeFileSync(join(stage, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  // Modules natifs : binaires précompilés ; argon2 n'est compilé que s'il n'en existe pas (macOS Intel).
  run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--no-package-lock'], stage);
}

const HOSTS = { win32: '--win', darwin: '--mac', linux: '--linux' };

if (command === 'stage') {
  await assemble();
} else if (command === 'start') {
  await assemble();
  run(bin(desktop, 'electron'), [stage, ...rest], desktop);
} else if (command === 'dist') {
  const host = HOSTS[process.platform];
  if (!host) throw new Error(`Plateforme non prise en charge : ${process.platform}`);
  const targets = rest.filter((a) => Object.values(HOSTS).includes(a));
  if (targets.includes('--mac') && host !== '--mac')
    throw new Error(
      'Le DMG macOS (et sa signature) se construit uniquement sur macOS : voir .github/workflows/bureau.yml',
    );
  if (!existsSync(join(desktop, 'build', 'icon.png')))
    throw new Error('apps/desktop/build/icon.png manquant');
  await assemble();
  // Depuis Linux, l'installeur NSIS exigerait Wine : version portable (ZIP) seulement.
  const crossWin = host !== '--win' && targets.includes('--win');
  const args = (targets.length ? rest : [host, ...rest]).flatMap((a) =>
    a === '--win' && crossWin ? [a, 'zip'] : [a],
  );
  // macOS sans certificat Developer ID : signature ad hoc (indispensable pour lancer une app arm64).
  const adHoc = host === '--mac' && !process.env.CSC_LINK ? ['-c.mac.identity=-'] : [];
  run(bin(desktop, 'electron-builder'), ['--config', 'electron-builder.yml', ...args, ...adHoc], desktop);
} else {
  throw new Error(`Commande inconnue : ${command} (stage | start | dist)`);
}
