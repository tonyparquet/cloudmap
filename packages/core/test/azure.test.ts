import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildGraph,
  buildOrgGraph,
  Evaluator,
  parseRules,
  rawSnapshotSchema,
  type Graph,
  type RawSnapshot,
  type Resource,
  type Rule,
} from '../src/index.ts';

const root = new URL('../../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');
const rules = parseRules(
  readdirSync(new URL('config/rules/', root))
    .filter((f) => f.endsWith('.yaml'))
    .map((name) => ({ name, content: read(`config/rules/${name}`) })),
);
const snapshot = rawSnapshotSchema.parse(JSON.parse(read('fixtures/demo-azure-snapshot.json')));

describe('Azure : règles', () => {
  it('se chargent sans erreur et s’évaluent sur la fixture Azure (et sur une ressource vide)', async () => {
    expect(rules.errors).toEqual([]);
    const warnings = new Set<string>();
    const ev = new Evaluator(snapshot, snapshot.resources, rules, warnings);
    const azure: Rule[] = [...rules.byType.values()].filter((r) => r.type.startsWith('microsoft.'));
    expect(azure.length).toBeGreaterThan(30);
    for (const rule of azure) {
      const empty: Resource = { id: 'vide', type: rule.type, region: 'francecentral', raw: {} };
      for (const r of [...snapshot.resources.filter((x) => x.type === rule.type), empty]) {
        const exprs = [
          rule.label,
          rule.sublabel,
          rule.securityGroups,
          rule.ips,
          rule.dnsNames,
          rule.console,
          rule.placement?.ref,
          rule.placement?.vpcRef,
          ...(rule.status ?? []).map((s) => ('when' in s ? s.when : undefined)),
          ...(rule.relations ?? []).map((x) => x.to),
          ...Object.values(rule.details ?? {}),
        ];
        for (const e of exprs) await ev.value(e, r);
      }
    }
    expect([...warnings]).toEqual([]);
  });
});

describe('Azure : diagramme d’infrastructure', async () => {
  const g: Graph = await buildGraph(snapshot, rules, {});
  const node = (label: string) => g.nodes.find((n) => n.label === label);
  const container = (id: string | undefined) => g.containers.find((c) => c.id === id);
  const edgesBetween = (source: string | undefined, target: string | undefined) =>
    g.edges.filter((e) => e.source === source && e.target === target);

  it('VNet et sous-réseaux classés (public, privé NAT), ressources placées', () => {
    const vnet = g.containers.find((c) => c.kind === 'vpc' && c.label === 'vnet-demo');
    expect(vnet?.sublabel).toBe('10.40.0.0/16');
    expect(container(vnet?.parentId)).toMatchObject({ kind: 'region', label: 'francecentral' });
    const subnet = (label: string) => g.containers.find((c) => c.label === label);
    expect(subnet('10.40.1.0/24')).toMatchObject({ kind: 'subnet-public' });
    expect(subnet('10.40.2.0/24')).toMatchObject({ kind: 'subnet-private' });
    expect(subnet('10.40.2.0/24')?.sublabel).toContain('NAT');
    expect(container(node('vm-web')?.containerId)?.label).toBe('10.40.1.0/24');
    expect(container(node('pe-sql')?.containerId)?.label).toBe('10.40.2.0/24');
    expect(container(node('fd-demo')?.containerId)?.kind).toBe('global');
    expect(node('vm-web')).toMatchObject({ status: 'actif', sublabel: 'Standard_B2s · en marche' });
    expect(node('sql-demo')?.sublabel).toContain('1 base(s)');
    // Primitives réseau et organisation : jamais en nœuds.
    for (const hidden of [
      'nsg-web',
      'nic-vm-web',
      'vnet-demo',
      'abonnement-exemple',
      'Emplacements autorisés',
    ])
      expect(node(hidden)).toBeUndefined();
  });

  it('flux NSG : HTTPS depuis Internet, SSH refusé en priorité, SSH depuis le VNet appairé, SQL par ASG', () => {
    const vm = node('vm-web')?.id;
    const internet = g.nodes.find((n) => n.type === 'External::Internet')?.id;
    const fromInternet = edgesBetween(internet, vm);
    expect(fromInternet.find((e) => e.label === 'TCP 443')?.state).toBe('autorise');
    expect(fromInternet.find((e) => e.label === 'TCP 22')?.state).toBe('bloque');
    const partage = g.containers.find((c) => c.kind === 'vpc' && c.label === 'vnet-partage')?.id;
    expect(edgesBetween(partage, vm).find((e) => e.label === 'TCP 22')?.state).toBe('autorise');
    const sql = edgesBetween(vm, node('pe-sql')?.id).find((e) => e.label === 'TCP 1433');
    expect(sql?.state).toBe('autorise');
    expect(sql?.evidence.join(' ')).toContain('AutoriserSQLDepuisWeb');
  });

  it('appairage, Front Door → App Service, endpoint privé → SQL', () => {
    expect(g.edges.some((e) => e.label === 'appairage')).toBe(true);
    expect(edgesBetween(node('fd-demo')?.id, node('app-commandes')?.id)[0]?.label).toBe('HTTPS');
    expect(edgesBetween(node('pe-sql')?.id, node('sql-demo')?.id)[0]?.label).toBe('Private Link');
  });
});

