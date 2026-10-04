import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildGraph,
  buildOrgGraph,
  Evaluator,
  parseRules,
  profileSchema,
  rawSnapshotSchema,
  type Graph,
  type RawSnapshot,
  type Resource,
  type Rule,
} from '../src/index.ts';

const root = new URL('../../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');
const ruleFiles = readdirSync(new URL('config/rules/', root)).filter((f) => f.endsWith('.yaml'));
const rules = parseRules(ruleFiles.map((name) => ({ name, content: read(`config/rules/${name}`) })));
const snapshot = rawSnapshotSchema.parse(JSON.parse(read('fixtures/demo-gcp-snapshot.json')));
const profile = profileSchema.parse(JSON.parse(read('fixtures/demo-gcp-profile.json')));

const P = '//compute.googleapis.com/projects/projet-demo-cloudmap';

function must<T>(v: T | undefined | null, what: string): T {
  if (v === undefined || v === null) throw new Error(`${what} introuvable`);
  return v;
}

function helpers(g: Graph) {
  const byLabel = (label: string) => g.nodes.filter((n) => n.label === label);
  const node = (label: string) => must(byLabel(label)[0], `nœud ${label}`);
  const ids = (label: string) =>
    new Set([
      ...byLabel(label).map((n) => n.id),
      ...g.containers.filter((c) => c.id === label).map((c) => c.id),
    ]);
  const edges = (a: string, b: string, kind?: string) =>
    g.edges.filter((e) => ids(a).has(e.source) && ids(b).has(e.target) && (!kind || e.kind === kind));
  return { node, edges };
}

