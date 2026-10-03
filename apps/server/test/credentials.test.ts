import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DescribeVpcsCommand, EC2Client } from '@aws-sdk/client-ec2';
import { IAMClient, SimulatePrincipalPolicyCommand } from '@aws-sdk/client-iam';
import {
  AssumeRoleCommand,
  GetCallerIdentityCommand,
  GetSessionTokenCommand,
  STSClient,
} from '@aws-sdk/client-sts';
import { mockClient } from 'aws-sdk-client-mock';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reauth, setupAdmin, startApp } from './helpers.ts';

// Valeurs d'exemple de la documentation AWS : elles ne doivent jamais ressortir de l'API ni être écrites en clair.
const AKID = 'AKIAIOSFODNN7EXAMPLE';
const SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const TEMP_AKID = 'ASIAIOSFODNN7EXAMPLE';
const TEMP_SECRET = 'je7MtGbClwBF/2Zp9Utk/h3yCo8nvbEXAMPLEKEY';
const TOKEN = `FwoGZXIvYXdzEJr${'A'.repeat(180)}`;
const STS_TOKEN = `IQoJb3JpZ2luX2VjE${'B'.repeat(180)}`;
const ACCOUNT = '123456789012';

const sts = mockClient(STSClient);
const iam = mockClient(IAMClient);
const ec2 = mockClient(EC2Client);

type App = Awaited<ReturnType<typeof startApp>>;
type Identity = { Account: string; Arn: string; UserId: string };
const DEFAULT_IDENTITY: Identity = {
  Account: ACCOUNT,
  Arn: `arn:aws:iam::${ACCOUNT}:user/lecteur`,
  UserId: 'AIDAEXAMPLE',
};
/** Réponses successives de GetCallerIdentity (puis l'identité par défaut). */
const identities: Identity[] = [];

/** Clés d'objets JSON (récursif) : aucune ne doit porter un secret. */
function jsonKeys(v: unknown): string[] {
  if (Array.isArray(v)) return v.flatMap(jsonKeys);
  if (v && typeof v === 'object') return Object.entries(v).flatMap(([k, x]) => [k, ...jsonKeys(x)]);
  return [];
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });
}

