import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildGraph,
  Evaluator,
  parseRules,
  profileSchema,
  rawSnapshotSchema,
  type Graph,
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
const snapshot = rawSnapshotSchema.parse(JSON.parse(read('fixtures/demo-snapshot.json')));
const profile = profileSchema.parse(JSON.parse(read('fixtures/demo-profile.json')));

function must<T>(v: T | undefined, what: string): T {
  if (v === undefined) throw new Error(`${what} introuvable`);
  return v;
}

describe('catalogue de règles fourni', () => {
  it('se charge sans erreur', () => {
    expect(rules.errors).toEqual([]);
    expect(rules.byType.size).toBeGreaterThan(40);
  });

  it('chaque règle s’évalue sur la fixture sans erreur (y compris sur une ressource vide)', async () => {
    const warnings = new Set<string>();
    const ev = new Evaluator(snapshot, snapshot.resources, rules, warnings);
    const all: Rule[] = [...rules.byType.values(), ...rules.wildcards];
    for (const rule of all) {
      const matching = snapshot.resources.filter((r) => r.type === rule.type);
      const empty: Resource = { id: 'vide', type: rule.type, region: 'eu-west-3', raw: {} };
      for (const r of [...matching, empty]) {
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

describe('graphe de démonstration (section 9.5)', async () => {
  const g: Graph = await buildGraph(snapshot, rules, profile, { groupingThreshold: 5 });
  const container = (id: string | undefined) => g.containers.find((c) => c.id === id);
  const byLabel = (label: string) => g.nodes.filter((n) => n.label === label);
  const node = (label: string) => must(byLabel(label)[0], `nœud ${label}`);
  const subnetOf = (label: string) => byLabel(label).map((n) => container(n.containerId)?.label);
  const linked = (a: string, b: string, kind?: string) =>
    g.edges.filter(
      (e) =>
        byLabel(a).some((n) => n.id === e.source) &&
        byLabel(b).some((n) => n.id === e.target) &&
        (!kind || e.kind === kind),
    );

  it('n’émet aucun avertissement de règle', () => {
    expect(g.warnings.filter((w) => w.startsWith('Règle'))).toEqual([]);
  });

  it('nœuds externes et services globaux', () => {
    expect(node('GitLab')).toMatchObject({ sublabel: 'dépôt', icon: 'git' });
    expect(node('GitLab').containerId).toBeUndefined();
    expect(node('Navigateur')).toMatchObject({ sublabel: 'ce poste', icon: 'browser' });
    expect(node('CloudFront')).toMatchObject({
      containerId: 'global',
      sublabel: 'HTTP 200',
      status: 'actif',
    });
  });

  it('services régionaux hors VPC', () => {
    const region = 'region:eu-west-3';
    expect(node('S3 front')).toMatchObject({ containerId: region, status: 'actif' });
    expect(node('API Gateway')).toMatchObject({ containerId: region, sublabel: '/api 500' });
    expect(node('Cloud Map')).toMatchObject({ containerId: region, status: 'en-veille' });
    expect(node('CodeBuild')).toMatchObject({ containerId: region, sublabel: 'réussi', status: 'actif' });
    expect(node('ECR')).toMatchObject({ containerId: region, sublabel: '3 image(s)' });
    expect(node('Secrets')).toMatchObject({ containerId: region, status: 'inconnu' });
    expect(node('Endpoint S3')).toMatchObject({ sublabel: 'passerelle' });
  });

  it('VPC, zones et sous-réseaux', () => {
    const vpc = must(
      g.containers.find((c) => c.kind === 'vpc'),
      'VPC',
    );
    expect(vpc.sublabel).toBe('10.20.0.0/16');
    expect(vpc.parentId).toBe('region:eu-west-3');
    const azs = g.containers.filter((c) => c.kind === 'az').map((c) => c.label);
    expect(azs.sort()).toEqual(['eu-west-3a', 'eu-west-3b']);
    const subnets = Object.fromEntries(
      g.containers.filter((c) => c.kind.startsWith('subnet')).map((c) => [c.label, c.kind]),
    );
    expect(subnets).toEqual({
      '10.20.10.0/24': 'subnet-private',
      '10.20.11.0/24': 'subnet-private',
      '10.20.0.0/24': 'subnet-public',
      '10.20.1.0/24': 'subnet-public',
    });
    expect(subnetOf('RDS')).toEqual(['10.20.10.0/24']);
    expect(node('RDS')).toMatchObject({ status: 'arrete', sublabel: 'arrêtée' });
    expect(subnetOf('Lien VPC').sort()).toEqual(['10.20.10.0/24', '10.20.11.0/24']);
    expect(byLabel('Lien VPC').every((n) => n.status === 'en-veille')).toBe(true);
    expect(subnetOf('Migration')).toEqual(['10.20.0.0/24']);
    expect(node('Migration').status).toBe('inconnu');
    expect(subnetOf('Tâche ECS')).toEqual(['10.20.0.0/24']);
    expect(node('Tâche ECS')).toMatchObject({ sublabel: '0/0 tâche', status: 'en-veille' });
    expect(g.nodes.filter((n) => container(n.containerId)?.label === '10.20.1.0/24')).toEqual([]);
    expect(node('IGW')).toMatchObject({ containerId: vpc.id, sublabel: 'sans NAT' });
    expect(node('Endpoint S3').containerId).toBe(vpc.id);
  });

  it('flux attendus', () => {
    expect(linked('Navigateur', 'CloudFront')).toHaveLength(1);
    expect(linked('CloudFront', 'S3 front')).toHaveLength(1);
    expect(linked('CloudFront', 'API Gateway')).toHaveLength(1);
    expect(linked('API Gateway', 'Cloud Map')).toHaveLength(1);
    expect(linked('API Gateway', 'Lien VPC')).toHaveLength(2);
    expect(linked('Lien VPC', 'Lien VPC')).toHaveLength(2);
    expect(linked('Lien VPC', 'Tâche ECS').map((e) => e.label)).toEqual(['TCP 8080', 'TCP 8080']);
    expect(linked('Tâche ECS', 'RDS')[0]).toMatchObject({
      label: 'TCP 5432',
      kind: 'network',
      state: 'autorise',
    });
    expect(linked('Migration', 'RDS')[0]?.label).toBe('TCP 5432');
    expect(linked('Tâche ECS', 'IGW')[0]?.label).toBe('TCP 443');
    expect(linked('IGW', 'Secrets')).toHaveLength(1);
    expect(linked('GitLab', 'CodeBuild', 'cicd')).toHaveLength(1);
    expect(linked('CodeBuild', 'ECR', 'cicd')).toHaveLength(1);
    expect(linked('Migration', 'IGW')).toHaveLength(1);
    expect(linked('IGW', 'Migration')[0]?.label).toBe('TCP 443');
  });

  it('reste stable (snapshot du graphe)', () => {
    const name = (id: string) => g.nodes.find((n) => n.id === id)?.label ?? id;
    expect({
      containers: g.containers
        .map((c) => `${c.kind} ${c.label}${c.sublabel ? ` (${c.sublabel})` : ''}`)
        .sort(),
      nodes: g.nodes
        .map(
          (n) => `${n.label} [${n.sublabel ?? ''}] ${n.status} @ ${container(n.containerId)?.label ?? '—'}`,
        )
        .sort(),
      edges: g.edges
        .map((e) => `${name(e.source)} → ${name(e.target)} : ${e.kind} ${e.label ?? ''} ${e.state}`)
        .sort(),
    }).toMatchSnapshot();
  });
});