describe('règles Google Cloud', () => {
  const gcpRules: Rule[] = [...rules.byType.values(), ...rules.wildcards].filter((r) =>
    r.type.includes('.googleapis.com/'),
  );

  it('se chargent sans erreur et couvrent tous les types de la fixture', () => {
    expect(rules.errors).toEqual([]);
    expect(gcpRules.length).toBeGreaterThan(50);
    for (const r of snapshot.resources) expect(rules.byType.has(r.type), r.type).toBe(true);
  });

  it('chaque règle s’évalue sans erreur sur la fixture et sur une ressource vide', async () => {
    const warnings = new Set<string>();
    const ev = new Evaluator(snapshot, snapshot.resources, rules, warnings);
    for (const rule of gcpRules) {
      const empty: Resource = { id: 'vide', type: rule.type, region: 'europe-west9', raw: {} };
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
          rule.group?.key,
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

describe('graphe de démonstration Google Cloud', async () => {
  const g = await buildGraph(snapshot, rules, profile, { groupingThreshold: 5 });
  const { node, edges } = helpers(g);
  const container = (id: string | undefined) => g.containers.find((c) => c.id === id);

  it('réseaux VPC globaux, sous-réseaux classés (IP externe, Cloud NAT, isolé)', () => {
    const vpc = must(container(`vpc:${P}/global/networks/vpc-principal`), 'VPC principal');
    expect(vpc).toMatchObject({
      label: 'vpc-principal',
      sublabel: '10.20.0.0/24, 10.20.10.0/24',
      parentId: 'global',
    });
    const subnet = (name: string) =>
      must(container(`subnet:${P}/regions/europe-west9/subnetworks/${name}`), name);
    expect(subnet('sn-front')).toMatchObject({ kind: 'subnet-public', sublabel: 'sn-front · public' });
    expect(subnet('sn-app')).toMatchObject({ kind: 'subnet-private', sublabel: 'sn-app · privé (NAT)' });
    expect(subnet('sn-donnees').sublabel).toBe('sn-donnees · privé isolé');
    expect(container(subnet('sn-app').parentId)?.label).toBe('europe-west9');
    expect(node('vm-bastion').containerId).toBe(`subnet:${P}/regions/europe-west9/subnetworks/sn-front`);
    expect(node('sql-commandes').containerId).toBe(vpc.id);
    expect(node('Cloud NAT').containerId).toBe(vpc.id);
    expect(node('api-commandes').containerId).toBe('region:europe-west9');
  });

  it('pare-feu : refus prioritaire, tags, plages, appairage, règle désactivée ignorée', () => {
    const blocked = must(edges('Internet', 'vm-bastion')[0], 'flux Internet → bastion');
    expect(blocked).toMatchObject({ label: 'TCP 22', state: 'bloque' });
    expect(blocked.evidence).toContain('bloqué : pare-feu bloquer-ssh-internet (priorité 900)');
    expect(edges('35.235.240.0/20', 'vm-bastion')[0]?.state).toBe('autorise');
    expect(edges('vm-bastion', 'web-7k2p')[0]).toMatchObject({ label: 'TCP 22', state: 'autorise' });
    expect(edges('vm-bastion', 'web-7k2p')[0]?.evidence[0]).toMatch(/depuis tag bastion/);
    const fromPeer = edges(`subnet:${P}/regions/europe-west9/subnetworks/sn-donnees`, 'web-9x4d');
    expect(fromPeer[0]?.label).toBe('TCP 8080');
    expect(edges(`subnet:${P}/regions/europe-west9/subnetworks/sn-app`, 'vm-batch')[0]?.label).toBe(
      'TCP 9000-9100',
    );
    expect(g.edges.some((e) => e.evidence.some((x) => x.includes('ancienne-regle')))).toBe(false);
    // Internet n'atteint pas les VM sans IP externe, et le pare-feu ne s'applique qu'aux VM.
    expect(edges('Internet', 'web-7k2p')).toEqual([]);
    expect(
      g.edges.filter((e) => e.evidence.some((x) => x.startsWith('pare-feu'))).map((e) => e.target),
    ).not.toContain(node('Cloud NAT').id);
  });

  it('équilibreur externe, Cloud Armor, backends, Cloud Run et ses dépendances', () => {
    expect(edges('Internet', 'fr-web-https')[0]).toMatchObject({ label: 'TCP 443', kind: 'network' });
    expect(edges('Navigateur', 'fr-web-https')).toHaveLength(1);
    expect(edges('fr-web-https', 'bs-web')).toHaveLength(1);
    expect(edges('fr-web-https', 'bs-api')).toHaveLength(1);
    expect(edges('armor-web', 'bs-web')[0]?.label).toBe('protège');
    expect(edges('armor-web', 'bs-api')).toHaveLength(1);
    expect(edges('bs-web', 'mig-web')).toHaveLength(1);
    expect(edges('mig-web', 'web-7k2p')).toHaveLength(1);
    expect(edges('mig-web', 'web-9x4d')).toHaveLength(1);
    expect(edges('bs-api', 'neg-api')).toHaveLength(1);
    expect(edges('neg-api', 'api-commandes')).toHaveLength(1);
    expect(edges('api-commandes', 'sql-commandes', 'data')).toHaveLength(1);
    expect(edges('api-commandes', 'mdp-base', 'data')).toHaveLength(1);
    expect(edges('api-commandes', 'images', 'data')).toHaveLength(1);
    expect(edges('api-commandes', 'connecteur-run')).toHaveLength(1);
    expect(edges('web-7k2p', 'Cloud NAT')[0]?.evidence).toEqual([
      'sortie Internet par Cloud NAT routeur-principal',
    ]);
  });

  it('CI/CD, Pub/Sub, déclencheurs, appairage', () => {
    expect(edges('GitHub', 'build-api', 'cicd')).toHaveLength(1);
    expect(edges('build-api', 'images', 'cicd')).toHaveLength(1);
    expect(edges('commandes', 'commandes-vers-api', 'data')).toHaveLength(1);
    expect(edges('commandes-vers-api', 'api-commandes', 'data')[0]?.label).toBe('push');
    expect(edges('projet-demo-cloudmap-medias', 'fn-vignettes')[0]?.label).toBe('déclencheur');
    const peering = g.edges.filter((e) => e.label === 'appairage');
    expect(peering).toHaveLength(1); // l'appairage vers servicenetworking (Cloud SQL) n'a pas de VPC connu
    expect([peering[0]?.source, peering[0]?.target].sort()).toEqual([
      `vpc:${P}/global/networks/vpc-donnees`,
      `vpc:${P}/global/networks/vpc-principal`,
    ]);
  });

  it('statuts, lien console Google Cloud, aucun nœud générique ni d’organisation', () => {
    expect(node('vm-batch').status).toBe('arrete');
    expect(node('vm-batch').sublabel).toBe('e2-standard-4 · arrêtée');
    expect(node('sql-commandes').status).toBe('actif');
    expect(node('mig-web').sublabel).toBe('géré · 2 instance(s)');
    for (const n of g.nodes.filter((x) => x.type.includes('.googleapis.com/'))) {
      expect(n.details.generic, n.type).toBe(false);
      expect(String(n.details.consoleUrl)).toMatch(/^https:\/\/console\.cloud\.google\.com\//);
    }
    expect(g.nodes.some((n) => /cloudresourcemanager|orgpolicy|iam\.googleapis/.test(n.type))).toBe(false);
    expect(g.warnings).toEqual([]);
  });
});

describe('pare-feu VPC (cas unitaires)', () => {
  const net = `${P}/global/networks/n`;
  const sub = `${P}/regions/europe-west9/subnetworks/s`;
  const vm = (name: string, ip: string, tags: string[], sa: string): Resource => ({
    id: `${P}/zones/europe-west9-a/instances/${name}`,
    type: 'compute.googleapis.com/Instance',
    region: 'europe-west9',
    raw: {
      name,
      status: 'RUNNING',
      tags: { items: tags },
      serviceAccounts: [{ email: sa }],
      networkInterfaces: [{ network: net, subnetwork: sub, networkIP: ip }],
    },
  });
  const fw = (name: string, raw: Record<string, unknown>): Resource => ({
    id: `${P}/global/firewalls/${name}`,
    type: 'compute.googleapis.com/Firewall',
    region: 'global',
    raw: { name, network: net, direction: 'INGRESS', priority: 1000, ...raw },
  });
  const graphOf = async (firewalls: Resource[]) => {
    const snap: RawSnapshot = {
      ...snapshot,
      meta: { ...snapshot.meta, profileId: 't' },
      resources: [
        { id: net, type: 'compute.googleapis.com/Network', region: 'global', raw: { name: 'n' } },
        {
          id: sub,
          type: 'compute.googleapis.com/Subnetwork',
          region: 'europe-west9',
          raw: { name: 's', network: net, ipCidrRange: '10.0.0.0/24' },
        },
        vm('front', '10.0.0.2', ['front'], 'front@p.iam.gserviceaccount.com'),
        vm('back', '10.0.0.3', ['back'], 'back@p.iam.gserviceaccount.com'),
        ...firewalls,
      ],
    };
    const g = await buildGraph(snap, rules, { ...profile, externalNodes: [] }, { groupingThreshold: 5 });
    return g.edges.filter((e) => e.kind === 'network').map((e) => `${e.state} ${e.label}`);
  };

  it('comptes de service en source et cible', async () => {
    expect(
      await graphOf([
        fw('sa', {
          allowed: [{ IPProtocol: 'tcp', ports: ['5432'] }],
          sourceServiceAccounts: ['front@p.iam.gserviceaccount.com'],
          targetServiceAccounts: ['back@p.iam.gserviceaccount.com'],
        }),
      ]),
    ).toEqual(['autorise TCP 5432']);
  });

  it('refus à priorité égale : bloqué ; refus moins prioritaire : sans effet', async () => {
    const allow = fw('ok', {
      allowed: [{ IPProtocol: 'tcp', ports: ['80'] }],
      sourceTags: ['front'],
      targetTags: ['back'],
    });
    const deny = (priority: number, ports: string[]) =>
      fw(`refus-${priority}`, {
        priority,
        denied: [{ IPProtocol: 'tcp', ports }],
        sourceRanges: ['10.0.0.0/24'],
      });
    expect(await graphOf([allow, deny(1000, ['80'])])).toEqual(['bloque TCP 80']);
    expect(await graphOf([allow, deny(2000, ['80'])])).toEqual(['autorise TCP 80']);
    expect(await graphOf([allow, deny(500, ['443'])])).toEqual(['autorise TCP 80']);
    expect(await graphOf([allow, deny(500, ['1-1024'])])).toEqual(['bloque TCP 80']);
  });

  it('règle sans cible ni source : toutes les VM depuis 0.0.0.0/0, sans effet sur les IP privées', async () => {
    expect(await graphOf([fw('tout', { allowed: [{ IPProtocol: 'icmp' }] })])).toEqual([]);
  });
});

describe('vue Organisation Google Cloud', () => {
  const g = must(buildOrgGraph(snapshot), 'graphe d’organisation');
  const node = (id: string) => g.nodes.find((n) => n.id === id);

  it('organisation > dossiers > projets, contrainte, liaisons de groupes', () => {
    expect(g.containers.map((c) => [c.id, c.kind, c.parentId])).toEqual([
      ['org:organizations/100000000001', 'org', undefined],
      ['ou:folders/200000000001', 'ou', 'org:organizations/100000000001'],
      ['ou:folders/200000000002', 'ou', 'org:organizations/100000000001'],
    ]);
    expect(g.containers[1]?.sublabel).toBe('gcp.resourceLocations');
    expect(node('acct:projects/123456789012')).toMatchObject({
      label: 'Démo CloudMap',
      sublabel: 'projet-demo-cloudmap · scanné',
      containerId: 'ou:folders/200000000001',
      status: 'actif',
    });
    expect(node('acct:projects/123456789013')?.containerId).toBe('ou:folders/200000000002');
    const policy = g.edges.find((e) => e.source.startsWith('pol:'));
    expect(policy).toMatchObject({ target: 'ou:folders/200000000001', label: 'Contrainte' });
    expect(
      g.edges
        .filter((e) => e.source.startsWith('grp:'))
        .map((e) => [e.source, e.target, e.label, e.labelOnFocus]),
    ).toEqual([
      ['grp:equipe-plateforme@exemple.fr', 'ou:folders/200000000001', 'editor', true],
      ['grp:auditeurs@exemple.fr', 'acct:projects/123456789012', 'viewer', true],
    ]);
    expect(node('acct:projects/123456789012')?.details.acces).toEqual(['auditeurs@exemple.fr : viewer']);
    expect(g.warnings).toEqual([]);
  });

  it('accès limité au projet membre : avertissement, pas d’erreur', () => {
    const member = {
      ...snapshot,
      resources: snapshot.resources.map((r) =>
        r.type === 'cloudresourcemanager.googleapis.com/Organization'
          ? { ...r, raw: { name: 'organizations/100000000001', _scope: 'membre' } }
          : r,
      ),
    };
    const m = must(buildOrgGraph(member), 'graphe membre');
    expect(m.warnings[0]).toMatch(/Accès limité à l'organisation/);
  });

  it('aucune donnée Resource Manager : pas de vue', () => {
    expect(buildOrgGraph({ ...snapshot, resources: [] })).toBeNull();
  });
});
