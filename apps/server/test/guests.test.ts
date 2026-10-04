import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ADMIN, Client, enableMfa, ROOT, startApp } from './helpers.ts';

const snapshot = JSON.parse(readFileSync(join(ROOT, 'fixtures', 'demo-snapshot.json'), 'utf8')) as {
  meta: { accountId: string };
};
const profileBody = (name: string, groups: string[]) => ({
  name,
  accountId: snapshot.meta.accountId,
  regions: ['eu-west-3'],
  auth: { kind: 'import-only' },
  allowedGroups: groups,
});

/** Contenu persistant de DATA_DIR : lignes de chaque table et fichiers de données. */
function persisted(ctx: Awaited<ReturnType<typeof startApp>>['ctx'], dataDir: string) {
  const tables = [
    'users',
    'sessions',
    'profiles',
    'snapshots',
    'credentials',
    'audit',
    'folders',
    'folder_entries',
  ];
  const files = (d: string): string[] =>
    existsSync(join(dataDir, d)) ? readdirSync(join(dataDir, d), { recursive: true }).map(String) : [];
  return {
    rows: Object.fromEntries(
      tables.map((t) => [
        t,
        (ctx.main.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n,
      ]),
    ),
    snapshots: files('snapshots'),
    layouts: files('layouts'),
  };
}

async function guestClient(app: Awaited<ReturnType<typeof startApp>>['app']) {
  const c = new Client(app);
  await c.req('GET', '/api/auth/state');
  const r = await c.req('POST', '/api/auth/guest');
  if (r.status !== 200) throw new Error(`invité ${r.status} ${r.body}`);
  return c;
}

/** Profil importé, mise en page, dossier : le travail type d'une session. */
async function work(c: Client, groups: string[]) {
  const p = await c.req('POST', '/api/profiles', profileBody('Travail', groups));
  expect(p.status).toBe(200);
  const id = p.json().profile.id as string;
  expect((await c.req('POST', `/api/profiles/${id}/import`, snapshot)).status).toBe(200);
  expect(
    (await c.req('PUT', `/api/profiles/${id}/layout`, { positions: { n1: { x: 1, y: 2 } } })).status,
  ).toBe(200);
  const f = await c.req('POST', '/api/folders', { name: 'Clients' });
  const folderId = f.json().folder.id as string;
  expect((await c.req('PUT', `/api/profiles/${id}/folder`, { folderId })).status).toBe(200);
  return { id, folderId };
}

describe('mode invité et comptes facultatifs', () => {
  const closers: (() => Promise<unknown>)[] = [];
  afterAll(async () => {
    for (const c of closers) await c();
  });
  const start = async (env: NodeJS.ProcessEnv = {}) => {
    const s = await startApp(env);
    closers.push(() => s.app.close());
    return s;
  };

  it('invité : rien n’est écrit dans DATA_DIR, les données des comptes restent invisibles', async () => {
    const { app, ctx, env } = await start();
    const admin = new Client(app);
    await admin.req('GET', '/api/auth/state');
    expect((await admin.req('POST', '/api/auth/register', ADMIN)).status).toBe(200);
    await admin.req('POST', '/api/profiles', profileBody('Compte de l’admin', []));
    const before = persisted(ctx, env.DATA_DIR as string);

    const guest = await guestClient(app);
    const state = (await guest.req('GET', '/api/auth/state')).json();
    expect(state).toMatchObject({ guest: true, user: { guest: true } });
    const { id } = await work(guest, ['invite']);
    const list = (await guest.req('GET', '/api/profiles')).json().profiles as { id: string; name: string }[];
    expect(list.map((p) => p.name)).toEqual(['Travail']);
    expect((await guest.req('GET', `/api/profiles/${id}/snapshots`)).json().snapshots).toHaveLength(1);
    // Rien d'administrable, pas de compte.
    expect((await guest.req('GET', '/api/admin/users')).status).toBe(403);
    expect((await guest.req('GET', '/api/auth/account')).status).toBe(403);
    // L'administrateur ne voit pas le travail de l'invité.
    const adminList = (await admin.req('GET', '/api/profiles')).json().profiles as { name: string }[];
    expect(adminList.map((p) => p.name)).not.toContain('Travail');

    expect(persisted(ctx, env.DATA_DIR as string)).toEqual(before);
    // Déconnexion : l'espace disparaît, la session ne vaut plus rien.
    await guest.req('POST', '/api/auth/logout');
    expect(ctx.guests.families()).toHaveLength(0);
    expect((await guest.req('GET', '/api/profiles')).status).toBe(401);
    expect(persisted(ctx, env.DATA_DIR as string)).toEqual(before);
  });

  it('invité : jamais l’identité AWS propre de l’outil (HUB_CREDENTIALS)', async () => {
    const { app } = await start({ HUB_CREDENTIALS: 'default-chain' });
    const guest = await guestClient(app);
    expect((await guest.req('GET', '/api/config/services')).json().hubAvailable).toBe(false);
    const p = await guest.req('POST', '/api/profiles', {
      ...profileBody('Hub', ['invite']),
      auth: { kind: 'access-keys' },
    });
    const id = p.json().profile.id as string;
    const r = await guest.req('PUT', `/api/profiles/${id}/credentials`, {
      type: 'hub-role',
      roleArn: 'arn:aws:iam::000000000000:role/Lecture',
      externalId: 'exemple-external-id',
    });
    expect(r.status).toBe(400);
    expect(r.body).toMatch(/HUB_CREDENTIALS/);
  });

  it('invité qui crée un compte : profils, snapshots, mise en page et dossiers conservés', async () => {
    const { app, ctx, env } = await start();
    const admin = new Client(app);
    await admin.req('GET', '/api/auth/state');
    await admin.req('POST', '/api/auth/register', ADMIN);

    const guest = await guestClient(app);
    const { id, folderId } = await work(guest, ['invite']);
    const reg = await guest.req('POST', '/api/auth/register', {
      username: 'camille',
      password: 'Une-autre-phrase-solide-77',
    });
    expect(reg.status).toBe(200);
    expect(reg.json()).toMatchObject({
      user: { role: 'editor', groups: ['perso.camille'] },
      transferred: { profiles: 1, snapshots: 1 },
    });
    expect(ctx.guests.families()).toHaveLength(0);
    const profile = (await guest.req('GET', `/api/profiles/${id}`)).json().profile;
    expect(profile.allowedGroups).toEqual(['perso.camille']);
    const snap = (await guest.req('GET', `/api/profiles/${id}/snapshots`)).json().snapshots[0];
    expect((await guest.req('GET', `/api/snapshots/${snap.id}/graph`)).status).toBe(200);
    expect((await guest.req('GET', `/api/profiles/${id}/layout`)).json().positions.n1).toEqual({
      x: 1,
      y: 2,
    });
    expect((await guest.req('GET', '/api/folders')).json()).toEqual({
      folders: [{ id: folderId, parentId: null, name: 'Clients' }],
      entries: { [id]: folderId },
    });
    expect(readdirSync(join(env.DATA_DIR as string, 'snapshots', id))).toHaveLength(1);
    // Le nouveau compte ne voit pas le profil de l'administrateur (groupe personnel).
    await admin.req('POST', '/api/profiles', profileBody('Privé admin', []));
    const names = ((await guest.req('GET', '/api/profiles')).json().profiles as { name: string }[]).map(
      (p) => p.name,
    );
    expect(names).toEqual(['Travail']);
  });

  it('MFA facultatif : connexion par mot de passe, puis activable (le code devient exigé)', async () => {
    const { app } = await start();
    const c = new Client(app);
    await c.req('GET', '/api/auth/state');
    expect((await c.req('POST', '/api/auth/register', ADMIN)).status).toBe(200);
    expect((await c.req('GET', '/api/profiles')).status).toBe(200);
    expect((await c.req('GET', '/api/auth/account')).json()).toMatchObject({ mfaEnabled: false });
    // Ré-authentification : mot de passe seul tant que le MFA n'est pas activé.
    expect((await c.req('POST', '/api/auth/reauth', { password: 'mauvais-mot-de-passe' })).status).toBe(401);
    // Activation impossible sans ré-authentification récente.
    expect((await c.req('GET', '/api/auth/totp/enroll')).status).toBe(403);
    await enableMfa(c, ADMIN.password);
    expect((await c.req('GET', '/api/auth/account')).json()).toMatchObject({
      mfaEnabled: true,
      recoveryCodesLeft: 10,
    });

    const d = new Client(app);
    await d.req('GET', '/api/auth/state');
    expect((await d.req('POST', '/api/auth/login', ADMIN)).json().stage).toBe('mfa');
    expect((await d.req('GET', '/api/profiles')).status).toBe(401);
    // Code exigé désormais pour la ré-authentification.
    expect((await c.req('POST', '/api/auth/reauth', { password: ADMIN.password })).status).toBe(401);
  });

  it('réglages d’accès : invités et création libre de comptes désactivables', async () => {
    const { app, ctx } = await start();
    ctx.config.app.access.guests = false;
    ctx.config.app.access.selfRegistration = false;
    const c = new Client(app);
    const state = (await c.req('GET', '/api/auth/state')).json();
    expect(state).toMatchObject({ guestsAllowed: false, registrationOpen: true, setupRequired: true });
    expect((await c.req('POST', '/api/auth/guest')).json().error.code).toBe('INVITE_DESACTIVE');
    // Le premier compte reste possible (administrateur), pas les suivants.
    expect((await c.req('POST', '/api/auth/register', ADMIN)).status).toBe(200);
    const d = new Client(app);
    expect((await d.req('GET', '/api/auth/state')).json().registrationOpen).toBe(false);
    const r = await d.req('POST', '/api/auth/register', {
      username: 'camille',
      password: 'Une-autre-phrase-solide-77',
    });
    expect(r.json().error.code).toBe('INSCRIPTION_FERMEE');
    // Nombre d'invités simultanés plafonné.
    ctx.config.app.access.guests = true;
    ctx.config.app.access.maxGuests = 1;
    await guestClient(app);
    const e = new Client(app);
    await e.req('GET', '/api/auth/state');
    expect((await e.req('POST', '/api/auth/guest')).status).toBe(429);
  });

  it('dossiers : arborescence, déplacement sans cycle, suppression sans perte, cloisonnés par utilisateur', async () => {
    const { app } = await start();
    const c = new Client(app);
    await c.req('GET', '/api/auth/state');
    await c.req('POST', '/api/auth/register', ADMIN);
    const { id, folderId: a } = await work(c, []);
    const b = (await c.req('POST', '/api/folders', { name: 'Production', parentId: a })).json().folder.id;
    const sub = (await c.req('POST', '/api/folders', { name: 'Réseau', parentId: b })).json().folder.id;
    // Un dossier ne peut pas aller dans lui-même ni dans un descendant.
    expect((await c.req('PATCH', `/api/folders/${a}`, { parentId: sub })).json().error.code).toBe('CYCLE');
    expect((await c.req('PATCH', `/api/folders/${b}`, { parentId: b })).json().error.code).toBe('CYCLE');
    expect((await c.req('PATCH', `/api/folders/${sub}`, { parentId: null, name: 'Réseaux' })).status).toBe(
      200,
    );
    // Profil rangé dans b puis b supprimé : le profil et ses sous-dossiers remontent dans a.
    await c.req('PUT', `/api/profiles/${id}/folder`, { folderId: b });
    const sub2 = (await c.req('POST', '/api/folders', { name: 'Sous', parentId: b })).json().folder.id;
    expect((await c.req('DELETE', `/api/folders/${b}`)).status).toBe(200);
    const tree = (await c.req('GET', '/api/folders')).json();
    expect(tree.entries).toEqual({ [id]: a });
    expect(tree.folders).toContainEqual({ id: sub2, parentId: a, name: 'Sous' });
    expect(tree.folders).toContainEqual({ id: sub, parentId: null, name: 'Réseaux' });

    // Un autre utilisateur ne voit ni ne modifie ces dossiers.
    const other = new Client(app);
    await other.req('GET', '/api/auth/state');
    await other.req('POST', '/api/auth/register', {
      username: 'camille',
      password: 'Une-autre-phrase-solide-77',
    });
    expect((await other.req('GET', '/api/folders')).json()).toEqual({ folders: [], entries: {} });
    expect((await other.req('PATCH', `/api/folders/${a}`, { name: 'Piraté' })).status).toBe(404);
    expect((await other.req('PUT', `/api/profiles/${id}/folder`, { folderId: null })).status).toBe(404);
  });
});
