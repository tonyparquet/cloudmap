import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAndLogin, reauth, ROOT, setupAdmin, startApp, type Client } from './helpers.ts';

type App = Awaited<ReturnType<typeof startApp>>;
const fixture = JSON.parse(readFileSync(join(ROOT, 'fixtures', 'demo-snapshot.json'), 'utf8')) as {
  meta: { accountId: string };
};

describe('rôles et cloisonnement par groupes (section 4.4)', () => {
  let s: App;
  let admin: Client;
  let viewerA: Client;
  let editorB: Client;
  let profileA = '';
  let profileB = '';
  let snapshotB = '';

  beforeAll(async () => {
    s = await startApp();
    const a = await setupAdmin(s.app);
    admin = a.client;
    await reauth(admin, s.ctx, a.secret);
    for (const name of ['equipe-a', 'equipe-b'])
      expect((await admin.req('POST', '/api/admin/groups', { name })).status).toBe(200);
    viewerA = (
      await createAndLogin(s.app, s.ctx, admin, {
        username: 'lecteur-a',
        password: 'Lecteur-equipe-A-2026!',
        role: 'viewer',
        groups: ['equipe-a'],
      })
    ).client;
    editorB = (
      await createAndLogin(s.app, s.ctx, admin, {
        username: 'editeur-b',
        password: 'Editeur-equipe-B-2026!',
        role: 'editor',
        groups: ['equipe-b'],
      })
    ).client;
    const base = { regions: ['eu-west-3'], auth: { kind: 'import-only' } };
    profileA = (
      await admin.req('POST', '/api/profiles', {
        ...base,
        name: 'A',
        accountId: '111111111111',
        allowedGroups: ['equipe-a'],
      })
    ).json().profile.id;
    profileB = (
      await admin.req('POST', '/api/profiles', {
        ...base,
        name: 'B',
        accountId: fixture.meta.accountId,
        allowedGroups: ['equipe-b'],
      })
    ).json().profile.id;
    const imported = await admin.req('POST', `/api/profiles/${profileB}/import`, fixture);
    expect(imported.status).toBe(200);
    snapshotB = imported.json().snapshot.id;
  });
  afterAll(() => s.app.close());

  it('un viewer ne voit que les profils de ses groupes', async () => {
    const list = (await viewerA.req('GET', '/api/profiles')).json().profiles.map((p: { id: string }) => p.id);
    expect(list).toEqual([profileA]);
    // Résumé du dernier scan pour la page Profils : aucun snapshot encore pour A, l'import pour B.
    expect((await viewerA.req('GET', '/api/profiles')).json().profiles[0].lastSnapshot).toBeNull();
    const all = (await admin.req('GET', '/api/profiles')).json().profiles as {
      id: string;
      lastSnapshot: { id: string; resourceCount: number } | null;
    }[];
    expect(all.find((p) => p.id === profileB)?.lastSnapshot).toMatchObject({ id: snapshotB });
    expect((await viewerA.req('GET', `/api/profiles/${profileB}`)).status).toBe(404);
    expect((await viewerA.req('GET', `/api/profiles/${profileB}/snapshots`)).status).toBe(404);
    expect((await viewerA.req('GET', `/api/snapshots/${snapshotB}/graph`)).status).toBe(404);
    expect((await viewerA.req('GET', `/api/snapshots/${snapshotB}/inventory`)).status).toBe(404);
    expect((await viewerA.req('GET', `/api/profiles/${profileB}/layout`)).status).toBe(404);
  });

  it('un viewer ne peut rien modifier ni administrer', async () => {
    expect((await viewerA.req('PUT', `/api/profiles/${profileA}/layout`, { positions: {} })).status).toBe(
      403,
    );
    expect(
      (
        await viewerA.req('POST', '/api/profiles', {
          name: 'x',
          accountId: '111111111111',
          regions: [],
          auth: { kind: 'import-only' },
          allowedGroups: ['equipe-a'],
        })
      ).status,
    ).toBe(403);
    expect((await viewerA.req('POST', `/api/profiles/${profileA}/import`, fixture)).status).toBe(403);
    expect((await viewerA.req('GET', '/api/admin/audit')).status).toBe(403);
    expect((await viewerA.req('GET', '/api/config/rules')).status).toBe(403);
  });

  it('un editor gère les profils de ses groupes uniquement', async () => {
    const graph = await editorB.req('GET', `/api/snapshots/${snapshotB}/graph`);
    expect(graph.status).toBe(200);
    expect(graph.json().graph.nodes.length).toBeGreaterThan(10);
    expect((await editorB.req('GET', `/api/profiles/${profileA}`)).status).toBe(404);
    const foreign = await editorB.req('POST', '/api/profiles', {
      name: 'x',
      accountId: '111111111111',
      regions: [],
      auth: { kind: 'import-only' },
      allowedGroups: ['equipe-a'],
    });
    expect(foreign.status).toBe(403);
    const own = await editorB.req('POST', '/api/profiles', {
      name: 'x',
      accountId: '111111111111',
      regions: [],
      auth: { kind: 'import-only' },
      allowedGroups: ['equipe-b'],
    });
    expect(own.status).toBe(200);
    expect(
      (await editorB.req('PUT', `/api/profiles/${profileB}/layout`, { positions: { n1: { x: 10, y: 20 } } }))
        .status,
    ).toBe(200);
    expect((await editorB.req('GET', `/api/profiles/${profileB}/layout`)).json()).toEqual({
      positions: { n1: { x: 10, y: 20 } },
    });
  });

  it('import : schéma strict, compte vérifié, pollution de prototype rejetée', async () => {
    expect(
      (await editorB.req('POST', `/api/profiles/${profileB}/import`, { ...fixture, champInconnu: 1 })).status,
    ).toBe(400);
    expect(
      (
        await editorB.req('POST', `/api/profiles/${profileB}/import`, {
          ...fixture,
          meta: { ...fixture.meta, accountId: '222222222222' },
        })
      ).status,
    ).toBe(400);
    const poisoned = await s.app.inject({
      method: 'POST',
      url: `/api/profiles/${profileB}/import`,
      headers: {
        cookie: editorB.cookie,
        'x-csrf-token': editorB.csrf,
        origin: 'https://carto.test',
        'content-type': 'application/json',
      },
      payload: '{"__proto__": {"admin": true}, "schemaVersion": 1}',
    });
    expect(poisoned.statusCode).toBe(400);
  });

  it('comparaison de deux snapshots et inventaire', async () => {
    const second = await editorB.req('POST', `/api/profiles/${profileB}/import`, fixture);
    const d = await editorB.req('GET', `/api/snapshots/${snapshotB}/diff/${second.json().snapshot.id}`);
    expect(d.status).toBe(200);
    expect(d.json().diff.nodes).toEqual({ added: [], removed: [], modified: [] });
    const inv = await editorB.req('GET', `/api/snapshots/${snapshotB}/inventory`);
    expect(inv.json().resources.length).toBe(
      (fixture as unknown as { resources: unknown[] }).resources.length,
    );
  });

  it('un nouveau fichier de règle dans CONFIG_DIR/rules change le rendu sans rebuild', async () => {
    const url = `/api/snapshots/${snapshotB}/graph`;
    const before = (await editorB.req('GET', url)).json().graph as { nodes: { id: string; label: string }[] };
    const rds = before.nodes.find((n) => n.label === 'RDS');
    expect(rds).toBeDefined();
    const file = join(s.ctx.config.configDir, 'rules', 'zz-surcharge.yaml');
    writeFileSync(
      file,
      'type: AWS::RDS::DBInstance\nlabel: Base principale\nicon: rds\ncategory: database\n',
    );
    try {
      const after = (await editorB.req('GET', url)).json().graph as {
        nodes: { id: string; label: string }[];
      };
      expect(after.nodes.find((n) => n.id === rds?.id)?.label).toBe('Base principale');
    } finally {
      rmSync(file);
    }
    const restored = (await editorB.req('GET', url)).json().graph as {
      nodes: { id: string; label: string }[];
    };
    expect(restored.nodes.find((n) => n.id === rds?.id)?.label).toBe('RDS');
  });
});
