// `pnpm dev` : serveur HTTPS local (certificat de développement) + interface reconstruite à chaque modification.
import { execFileSync, spawn } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dev = join(root, '.dev');
const cert = join(dev, 'dev-cert.pem');
const expired = () =>
  !existsSync(cert) || new Date(new X509Certificate(readFileSync(cert)).validTo) < new Date();
if (expired()) execFileSync('sh', [join(root, 'scripts', 'gen-dev-cert.sh'), dev], { stdio: 'inherit' });

const port = process.env.PORT ?? '8443';
const env = {
  ...process.env,
  NODE_ENV: 'development',
  PORT: port,
  HOST: process.env.HOST ?? '127.0.0.1',
  TLS_CERT_FILE: cert,
  TLS_KEY_FILE: join(dev, 'dev-key.pem'),
  MASTER_KEY_FILE: join(dev, 'master.key'),
  PUBLIC_ORIGIN: process.env.PUBLIC_ORIGIN ?? `https://localhost:${port}`,
  CONFIG_DIR: process.env.CONFIG_DIR ?? join(root, 'config'),
  DATA_DIR: process.env.DATA_DIR ?? join(root, '.data'),
  DEMO_MODE: process.env.DEMO_MODE ?? 'true',
  LOG_LEVEL: process.env.LOG_LEVEL ?? 'info',
};

const bin = (name) => join(root, 'node_modules', '.bin', name);
const children = [
  spawn(bin('vite'), ['build', '--watch', '--logLevel', 'warn'], {
    cwd: join(root, 'apps', 'web'),
    stdio: 'inherit',
    env,
  }),
  spawn(bin('tsx'), ['watch', join(root, 'apps', 'server', 'src', 'main.ts')], {
    cwd: root,
    stdio: 'inherit',
    env,
  }),
];
console.log(`CloudMap (développement) : ${env.PUBLIC_ORIGIN} — mode démo ${env.DEMO_MODE}`);
const stop = () => {
  for (const c of children) c.kill('SIGTERM');
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const c of children) c.on('exit', (code) => code && stop());
