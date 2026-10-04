import { generateKeyPairSync, verify } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  azureTokenFromPasted,
  checkReadOnly,
  CloudHttpError,
  GCP_READ_ONLY_SCOPE,
  gcpTokenFromServiceAccount,
  ReadOnlyHttp,
} from '../src/index.ts';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const fakeJwt = (claims: Record<string, unknown>) => `${b64({ alg: 'none' })}.${b64(claims)}.sig`;

describe('Azure et Google Cloud : client HTTP en lecture seule', () => {
  it('GET seulement, POST de requête explicitement autorisés, hôtes du fournisseur uniquement', () => {
    expect(() => checkReadOnly('azure', 'GET', 'https://management.azure.com/subscriptions/x')).not.toThrow();
    expect(() =>
      checkReadOnly(
        'azure',
        'POST',
        'https://management.azure.com/providers/Microsoft.ResourceGraph/resources',
      ),
    ).not.toThrow();
    expect(() =>
      checkReadOnly('azure', 'POST', 'https://management.azure.com/subscriptions/x/resourcegroups/rg/delete'),
    ).toThrow(/lecture seule/);
    expect(() => checkReadOnly('azure', 'GET', 'https://exemple.fr/subscriptions')).toThrow(
      /Hôte non autorisé/,
    );
    expect(() => checkReadOnly('azure', 'GET', 'http://management.azure.com/x')).toThrow(/Hôte non autorisé/);
    expect(() =>
      checkReadOnly(
        'gcp',
        'POST',
        'https://cloudresourcemanager.googleapis.com/v3/projects/p:testIamPermissions',
      ),
    ).not.toThrow();
    expect(() =>
      checkReadOnly('gcp', 'POST', 'https://compute.googleapis.com/compute/v1/projects/p/instances'),
    ).toThrow(/lecture seule/);
    expect(() => checkReadOnly('gcp', 'GET', 'https://metadata.google.internal/computeMetadata/v1/')).toThrow(
      /Hôte non autorisé/,
    );
  });

  it('nouvel essai sur limitation de débit, erreur typée et expurgée sinon', async () => {
    const calls: string[] = [];
    const replies = [json(429, {}, { 'retry-after': '0' }), json(200, { ok: true })];
    const http = new ReadOnlyHttp('gcp', 'jeton', (async (url: URL) => {
      calls.push(String(url));
      return replies.shift() ?? json(500, {});
    }) as typeof fetch);
    expect(await http.get('https://compute.googleapis.com/compute/v1/projects/p')).toEqual({ ok: true });
    expect(calls).toHaveLength(2);

    const denied = new ReadOnlyHttp('azure', 'jeton', (async () =>
      json(403, { error: { code: 'AuthorizationFailed', message: 'refusé' } })) as typeof fetch);
    const err = await denied.get('https://management.azure.com/subscriptions/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CloudHttpError);
    expect(err).toMatchObject({ status: 403, code: 'AuthorizationFailed' });
  });
});

describe('Azure et Google Cloud : identifiants', () => {
  it('jeton Azure collé : audience Resource Manager et expiration vérifiées', () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    expect(azureTokenFromPasted(fakeJwt({ aud: 'https://management.azure.com/', exp })).expiration).toEqual(
      new Date(exp * 1000),
    );
    expect(() => azureTokenFromPasted(fakeJwt({ aud: 'https://graph.microsoft.com', exp }))).toThrow(
      /Resource Manager/,
    );
    expect(() => azureTokenFromPasted(fakeJwt({ aud: 'https://management.azure.com', exp: 1 }))).toThrow(
      /expiré/,
    );
  });

  it('compte de service Google Cloud : jeton demandé en portée lecture seule, signature RS256 valide', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const key = JSON.stringify({
      type: 'service_account',
      client_email: 'lecteur@projet-demo.iam.gserviceaccount.com',
      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
      token_uri: 'https://oauth2.googleapis.com/token',
    });
    let assertion = '';
    const token = await gcpTokenFromServiceAccount(key, (async (url: string, init: RequestInit) => {
      expect(url).toBe('https://oauth2.googleapis.com/token');
      assertion = new URLSearchParams(String(init.body)).get('assertion') ?? '';
      return json(200, { access_token: 'ya29.jeton-de-test', expires_in: 3599 });
    }) as unknown as typeof fetch);
    expect(token).toMatchObject({ provider: 'gcp', accessToken: 'ya29.jeton-de-test', readOnlyScope: true });
    const [h, c, s] = assertion.split('.');
    expect(JSON.parse(Buffer.from(c ?? '', 'base64url').toString()).scope).toBe(GCP_READ_ONLY_SCOPE);
    expect(verify('RSA-SHA256', Buffer.from(`${h}.${c}`), publicKey, Buffer.from(s ?? '', 'base64url'))).toBe(
      true,
    );
  });

  it('clé piégée : token_uri arbitraire refusé sans aucun appel réseau', async () => {
    let called = false;
    const key = JSON.stringify({
      type: 'service_account',
      client_email: 'x@y.iam.gserviceaccount.com',
      private_key: 'clé',
      token_uri: 'https://169.254.169.254/latest/meta-data/',
    });
    await expect(
      gcpTokenFromServiceAccount(key, (async () => {
        called = true;
        return json(200, {});
      }) as typeof fetch),
    ).rejects.toThrow(/token_uri/);
    expect(called).toBe(false);
  });
});

describe('liste blanche Azure / Google Cloud', () => {
  it('aucun collecteur n’appelle fetch directement : tout passe par le client en lecture seule', () => {
    const dir = new URL('../src/providers/', import.meta.url).pathname;
    const files = (d: string): string[] =>
      readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? files(join(d, n)) : [join(d, n)]));
    const offenders = files(dir)
      .filter((f) => !/[/\\](http|auth)\.ts$/.test(f))
      .filter((f) => /\bfetch\s*\(|fetchImpl\s*\(/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
