import { generateKeyPairSync } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { reauth, setupAdmin, startApp } from './helpers.ts';

// Valeurs fictives : Azure et Google Cloud ne sont jamais contactés (fetch global simulé).
const SUB = '00000000-0000-4000-8000-0000000000aa';
const TENANT = '00000000-0000-4000-8000-0000000000bb';
const CLIENT = '00000000-0000-4000-8000-0000000000cc';
const CLIENT_SECRET = 'abc8Q~SecretClientFictif0123456789abcdef';
const PROJECT = 'projet-test-carto';
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const AZ_TOKEN = `${b64({ alg: 'none' })}.${b64({ aud: 'https://management.azure.com/', exp: Math.floor(Date.now() / 1000) + 3600 })}.c2lnbmF0dXJlLWZpY3RpdmU`;
const GCP_TOKEN = 'ya29.jeton-google-fictif-0123456789abcdef';
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const SA_KEY = JSON.stringify({
  type: 'service_account',
  client_email: 'lecteur@projet-test-carto.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  token_uri: 'https://oauth2.googleapis.com/token',
});
const SA_PRIVATE = String(JSON.parse(SA_KEY).private_key).split('\n')[1] ?? '';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
let azureSubscriptionStatus = 200;
const calls: string[] = [];

function fakeCloud(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = String(input instanceof Request ? input.url : input);
  calls.push(`${init?.method ?? 'GET'} ${url}`);
  if (url.startsWith('https://login.microsoftonline.com/'))
    return Promise.resolve(json(200, { access_token: AZ_TOKEN, expires_in: 3599 }));
  if (url.includes(`/subscriptions/${SUB}/providers/Microsoft.Authorization/permissions`))
    return Promise.resolve(json(200, { value: [{ actions: ['*/read'], notActions: [] }] }));
  if (url.includes(`/subscriptions/${SUB}?`))
    return Promise.resolve(
      json(azureSubscriptionStatus, {
        subscriptionId: SUB,
        displayName: 'Abonnement test',
        tenantId: TENANT,
        state: 'Enabled',
      }),
    );
  if (url === 'https://oauth2.googleapis.com/token')
    return Promise.resolve(json(200, { access_token: GCP_TOKEN, expires_in: 3599 }));
  if (url.endsWith(`/projects/${PROJECT}:testIamPermissions`))
    return Promise.resolve(json(200, { permissions: ['compute.instances.delete'] }));
  if (url.endsWith(`/projects/${PROJECT}`))
    return Promise.resolve(
      json(200, { projectId: PROJECT, name: 'projects/42', displayName: 'Projet test' }),
    );
  return Promise.resolve(json(404, { error: { code: 404, message: `inattendu : ${url}` } }));
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });
}