describe('identifiants AWS saisis dans l’interface (section 4.3)', () => {
  let s: App;
  let admin: Awaited<ReturnType<typeof setupAdmin>>;
  let profileId = '';

  beforeAll(async () => {
    s = await startApp({}, { logToFile: true });
    admin = await setupAdmin(s.app);
    const created = await admin.client.req('POST', '/api/profiles', {
      name: 'Client test',
      accountId: ACCOUNT,
      regions: ['eu-west-3'],
      auth: { kind: 'access-keys' },
      allowedGroups: [],
    });
    profileId = created.json().profile.id;
    const temp = {
      AccessKeyId: TEMP_AKID,
      SecretAccessKey: TEMP_SECRET,
      SessionToken: STS_TOKEN,
      Expiration: new Date(Date.now() + 3_600_000),
    };
    sts.on(GetCallerIdentityCommand).callsFake(() => Promise.resolve(identities.shift() ?? DEFAULT_IDENTITY));
    sts.on(GetSessionTokenCommand).resolves({ Credentials: temp });
    sts.on(AssumeRoleCommand).resolves({ Credentials: temp });
    iam
      .on(SimulatePrincipalPolicyCommand)
      .resolves({ EvaluationResults: [{ EvalActionName: 's3:PutObject', EvalDecision: 'allowed' }] });
    ec2.onAnyCommand().resolves({});
    ec2.on(DescribeVpcsCommand).resolves({ Vpcs: [{ VpcId: 'vpc-1', CidrBlock: '10.0.0.0/16' }] });
  });
  afterAll(async () => {
    sts.reset();
    iam.reset();
    ec2.reset();
    await s.app.close();
  });

  const url = () => `/api/profiles/${profileId}/credentials`;

  it('exige une ré-authentification récente', async () => {
    const res = await admin.client.req('PUT', url(), {
      type: 'temporary',
      accessKeyId: TEMP_AKID,
      secretAccessKey: TEMP_SECRET,
      sessionToken: TOKEN,
    });
    expect(res.status).toBe(403);
    expect(res.json().error.code).toBe('REAUTH_REQUISE');
    const stored = await admin.client.req('GET', '/api/credentials/stored');
    expect(stored.json().error.code).toBe('REAUTH_REQUISE');
    await reauth(admin.client, s.ctx, admin.secret);
  });

  it('valide le format avant tout appel AWS', async () => {
    const res = await admin.client.req('PUT', url(), {
      type: 'temporary',
      accessKeyId: 'pas-une-cle',
      secretAccessKey: 'x',
      sessionToken: 'y',
    });
    expect(res.status).toBe(400);
    expect(res.body).not.toContain('pas-une-cle');
  });

  it('refuse le compte racine et un compte différent du profil', async () => {
    identities.push({ Account: ACCOUNT, Arn: `arn:aws:iam::${ACCOUNT}:root`, UserId: ACCOUNT });
    const root = await admin.client.req('PUT', url(), {
      type: 'user',
      accessKeyId: AKID,
      secretAccessKey: SECRET,
    });
    expect(root.status).toBe(400);
    expect(root.json().error.message).toMatch(/racine/);
    identities.push({ Account: '999999999999', Arn: 'arn:aws:iam::999999999999:user/x', UserId: 'U' });
    const other = await admin.client.req('PUT', url(), {
      type: 'user',
      accessKeyId: AKID,
      secretAccessKey: SECRET,
    });
    expect(other.status).toBe(400);
    expect(other.json().error).toMatchObject({ code: 'COMPTE_DIFFERENT' });
    expect(other.json().error.message).toMatch(/999999999999/);
  });

  it('identifiants temporaires : conservés en mémoire, seul l’identifiant masqué est renvoyé', async () => {
    const res = await admin.client.req('PUT', url(), {
      type: 'temporary',
      accessKeyId: TEMP_AKID,
      secretAccessKey: TEMP_SECRET,
      sessionToken: TOKEN,
    });
    expect(res.status).toBe(200);
    const body = res.json();
    expect(body.credentials[0]).toMatchObject({
      storage: 'memoire',
      type: 'temporary',
      maskedAccessKeyId: 'ASIA…MPLE',
    });
    expect(body.warnings).toContain('Ces identifiants ne sont pas en lecture seule');
  });

  it('clés longue durée « mémorisées » : échangées immédiatement et chiffrées en base', async () => {
    const res = await admin.client.req('PUT', url(), {
      type: 'user',
      accessKeyId: AKID,
      secretAccessKey: SECRET,
      remember: true,
    });
    expect(res.status).toBe(200);
    expect(sts.commandCalls(GetSessionTokenCommand).length).toBeGreaterThan(0);
    const storages = res.json().credentials.map((c: { storage: string }) => c.storage);
    expect(storages).toEqual(expect.arrayContaining(['memoire', 'chiffre']));
    const row = s.ctx.db.prepare('SELECT envelope, masked_key_id FROM credentials').get() as {
      envelope: string;
      masked_key_id: string;
    };
    expect(row.masked_key_id).toBe('AKIA…MPLE');
    expect(row.envelope).not.toContain(SECRET);
    expect(row.envelope).not.toContain(AKID);
  });

  it('réutilisation des clés mémorisées d’un autre profil : métadonnées masquées, secret jamais renvoyé', async () => {
    const other = await admin.client.req('POST', '/api/profiles', {
      name: 'Même compte, autres régions',
      accountId: ACCOUNT,
      regions: ['eu-west-1'],
      auth: { kind: 'access-keys' },
      allowedGroups: [],
    });
    const otherId = other.json().profile.id as string;
    const list = await admin.client.req('GET', '/api/credentials/stored');
    expect(list.status).toBe(200);
    expect(list.json().stored).toEqual([
      expect.objectContaining({
        profileId,
        accountId: ACCOUNT,
        type: 'user',
        maskedAccessKeyId: 'AKIA…MPLE',
      }),
    ]);
    const missing = await admin.client.req('PUT', `/api/profiles/${otherId}/credentials`, {
      type: 'stored',
      sourceProfileId: 'inconnu',
    });
    expect(missing.status).toBe(404);
    const noExternalId = await admin.client.req('PUT', `/api/profiles/${otherId}/credentials`, {
      type: 'stored',
      sourceProfileId: profileId,
      roleArn: `arn:aws:iam::${ACCOUNT}:role/Autre`,
    });
    expect(noExternalId.status).toBe(400);
    const reused = await admin.client.req('PUT', `/api/profiles/${otherId}/credentials`, {
      type: 'stored',
      sourceProfileId: profileId,
    });
    expect(reused.status).toBe(200);
    expect(reused.json().credentials.map((c: { storage: string }) => c.storage)).toEqual(
      expect.arrayContaining(['memoire', 'chiffre']),
    );
    // Copie chiffrée propre au profil cible (AAD = profil cible), puis nettoyage.
    expect(
      s.ctx.db.prepare('SELECT COUNT(*) AS n FROM credentials WHERE profile_id = ?').get(otherId),
    ).toEqual({ n: 1 });
    expect((await admin.client.req('DELETE', `/api/profiles/${otherId}/credentials`)).status).toBe(200);
  });

  it('hub d’organisation : profils membres créés en lot, rôle assumé avec les identifiants du hub', async () => {
    const body = {
      accountIds: ['222222222222', ACCOUNT],
      roleName: 'CartographeLectureSeule',
      externalId: 'ext-org-0123456789',
      regions: ['eu-west-3'],
      allowedGroups: [],
    };
    const res = await admin.client.req('POST', `/api/profiles/${profileId}/org-accounts`, body);
    expect(res.status).toBe(200);
    // Le compte du hub lui-même est ignoré ; un second envoi ne recrée rien.
    const created = res.json().created as { id: string; accountId: string }[];
    expect(created.map((c) => c.accountId)).toEqual(['222222222222']);
    expect(
      (await admin.client.req('POST', `/api/profiles/${profileId}/org-accounts`, body)).json().created,
    ).toEqual([]);
    const child = created[0]?.id ?? '';
    const childUrl = `/api/profiles/${child}/credentials`;
    expect((await admin.client.req('GET', `${childUrl}/available`)).json().available).toBe(true);
    const direct = await admin.client.req('PUT', childUrl, {
      type: 'user',
      accessKeyId: AKID,
      secretAccessKey: SECRET,
    });
    expect(direct.json().error.code).toBe('VIA_PROFIL');

    identities.push({
      Account: '222222222222',
      Arn: 'arn:aws:sts::222222222222:assumed-role/x/y',
      UserId: 'U',
    });
    const test = await admin.client.req('POST', `${childUrl}/test`);
    expect(test.json()).toMatchObject({ account: '222222222222', matches: true });
    expect(sts.commandCalls(AssumeRoleCommand).at(-1)?.args[0].input).toMatchObject({
      RoleArn: 'arn:aws:iam::222222222222:role/CartographeLectureSeule',
      ExternalId: 'ext-org-0123456789',
    });

    // Un profil sans identifiants propres (imports uniquement) ne peut pas servir de hub.
    const importOnly = await admin.client.req('POST', '/api/profiles', {
      name: 'Imports',
      accountId: '333333333333',
      regions: ['eu-west-3'],
      auth: { kind: 'import-only' },
      allowedGroups: [],
    });
    const bad = await admin.client.req(
      'POST',
      `/api/profiles/${importOnly.json().profile.id}/org-accounts`,
      body,
    );
    expect(bad.json().error.code).toBe('HUB_INVALIDE');
    for (const id of [child, importOnly.json().profile.id as string]) {
      expect((await admin.client.req('DELETE', `/api/profiles/${id}`)).status).toBe(200);
    }
  });

  it('rôle à assumer avec External ID', async () => {
    identities.push(
      { Account: '210987654321', Arn: 'arn:aws:iam::210987654321:user/hub', UserId: 'U' },
      { Account: ACCOUNT, Arn: `arn:aws:sts::${ACCOUNT}:assumed-role/Lecture/session`, UserId: 'U' },
    );
    const res = await admin.client.req('PUT', url(), {
      type: 'user-role',
      accessKeyId: AKID,
      secretAccessKey: SECRET,
      roleArn: `arn:aws:iam::${ACCOUNT}:role/Lecture`,
      externalId: 'id-externe-de-test',
    });
    expect(res.status).toBe(200);
    expect(sts.commandCalls(AssumeRoleCommand).at(-1)?.args[0].input).toMatchObject({
      ExternalId: 'id-externe-de-test',
    });
  });

  it('état, test et scan : aucun secret dans les réponses', async () => {
    expect((await admin.client.req('GET', `${url()}/status`)).status).toBe(200);
    const test = await admin.client.req('POST', `${url()}/test`);
    expect(test.json()).toMatchObject({ account: ACCOUNT, matches: true });
    const scan = await admin.client.req('POST', `/api/profiles/${profileId}/scans`, {
      services: ['network'],
    });
    expect(scan.status).toBe(200);
    const scanId = scan.json().scanId as string;
    for (let i = 0; i < 100 && !s.ctx.scans.get(scanId)?.finished; i++)
      await new Promise((r) => setTimeout(r, 50));
    const events = await s.app.inject({
      method: 'GET',
      url: `/api/scans/${scanId}/events`,
      headers: { cookie: admin.client.cookie },
    });
    expect(events.headers['content-type']).toContain('text/event-stream');
    expect(events.body).toContain('event: snapshot');
    expect(events.headers['content-security-policy']).toBeDefined();
    const snaps = await admin.client.req('GET', `/api/profiles/${profileId}/snapshots`);
    expect(snaps.json().snapshots[0]).toMatchObject({ source: 'scan', resource_count: 1 });
  });

  it('suppression des identifiants', async () => {
    const res = await admin.client.req('DELETE', url());
    expect(res.status).toBe(200);
    expect(res.json().credentials).toEqual([]);
    expect(s.ctx.db.prepare('SELECT COUNT(*) AS n FROM credentials').get()).toEqual({ n: 0 });
  });

  it('aucune réponse de l’API ne contient de clé secrète ni de jeton de session', () => {
    expect(admin.client.responses.length).toBeGreaterThan(10);
    for (const r of admin.client.responses) {
      const text = `${JSON.stringify(r.headers)}\n${r.body}`;
      for (const secret of [SECRET, TEMP_SECRET, TOKEN, STS_TOKEN, AKID, TEMP_AKID])
        expect(text).not.toContain(secret);
      if (r.url.includes('/credentials') && r.body.startsWith('{')) {
        expect(
          jsonKeys(JSON.parse(r.body)).filter((k) => /secret|token/i.test(k) && k !== 'csrfToken'),
        ).toEqual([]);
      }
    }
  });

  it('rien n’est écrit en clair sur disque ni dans les journaux', async () => {
    await new Promise((r) => setTimeout(r, 100));
    const files = filesUnder(s.ctx.config.dataDir);
    expect(files.some((f) => f.endsWith('app.log'))).toBe(true);
    for (const f of files) {
      const content = readFileSync(f).toString('latin1');
      for (const secret of [SECRET, TEMP_SECRET, TOKEN, STS_TOKEN]) expect(content, f).not.toContain(secret);
    }
  });
});
