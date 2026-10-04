import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { changelogSection, releaseChangelog } from '../src/changelog.ts';
import { UpdateChecker } from '../src/updates.ts';
import { compareVersions } from '../src/version.ts';
import { createAndLogin, reauth, setupAdmin, startApp } from './helpers.ts';

const release = (tag: string) =>
  new Response(
    JSON.stringify({
      tag_name: tag,
      name: `Cartographe ${tag}`,
      html_url: `https://github.com/exemple/depot/releases/tag/${tag}`,
      published_at: '2026-10-04T10:00:00Z',
      body: '### Ajouté\n- Une nouveauté',
    }),
    { status: 200 },
  );
const settings = {
  enabled: true,
  feedUrl: 'https://api.github.com/repos/exemple/depot/releases/latest',
  intervalHours: 24,
};

describe('versions et journal des modifications', () => {
  it('comparaison semver, préversion inférieure à la version finale', () => {
    expect(compareVersions('1.2.0', '1.10.0')).toBe(-1);
    expect(compareVersions('v2.0.0', '1.9.9')).toBe(1);
    expect(compareVersions('1.0.0', 'v1.0.0')).toBe(0);
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBe(-1);
    expect(compareVersions('pas une version', '1.0.0')).toBeNull();
  });

  it('publication : « Non publié » devient la version datée, sections extraites', () => {
    const md =
      '# Journal\n\n## [Non publié]\n\n### Ajouté\n- B\n\n## [1.0.0] - 2026-10-01\n\n### Ajouté\n- A\n';
    const out = releaseChangelog(md, '1.1.0', '2026-10-04');
    expect(out).toContain('## [Non publié]\n\n## [1.1.0] - 2026-10-04\n\n### Ajouté\n- B');
    expect(changelogSection(out, '1.1.0')).toBe('### Ajouté\n- B');
    expect(changelogSection(out, 'v1.0.0')).toBe('### Ajouté\n- A');
    expect(changelogSection(out, 'Non publié')).toBe('');
    expect(() => releaseChangelog(out, '1.1.0', '2026-10-05')).toThrow(/déjà/);
    expect(() => releaseChangelog(out, '1.2.0', '2026-10-05')).toThrow(/Aucune entrée/);
  });
});

describe('recherche de mise à jour', () => {
  it('version plus récente publiée, résultat en cache', async () => {
    let calls = 0;
    const checker = new UpdateChecker(settings, '1.0.0', undefined, (async (
      url: string,
      init: RequestInit,
    ) => {
      calls++;
      expect(url).toBe(settings.feedUrl);
      expect((init.headers as Record<string, string>)['user-agent']).toBe('cartographe-aws/1.0.0');
      return release('v1.1.0');
    }) as unknown as typeof fetch);
    expect(await checker.status()).toMatchObject({
      current: '1.0.0',
      latest: '1.1.0',
      available: true,
      url: 'https://github.com/exemple/depot/releases/tag/v1.1.0',
      notes: '### Ajouté\n- Une nouveauté',
    });
    await checker.status();
    expect(calls).toBe(1);
    await checker.status(true);
    expect(calls).toBe(2);
  });

  it('à jour, désactivé, flux privé sans jeton', async () => {
    const same = new UpdateChecker(settings, '1.1.0', undefined, (async () =>
      release('v1.1.0')) as unknown as typeof fetch);
    expect(await same.status()).toMatchObject({ available: false, latest: '1.1.0' });
    const off = new UpdateChecker({ ...settings, enabled: false }, '1.0.0', undefined, (async () => {
      throw new Error('aucun appel attendu');
    }) as unknown as typeof fetch);
    expect(await off.status()).toEqual({ current: '1.0.0', enabled: false, available: false });
    let auth = '';
    const privateRepo = new UpdateChecker(settings, '1.0.0', 'jeton-lecture', (async (
      _u: string,
      init: RequestInit,
    ) => {
      auth = (init.headers as Record<string, string>).authorization ?? '';
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch);
    const status = await privateRepo.status();
    expect(auth).toBe('Bearer jeton-lecture');
    expect(status.available).toBe(false);
    expect(status.error).toMatch(/HTTP 404.*UPDATES_TOKEN_FILE/);
  });
});

describe('API des mises à jour', () => {
  let s: Awaited<ReturnType<typeof startApp>>;
  let admin: Awaited<ReturnType<typeof setupAdmin>>['client'];
  let viewer: Awaited<ReturnType<typeof createAndLogin>>['client'];
  beforeAll(async () => {
    s = await startApp({}, { fetchImpl: (async () => release('v9.9.9')) as unknown as typeof fetch });
    const setup = await setupAdmin(s.app);
    admin = setup.client;
    await reauth(admin, s.ctx, setup.secret);
    viewer = (
      await createAndLogin(s.app, s.ctx, admin, {
        username: 'lecteur',
        password: 'Consultation-versions-2026!',
        role: 'viewer',
        groups: [],
      })
    ).client;
  });
  afterAll(() => s.app.close());

  it('état visible par tous, recherche forcée réservée aux administrateurs et journalisée, notes de version', async () => {
    expect((await viewer.req('GET', '/api/updates')).json()).toMatchObject({
      latest: '9.9.9',
      available: true,
    });
    expect((await viewer.req('POST', '/api/updates/check')).status).toBe(403);
    expect((await admin.req('POST', '/api/updates/check')).json()).toMatchObject({ available: true });
    const audit = s.ctx.db
      .prepare("SELECT action FROM audit WHERE action = 'mise-a-jour.verification'")
      .all();
    expect(audit).toHaveLength(1);
    const notes = (await viewer.req('GET', '/api/changelog')).json() as { version: string; notes: string };
    expect(notes.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(notes.notes.length).toBeGreaterThan(0);
  });
});
