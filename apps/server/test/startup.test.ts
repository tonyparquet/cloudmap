import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { loadConfig, StartupError } from '../src/config.ts';
import { createLogger } from '../src/logger.ts';
import { makeExpiredCert, ROOT, testEnv } from './helpers.ts';

const problems = (env: NodeJS.ProcessEnv): string => {
  try {
    loadConfig(env);
  } catch (err) {
    if (err instanceof StartupError) return err.message;
    throw err;
  }
  return '';
};

describe('contrôles de démarrage (section 4.1)', () => {
  it.each(['TLS_CERT_FILE', 'TLS_KEY_FILE', 'MASTER_KEY_FILE', 'PUBLIC_ORIGIN'])(
    'refuse de démarrer sans %s',
    (name) => {
      const { env } = testEnv();
      env[name] = '';
      const msg = problems(env);
      expect(msg).toMatch(/Démarrage refusé/);
      expect(msg).toContain(`${name} est obligatoire`);
    },
  );

  it('refuse PUBLIC_ORIGIN en http', () => {
    const { env } = testEnv({ PUBLIC_ORIGIN: 'http://carto.exemple.fr' });
    expect(problems(env)).toMatch(/PUBLIC_ORIGIN doit commencer par https/);
  });

  it('refuse un certificat expiré', async () => {
    const { env, dir } = testEnv();
    const expired = await makeExpiredCert(dir);
    expect(problems({ ...env, TLS_CERT_FILE: expired.cert, TLS_KEY_FILE: expired.key })).toMatch(
      /Certificat TLS expiré/,
    );
  });

  it('refuse une clé TLS qui ne correspond pas au certificat', () => {
    const { env } = testEnv();
    const other = testEnv();
    expect(problems({ ...env, TLS_KEY_FILE: other.env.TLS_KEY_FILE })).toMatch(
      /ne correspond pas au certificat/,
    );
  });

  it('clé maître fournie en mémoire (application de bureau) : remplace MASTER_KEY_FILE, 32 octets exigés', () => {
    const { env } = testEnv({ MASTER_KEY_FILE: '' });
    const key = randomBytes(32);
    expect(loadConfig(env, { masterKey: key }).masterKey.equals(key)).toBe(true);
    expect(() => loadConfig(env, { masterKey: randomBytes(16) })).toThrow(/32 octets attendus/);
    // Les autres contrôles restent bloquants.
    expect(() => loadConfig({ ...env, PUBLIC_ORIGIN: 'http://127.0.0.1:1' }, { masterKey: key })).toThrow(
      /https/,
    );
  });

  it('refuse une clé maître invalide ou différente de celle des données existantes', async () => {
    const { env, dir } = testEnv();
    const bad = join(dir, 'bad.key');
    writeFileSync(bad, randomBytes(16).toString('base64'));
    expect(problems({ ...env, MASTER_KEY_FILE: bad })).toMatch(/32 octets/);

    const logger = createLogger('silent');
    const first = await buildApp(loadConfig(env), { logger });
    await first.app.close();
    const other = join(dir, 'other.key');
    writeFileSync(other, randomBytes(32).toString('base64'));
    await expect(buildApp(loadConfig({ ...env, MASTER_KEY_FILE: other }), { logger })).rejects.toThrow(
      /ne correspond pas aux données chiffrées/,
    );
  });

  it('aucune variable ne désactive TLS, l’authentification ou le MFA', () => {
    const { env } = testEnv({ DISABLE_TLS: 'true', AUTH_MODE: 'none', MFA: 'false' });
    expect(problems(env)).toMatch(/AUTH_MODE doit valoir/);
  });

  it('le processus serveur s’arrête avec un message explicite', () => {
    const { env } = testEnv();
    let stderr = '';
    let code = 0;
    try {
      execFileSync(join(ROOT, 'node_modules', '.bin', 'tsx'), [join(ROOT, 'apps/server/src/main.ts')], {
        env: { ...process.env, ...env, MASTER_KEY_FILE: '' },
        stdio: 'pipe',
        timeout: 60_000,
      });
    } catch (err) {
      const e = err as { status: number; stderr: Buffer };
      code = e.status;
      stderr = e.stderr.toString();
    }
    expect(code).toBe(1);
    expect(stderr).toContain('Démarrage refusé');
    expect(stderr).toContain('MASTER_KEY_FILE est obligatoire');
  });
});
