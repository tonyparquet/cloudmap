import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildOrgGraph, rawSnapshotSchema, type Graph } from '../src/index.ts';

const snapshot = rawSnapshotSchema.parse(
  JSON.parse(readFileSync(new URL('../../../fixtures/demo-snapshot.json', import.meta.url), 'utf8')),
);

function must(g: Graph | null): Graph {
  if (!g) throw new Error('graphe d’organisation attendu');
  return g;
}

describe('vue Organisation (buildOrgGraph)', () => {
  const g = must(buildOrgGraph(snapshot));
  const node = (id: string) => g.nodes.find((n) => n.id === id);
  const edge = (source: string, target: string) =>
    g.edges.find((e) => e.source === source && e.target === target);

  it('organisation > OU imbriquées > comptes', () => {
    expect(g.containers.map((c) => [c.id, c.kind, c.parentId])).toEqual([
      ['org:o-demo000000', 'org', undefined],
      ['ou:ou-de00-socle', 'ou', 'org:o-demo000000'],
      ['ou:ou-de00-prod', 'ou', 'org:o-demo000000'],
      ['ou:ou-de00-prodeu', 'ou', 'ou:ou-de00-prod'],
      ['ou:ou-de00-sandbox', 'ou', 'org:o-demo000000'],
    ]);
    expect(g.containers[0]?.sublabel).toBe('Compte de gestion 000000000000');
    expect(g.containers.find((c) => c.id === 'ou:ou-de00-prod')?.sublabel).toBe('RegionsEurope (SCP)');
    expect(node('acct:000000000000')).toMatchObject({
      containerId: 'org:o-demo000000',
      sublabel: '000000000000 · gestion',
    });
    expect(node('acct:000000000022')).toMatchObject({
      label: 'production-eu',
      containerId: 'ou:ou-de00-prodeu',
      status: 'actif',
    });
    expect(node('acct:000000000031')?.status).toBe('arrete');
    expect(node('acct:000000000011')?.details.servicesDelegues).toEqual(['securityhub.amazonaws.com']);
  });

  it('politiques directes et héritées, FullAWSAccess sans nœud', () => {
    const d = node('acct:000000000022')?.details ?? {};
    expect(d.politiquesDirectes).toEqual(['PerimetreDonnees (RCP)']);
    expect(d.politiquesHeritees).toEqual(
      expect.arrayContaining([
        'RegionsEurope (SCP)',
        'InterdireSortieOrganisation (SCP)',
        'FullAWSAccess (SCP)',
      ]),
    );
    expect(node('pol:p-FullAWSAccess')).toBeUndefined();
    expect(edge('pol:p-de00regions', 'ou:ou-de00-prod')).toMatchObject({ kind: 'dependency', label: 'SCP' });
    expect(edge('pol:p-de00sortie', 'org:o-demo000000')?.label).toBe('SCP');
    expect(edge('pol:p-de00donnees', 'acct:000000000022')?.label).toBe('RCP');
  });

  it('Identity Center : groupes et utilisateur reliés aux comptes, permission sets en étiquette', () => {
    expect(node('grp:g-de00admins')).toMatchObject({ label: 'Administrateurs', sublabel: '3 membres' });
    expect(edge('grp:g-de00admins', 'acct:000000000021')).toMatchObject({
      label: 'AdministratorAccess',
      labelOnFocus: true,
    });
    expect(edge('pol:p-de00regions', 'ou:ou-de00-prod')?.labelOnFocus).toBeUndefined();
    expect(edge('grp:g-de00devs', 'acct:000000000021')?.label).toBe('LectureSeule');
    expect(edge('usr:u-de00astreinte', 'acct:000000000021')?.evidence).toEqual([
      'permission set LectureSeule',
    ]);
    expect(node('acct:000000000021')?.details.acces).toEqual(
      expect.arrayContaining(['Administrateurs : AdministratorAccess', 'Développeurs : LectureSeule']),
    );
  });

  it('sans données d’organisation : null ; compte membre : avertissement et compte scanné seul', () => {
    const infra = {
      ...snapshot,
      resources: snapshot.resources.filter((r) => !/^AWS::(Organizations|SSO|IdentityStore)::/.test(r.type)),
    };
    expect(buildOrgGraph(infra)).toBeNull();
    const member = must(
      buildOrgGraph({
        ...infra,
        resources: [
          {
            id: 'o-x',
            type: 'AWS::Organizations::Organization',
            region: 'global',
            raw: { Id: 'o-x', MasterAccountId: '111111111111', _scope: 'membre' },
          },
        ],
      }),
    );
    expect(member.nodes.map((n) => n.id)).toEqual(['acct:000000000000']);
    expect(member.warnings[0]).toMatch(/membre de l'organisation o-x/);
  });
});
