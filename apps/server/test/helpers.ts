import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { generate } from 'otplib';
import { generate as generateCert } from 'selfsigned';
import { buildApp, type Ctx } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { createLogger } from '../src/logger.ts';

export const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const ORIGIN = 'https://cloudmap.test';
const TMP = join(ROOT, '.tmp', 'tests');
mkdirSync(TMP, { recursive: true });

/** Certificat auto-signé de test (EC P-256), éventuellement expiré. */
export function makeCert(dir: string): { cert: string; key: string } {
  const cert = join(dir, 'cert.pem');
  const key = join(dir, 'key.pem');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-keyout',
      key,
      '-out',
      cert,
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
      '-days',
      '2',
    ],
    { stdio: 'ignore' },
  );
  return { cert, key };
}

/**
 * Certificat expiré (2020), généré en Node : `openssl req -not_after` n'existe qu'à partir
 * d'OpenSSL 3.4 (absent des runners de CI Ubuntu).
 */
export async function makeExpiredCert(dir: string): Promise<{ cert: string; key: string }> {
  const pems = await generateCert([{ name: 'commonName', value: 'localhost' }], {
    keyType: 'ec',
    algorithm: 'sha256',
    notBeforeDate: new Date('2020-01-01T00:00:00Z'),
    notAfterDate: new Date('2020-01-02T00:00:00Z'),
  });
  const cert = join(dir, 'expired-cert.pem');
  const key = join(dir, 'expired-key.pem');
  writeFileSync(cert, pems.cert);
  writeFileSync(key, pems.private);
  return { cert, key };
}

export function testEnv(extra: NodeJS.ProcessEnv = {}): { env: NodeJS.ProcessEnv; dir: string } {
  const dir = mkdtempSync(join(TMP, 'srv-'));
  const { cert, key } = makeCert(dir);
  const masterKey = join(dir, 'master.key');
  writeFileSync(masterKey, randomBytes(32).toString('base64'));
  return {
    dir,
    env: {
      TLS_CERT_FILE: cert,
      TLS_KEY_FILE: key,
      MASTER_KEY_FILE: masterKey,
      PUBLIC_ORIGIN: ORIGIN,
      CONFIG_DIR: join(dir, 'config'),
      DATA_DIR: join(dir, 'data'),
      APP_ROOT: ROOT,
      WEB_DIST_DIR: join(dir, 'web-absent'),
      ...extra,
    },
  };
}

export async function startApp(
  extra: NodeJS.ProcessEnv = {},
  opts: { logToFile?: boolean; fetchImpl?: typeof fetch } = {},
) {
  const { env, dir } = testEnv(extra);
  const config = loadConfig(env);
  const logger = createLogger(
    opts.logToFile ? 'trace' : 'silent',
    opts.logToFile ? config.dataDir : undefined,
    { stdout: false },
  );
  // Aucun appel réseau sortant pendant les tests (flux de mises à jour) : fetch simulé par défaut.
  const fetchImpl =
    opts.fetchImpl ?? ((async () => new Response('{}', { status: 503 })) as unknown as typeof fetch);
  const { app, ctx } = await buildApp(config, { logger, fetchImpl });
  await app.ready();
  return { app, ctx, env, dir };
}

export interface Res {
  url: string;
  status: number;
  body: string;
  json: () => any; // eslint-disable-line @typescript-eslint/no-explicit-any -- corps JSON arbitraire des réponses de test
  headers: Record<string, string | string[] | number | undefined>;
}

/** Client de test : conserve le cookie de session et envoie Origin + jeton CSRF sur les requêtes non-GET. */
export class Client {
  cookie = '';
  csrf = '';
  responses: Res[] = [];

  constructor(private readonly app: FastifyInstance) {}

  async req(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
    const res = await this.app.inject({
      method: method as 'GET',
      url,
      headers: {
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(method !== 'GET' ? { origin: ORIGIN, 'x-csrf-token': this.csrf } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    });
    const setCookie = res.headers['set-cookie'];
    for (const c of Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : []) {
      const m = /^__Host-session=([^;]*)/.exec(c);
      if (m) this.cookie = m[1] ? `__Host-session=${m[1]}` : '';
    }
    const out: Res = {
      url,
      status: res.statusCode,
      body: res.body,
      json: () => JSON.parse(res.body),
      headers: res.headers,
    };
    if (res.headers['content-type']?.toString().includes('json')) {
      const j = JSON.parse(res.body) as { csrfToken?: string };
      if (j.csrfToken) this.csrf = j.csrfToken;
    }
    this.responses.push(out);
    return out;
  }
}

export const totp = (secret: string) => generate({ secret });

/** Autorise un nouveau code TOTP dans le même pas de temps (tests uniquement : l'anti-rejeu est testé à part). */
export function allowTotpReuse(ctx: Ctx, username: string): void {
  ctx.db.prepare('UPDATE users SET totp_last_step = 0 WHERE username = ?').run(username);
}

export const ADMIN = { username: 'admin', password: 'Une-phrase-de-passe-solide-42' };

/** Premier démarrage : création de l'administrateur, enrôlement TOTP, session complète. */
export async function setupAdmin(
  app: FastifyInstance,
): Promise<{ client: Client; secret: string; recoveryCodes: string[] }> {
  const client = new Client(app);
  await client.req('GET', '/api/auth/state');
  const setup = await client.req('POST', '/api/auth/setup', ADMIN);
  if (setup.status !== 200) throw new Error(`setup ${setup.status} ${setup.body}`);
  const enroll = (await client.req('GET', '/api/auth/totp/enroll')).json() as { secret: string };
  const done = await client.req('POST', '/api/auth/totp/enroll', { code: await totp(enroll.secret) });
  if (done.status !== 200) throw new Error(`enroll ${done.status} ${done.body}`);
  return {
    client,
    secret: enroll.secret,
    recoveryCodes: (done.json() as { recoveryCodes: string[] }).recoveryCodes,
  };
}

export async function reauth(
  client: Client,
  ctx: Ctx,
  secret: string,
  username = ADMIN.username,
  password = ADMIN.password,
) {
  allowTotpReuse(ctx, username);
  const r = await client.req('POST', '/api/auth/reauth', { password, code: await totp(secret) });
  if (r.status !== 200) throw new Error(`reauth ${r.status} ${r.body}`);
}

/** Crée un utilisateur local (par l'admin) puis le connecte avec enrôlement TOTP. */
export async function createAndLogin(
  app: FastifyInstance,
  ctx: Ctx,
  admin: Client,
  user: { username: string; password: string; role: 'admin' | 'editor' | 'viewer'; groups: string[] },
): Promise<{ client: Client; secret: string }> {
  const created = await admin.req('POST', '/api/admin/users', user);
  if (created.status !== 200) throw new Error(`création ${created.status} ${created.body}`);
  const client = new Client(app);
  await client.req('GET', '/api/auth/state');
  const login = await client.req('POST', '/api/auth/login', {
    username: user.username,
    password: user.password,
  });
  if (login.status !== 200) throw new Error(`login ${login.status} ${login.body}`);
  const enroll = (await client.req('GET', '/api/auth/totp/enroll')).json() as { secret: string };
  await client.req('POST', '/api/auth/totp/enroll', { code: await totp(enroll.secret) });
  return { client, secret: enroll.secret };
}
