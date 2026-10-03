import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildGraph, mergeSnapshots, parseRules, rawSnapshotSchema, type RawSnapshot } from '../src/index.ts';

const root = new URL('../../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');
const rules = parseRules(
  readdirSync(new URL('config/rules/', root))
    .filter((f) => f.endsWith('.yaml'))
    .map((name) => ({ name, content: read(`config/rules/${name}`) })),
);
const demo = rawSnapshotSchema.parse(JSON.parse(read('fixtures/demo-snapshot.json')));
// Compte partenaire fictif : appairage avec le VPC de la démo, Transit Gateway partagé par la démo,
// groupe de sécurité qui autorise le groupe des tâches ECS de la démo (référence inter-comptes).
const partner = rawSnapshotSchema.parse(JSON.parse(read('fixtures/demo-partenaire-snapshot.json')));

const DEMO = '000000000000';
const PARTNER = '111111111111';
const R = 'eu-west-3';
const TGW_ARN = `arn:aws:ec2:${R}:${DEMO}:transit-gateway/tgw-0de0000000000001`;
const tgwSeenBy = (snapshot: RawSnapshot) => snapshot.resources.find((r) => r.arn === TGW_ARN);

// Côté démo, le Transit Gateway (propriétaire) et son attachement : la fusion ne garde qu'un nœud.
const owned = tgwSeenBy(partner);
const demoPlus: RawSnapshot = {
  ...demo,
  resources: [
    ...demo.resources,
    ...(owned ? [{ ...owned, raw: { ...(owned.raw as object), _vuDepuis: DEMO } }] : []),
    {
      arn: `arn:aws:ec2:${R}:${DEMO}:transit-gateway-attachment/tgw-attach-0de0000000001`,
      id: 'tgw-attach-0de0000000001',
      type: 'AWS::EC2::TransitGatewayAttachment',
      region: R,
      raw: {
        TransitGatewayId: 'tgw-0de0000000000001',
        ResourceId: 'vpc-0de0000000000001',
        State: 'available',
      },
    },
  ],
};

describe('vue multi-comptes', () => {
  it('un cadre par compte, liens inter-comptes résolus par le moteur de règles', async () => {
    const merged = mergeSnapshots([
      { name: 'Démo', snapshot: demoPlus, profile: {} },
      { name: 'Partenaire', snapshot: partner, profile: {} },
    ]);
    const g = await buildGraph(merged.snapshot, rules, merged.profile, {
      accountLabels: merged.accountLabels,
    });
    const container = (id: string) => g.containers.find((c) => c.id === id);
    expect(container(`account:${DEMO}`)).toMatchObject({ kind: 'account', label: 'Démo', sublabel: DEMO });
    expect(container(`account:${PARTNER}`)).toMatchObject({ kind: 'account', label: 'Partenaire' });
    expect(container(`account:${PARTNER}/region:${R}`)?.parentId).toBe(`account:${PARTNER}`);
    expect(container('vpc:vpc-0b00000000000001')?.parentId).toBe(`account:${PARTNER}/region:${R}`);
    expect(container('vpc:vpc-0de0000000000001')?.parentId).toBe(`account:${DEMO}/region:${R}`);

    // Appairage actif (vu depuis le seul partenaire) : arête entre les deux VPC.
    const peering = g.edges.find((e) => e.label === 'appairage');
    expect([peering?.source, peering?.target].sort()).toEqual([
      'vpc:vpc-0b00000000000001',
      'vpc:vpc-0de0000000000001',
    ]);

    // Transit Gateway partagé : un seul nœud, chez le propriétaire, relié aux attachements des deux comptes.
    const tgws = g.nodes.filter((n) => n.type === 'AWS::EC2::TransitGateway');
    expect(tgws).toHaveLength(1);
    expect(tgws[0]?.containerId).toBe(`account:${DEMO}/region:${R}`);
    expect(g.edges.filter((e) => e.target === tgws[0]?.id)).toHaveLength(2);

    // Groupe de sécurité du partenaire qui autorise le groupe des tâches ECS de la démo.
    const ecs = g.nodes.find((n) => n.label === 'Tâche ECS');
    const instance = g.nodes.find((n) => n.label === 'service-partenaire');
    expect(g.edges.find((e) => e.source === ecs?.id && e.target === instance?.id)?.label).toBe('TCP 443');
  });

  it('vu seul, le Transit Gateway partagé indique son propriétaire et aucun cadre de compte', async () => {
    const g = await buildGraph(partner, rules, {});
    expect(g.nodes.find((n) => n.type === 'AWS::EC2::TransitGateway')?.sublabel).toBe(`partagé par ${DEMO}`);
    expect(g.containers.some((c) => c.kind === 'account')).toBe(false);
  });
});