describe('identifiants Azure et Google Cloud', () => {
  let s: Awaited<ReturnType<typeof startApp>>;
  let admin: Awaited<ReturnType<typeof setupAdmin>>['client'];
  let azure = '';
  let gcp = '';
  let aws = '';

  beforeAll(async () => {
    vi.stubGlobal('fetch', vi.fn(fakeCloud));
    s = await startApp({}, { logToFile: true });
    const setup = await setupAdmin(s.app);
    admin = setup.client;
    await reauth(admin, s.ctx, setup.secret);
    const create = async (body: Record<string, unknown>) =>
      (
        await admin.req('POST', '/api/profiles', {
          auth: { kind: 'access-keys' },
          allowedGroups: [],
          ...body,
        })
      ).json().profile.id as string;
    azure = await create({ name: 'Azure', provider: 'azure', accountId: SUB, regions: ['francecentral'] });
    gcp = await create({ name: 'GCP', provider: 'gcp', accountId: PROJECT, regions: ['europe-west9'] });
    aws = await create({ name: 'AWS', accountId: '123456789012', regions: ['eu-west-3'] });
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await s.app.close();
  });

  it('profils : identifiants de compte et régions propres au fournisseur, modes d’accès cohérents', async () => {
    const bad = await admin.req('POST', '/api/profiles', {
      name: 'x',
      provider: 'azure',
      accountId: '123456789012',
      regions: ['eu-west-3'],
      auth: { kind: 'access-keys' },
      allowedGroups: [],
    });
    expect(bad.status).toBe(400);
    expect(bad.json().error.message).toMatch(/GUID.*Région Azure/);
    const hub = await admin.req('POST', '/api/profiles', {
      name: 'x',
      provider: 'gcp',
      accountId: PROJECT,
      regions: ['europe-west9'],
      auth: { kind: 'assume-role-hub', roleArn: 'arn:aws:iam::123456789012:role/x' },
      allowedGroups: [],
    });
    expect(hub.json().error.message).toMatch(/que pour AWS/);
  });

  it('Azure : jeton collé (mémoire), principal de service mémorisé chiffré', async () => {
    const pasted = await admin.req('PUT', `/api/profiles/${azure}/credentials`, {
      type: 'azure-token',
      accessToken: AZ_TOKEN,
    });
    expect(pasted.status).toBe(200);
    expect(pasted.json()).toMatchObject({
      credentials: [{ storage: 'memoire', type: 'azure-token' }],
      warnings: [],
    });
    const sp = await admin.req('PUT', `/api/profiles/${azure}/credentials`, {
      type: 'azure-sp',
      tenantId: TENANT,
      clientId: CLIENT,
      clientSecret: CLIENT_SECRET,
      remember: true,
    });
    expect(sp.status).toBe(200);
    expect(sp.json().credentials.map((c: { storage: string }) => c.storage)).toEqual(['memoire', 'chiffre']);
    const row = s.ctx.db.prepare('SELECT envelope, masked_key_id FROM credentials').get() as {
      envelope: string;
      masked_key_id: string;
    };
    expect(row.masked_key_id).toBe('0000…00cc');
    expect(row.envelope).not.toContain(CLIENT_SECRET);
  });

  it('refus : type d’un autre fournisseur, abonnement inaccessible', async () => {
    const mismatch = await admin.req('PUT', `/api/profiles/${aws}/credentials`, {
      type: 'azure-token',
      accessToken: AZ_TOKEN,
    });
    expect(mismatch.json().error.code).toBe('TYPE_INCOMPATIBLE');
    const awsKeys = await admin.req('PUT', `/api/profiles/${gcp}/credentials`, {
      type: 'user',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    });
    expect(awsKeys.json().error.code).toBe('TYPE_INCOMPATIBLE');
    azureSubscriptionStatus = 403;
    const denied = await admin.req('PUT', `/api/profiles/${azure}/credentials`, {
      type: 'azure-token',
      accessToken: AZ_TOKEN,
    });
    azureSubscriptionStatus = 200;
    expect(denied.status).toBe(400);
    expect(denied.json().error.message).toMatch(/n’ont pas accès à l’abonnement.*HTTP 403/);
  });

  it('Google Cloud : compte de service → jeton en lecture seule, rôle IAM trop large signalé', async () => {
    const res = await admin.req('PUT', `/api/profiles/${gcp}/credentials`, {
      type: 'gcp-sa',
      serviceAccountJson: SA_KEY,
    });
    expect(res.status).toBe(200);
    expect(res.json().warnings).toEqual([
      'Rôle IAM avec droits d’écriture : le jeton obtenu reste limité à la lecture seule',
    ]);
    const pasted = await admin.req('PUT', `/api/profiles/${gcp}/credentials`, {
      type: 'gcp-token',
      accessToken: GCP_TOKEN,
    });
    expect(pasted.json().warnings).toContain(
      'Jeton à portée complète : préférez un compte de service (jeton limité à la lecture seule)',
    );
    const test = await admin.req('POST', `/api/profiles/${gcp}/credentials/test`);
    expect(test.json()).toMatchObject({ account: PROJECT, arn: `Projet test (${PROJECT})`, matches: true });
  });

  it('scan Azure : snapshot enregistré avec le fournisseur', async () => {
    const scan = await admin.req('POST', `/api/profiles/${azure}/scans`, {});
    expect(scan.status).toBe(200);
    const scanId = scan.json().scanId as string;
    for (let i = 0; i < 100 && !s.ctx.scans.get(scanId)?.finished; i++)
      await new Promise((r) => setTimeout(r, 50));
    const snap = s.ctx.storage.listSnapshots(azure)[0];
    expect(snap).toBeDefined();
    if (snap)
      expect(s.ctx.storage.loadSnapshot(snap).meta).toMatchObject({ provider: 'azure', accountId: SUB });
    expect((await admin.req('POST', `/api/profiles/${azure}/scans`, { services: ['ec2'] })).status).toBe(400);
  });

  it('aucun secret dans les réponses, la base ou les journaux', async () => {
    await new Promise((r) => setTimeout(r, 100));
    for (const r of admin.responses)
      for (const secret of [CLIENT_SECRET, AZ_TOKEN, GCP_TOKEN, SA_PRIVATE])
        expect(r.body).not.toContain(secret);
    for (const f of filesUnder(s.ctx.config.dataDir)) {
      const content = readFileSync(f).toString('latin1');
      for (const secret of [CLIENT_SECRET, AZ_TOKEN, GCP_TOKEN, SA_PRIVATE])
        expect(content, f).not.toContain(secret);
    }
    expect(calls.some((c) => c.startsWith('POST https://management.azure.com/subscriptions'))).toBe(false);
  });
});
