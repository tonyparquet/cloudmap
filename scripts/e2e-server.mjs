// Serveur des tests E2E : interface construite, données vierges, mode démo, HTTPS (certificat de dev).
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const port = process.argv[2] ?? '8444';
const dev = join(root, '.dev');
const data = join(root, '.tmp', 'e2e-data');
if (!existsSync(join(dev, 'dev-cert.pem')))
  execFileSync('sh', [join(root, 'scripts', 'gen-dev-cert.sh'), dev], { stdio: 'inherit' });
rmSync(data, { recursive: true, force: true });
// Configuration copiée sans recherche de mise à jour : aucun appel réseau sortant pendant les tests.
const config = join(root, '.tmp', 'e2e-config');
rmSync(config, { recursive: true, force: true });
cpSync(join(root, 'config'), config, { recursive: true });
writeFileSync(
  join(config, 'app.yaml'),
  readFileSync(join(config, 'app.yaml'), 'utf8').replace(
    /updates:\n {2}enabled: true/,
    'updates:\n  enabled: false',
  ),
);
execFileSync(join(root, 'node_modules', '.bin', 'vite'), ['build', '--logLevel', 'warn'], {
  cwd: join(root, 'apps', 'web'),
  stdio: 'inherit',
});

const server = spawn(
  join(root, 'node_modules', '.bin', 'tsx'),
  [join(root, 'apps', 'server', 'src', 'main.ts')],
  {
    cwd: root,
    stdio: 'inherit',
    env: {
      ...process.env,
      PORT: port,
      HOST: '127.0.0.1',
      TLS_CERT_FILE: join(dev, 'dev-cert.pem'),
      TLS_KEY_FILE: join(dev, 'dev-key.pem'),
      MASTER_KEY_FILE: join(dev, 'master.key'),
      PUBLIC_ORIGIN: `https://localhost:${port}`,
      CONFIG_DIR: config,
      DATA_DIR: data,
      DEMO_MODE: 'true',
      LOG_LEVEL: 'warn',
    },
  },
);
const stop = () => server.kill('SIGTERM');
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
server.on('exit', (code) => process.exit(code ?? 0));