describe('Azure : vue Organisation', () => {
  it('locataire > groupes d’administration > abonnements, stratégie et rôles', () => {
    const g = buildOrgGraph(snapshot);
    expect(g).not.toBeNull();
    const org = g?.containers.find((c) => c.kind === 'org');
    expect(org?.label).toBe('Locataire · Tenant Root Group');
    const prod = g?.containers.find((c) => c.label === 'Production');
    expect(prod).toMatchObject({ kind: 'ou', parentId: org?.id });
    const sub = g?.nodes.find((n) => n.label === 'abonnement-exemple');
    expect(sub).toMatchObject({ containerId: prod?.id, category: 'management', status: 'actif' });
    expect(sub?.sublabel).toContain('analysé');
    expect(g?.edges.find((e) => e.target === prod?.id)?.label).toBe('Stratégie');
    const roles = g?.edges.filter((e) => e.target === sub?.id && e.labelOnFocus).map((e) => e.label);
    expect(roles?.sort()).toEqual(['Contributor (rg-demo)', 'Reader']);
    expect(g?.warnings).toEqual([]);
  });

  it('abonnement seul (groupes d’administration illisibles) : avertissement, pas d’erreur', () => {
    const only: RawSnapshot = {
      ...snapshot,
      resources: snapshot.resources.filter((r) => r.type === 'microsoft.resources/subscriptions'),
    };
    const g = buildOrgGraph(only);
    expect(g?.containers[0]).toMatchObject({ kind: 'org' });
    expect(g?.warnings[0]).toContain("groupes d'administration non lisibles");
  });

  it('groupes illisibles : hiérarchie reconstituée depuis l’abonnement, portées sans casse', () => {
    const g = buildOrgGraph({
      ...snapshot,
      resources: [
        {
          id: '/subscriptions/00000000-0000-4000-8000-000000000001',
          type: 'microsoft.resources/subscriptions',
          region: 'global',
          raw: {
            name: 'abonnement-exemple',
            properties: {
              state: 'Enabled',
              managementGroupAncestorsChain: [
                { name: 'Mg-Lab', displayName: 'Laboratoire' },
                { name: 'tenant-racine', displayName: 'Tenant Root Group' },
              ],
            },
          },
        },
        {
          id: '/providers/microsoft.management/managementgroups/mg-lab/providers/microsoft.authorization/policyassignments/journaux',
          type: 'microsoft.authorization/policyassignments',
          region: 'global',
          raw: {
            name: 'journaux',
            properties: { displayName: '', scope: '/providers/microsoft.management/managementgroups/mg-lab' },
          },
        },
      ],
    });
    const org = g?.containers.find((c) => c.kind === 'org');
    expect(org?.label).toBe('Locataire · Tenant Root Group');
    const lab = g?.containers.find((c) => c.label === 'Laboratoire');
    expect(lab).toMatchObject({ kind: 'ou', parentId: org?.id });
    expect(g?.nodes.find((n) => n.icon === 'account')?.containerId).toBe(lab?.id);
    const pol = g?.nodes.find((n) => n.icon === 'policy');
    expect(pol).toMatchObject({ label: 'journaux', status: 'actif' });
    expect(g?.edges.find((e) => e.source === pol?.id)?.target).toBe(lab?.id);
  });

  it('aucune donnée d’organisation : pas de vue', () => {
    expect(buildOrgGraph({ ...snapshot, resources: [] })).toBeNull();
  });
});
