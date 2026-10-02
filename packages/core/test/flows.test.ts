import { describe, expect, it } from 'vitest';
import {
  buildGraph,
  buildNetworkModel,
  classifyRouteTable,
  diff,
  naclAllows,
  parseRules,
  type Graph,
  type RawSnapshot,
  type Resource,
} from '../src/index.ts';

const R = 'xx-test-1';
const res = (
  type: string,
  id: string,
  raw: Record<string, unknown>,
  tags?: Record<string, string>,
): Resource => ({
  id,
  type,
  region: R,
  raw,
  ...(tags ? { tags } : {}),
});

const allOut = [{ IpProtocol: '-1', IpRanges: [{ CidrIp: '0.0.0.0/0' }] }];
const tcp = (port: number, from: { sg?: string; cidr?: string }) => ({
  IpProtocol: 'tcp',
  FromPort: port,
  ToPort: port,
  ...(from.sg ? { UserIdGroupPairs: [{ GroupId: from.sg }] } : {}),
  ...(from.cidr ? { IpRanges: [{ CidrIp: from.cidr }] } : {}),
});

function network(extra: Resource[] = []): Resource[] {
  return [
    res('AWS::EC2::VPC', 'vpc-1', { VpcId: 'vpc-1', CidrBlock: '10.0.0.0/16' }),
    res('AWS::EC2::Subnet', 'sn-pub', {
      SubnetId: 'sn-pub',
      VpcId: 'vpc-1',
      CidrBlock: '10.0.0.0/24',
      AvailabilityZone: `${R}a`,
    }),
    res('AWS::EC2::Subnet', 'sn-nat', {
      SubnetId: 'sn-nat',
      VpcId: 'vpc-1',
      CidrBlock: '10.0.1.0/24',
      AvailabilityZone: `${R}a`,
    }),
    res('AWS::EC2::Subnet', 'sn-iso', {
      SubnetId: 'sn-iso',
      VpcId: 'vpc-1',
      CidrBlock: '10.0.2.0/24',
      AvailabilityZone: `${R}b`,
    }),
    res('AWS::EC2::RouteTable', 'rt-main', {
      RouteTableId: 'rt-main',
      VpcId: 'vpc-1',
      Associations: [{ Main: true }],
      Routes: [{ DestinationCidrBlock: '10.0.0.0/16', GatewayId: 'local' }],
    }),
    res('AWS::EC2::RouteTable', 'rt-pub', {
      RouteTableId: 'rt-pub',
      VpcId: 'vpc-1',
      Associations: [{ SubnetId: 'sn-pub' }],
      Routes: [{ DestinationCidrBlock: '0.0.0.0/0', GatewayId: 'igw-1' }],
    }),
    res('AWS::EC2::RouteTable', 'rt-nat', {
      RouteTableId: 'rt-nat',
      VpcId: 'vpc-1',
      Associations: [{ SubnetId: 'sn-nat' }],
      Routes: [{ DestinationCidrBlock: '0.0.0.0/0', NatGatewayId: 'nat-1' }],
    }),
    res('AWS::EC2::InternetGateway', 'igw-1', {
      InternetGatewayId: 'igw-1',
      Attachments: [{ VpcId: 'vpc-1' }],
    }),
    res('AWS::EC2::NatGateway', 'nat-1', {
      NatGatewayId: 'nat-1',
      VpcId: 'vpc-1',
      SubnetId: 'sn-pub',
      State: 'available',
    }),
    res('AWS::EC2::SecurityGroup', 'sg-lb', {
      GroupId: 'sg-lb',
      GroupName: 'lb',
      IpPermissions: [tcp(443, { cidr: '0.0.0.0/0' })],
      IpPermissionsEgress: [tcp(80, { cidr: '0.0.0.0/0' })],
    }),
    res('AWS::EC2::SecurityGroup', 'sg-app', {
      GroupId: 'sg-app',
      IpPermissions: [tcp(8080, { sg: 'sg-lb' }), tcp(22, { cidr: '10.0.0.0/24' })],
      IpPermissionsEgress: allOut,
    }),
    res('AWS::EC2::SecurityGroup', 'sg-db', {
      GroupId: 'sg-db',
      IpPermissions: [tcp(5432, { sg: 'sg-app' }), tcp(5433, { sg: 'sg-app' })],
      IpPermissionsEgress: [],
    }),
    ...extra,
  ];
}

const nodes = (extra: Resource[] = []) => [
  res('Test::Node', 'lb', { Name: 'lb', SubnetId: 'sn-pub', Sgs: ['sg-lb'], Ips: ['10.0.0.10'] }),
  res('Test::Node', 'app', {
    Name: 'app',
    SubnetId: 'sn-nat',
    Sgs: ['sg-app'],
    Ips: ['10.0.1.10'],
    Uses: ['secret-1'],
  }),
  res('Test::Node', 'db', { Name: 'db', SubnetId: 'sn-iso', Sgs: ['sg-db'], Ips: ['10.0.2.10'] }),
  res('Test::Svc', 'secret-1', { Name: 'secret' }),
  ...extra,
];

const rules = parseRules([
  {
    name: 'test.yaml',
    content: `
- type: Test::Node
  typeLabel: Nœud
  label: "$r.raw.Name"
  icon: ec2
  category: compute
  placement: { container: subnet, ref: "$r.raw.SubnetId" }
  securityGroups: "$r.raw.Sgs"
  ips: "$r.raw.Ips"
  status: [{ default: actif }]
  relations:
    - { kind: data, to: "$r.raw.Uses", resolve: id }
- type: Test::Svc
  label: "$r.raw.Name"
  icon: secrets
  category: security
  awsService: secretsmanager
- type: AWS::EC2::InternetGateway
  label: IGW
  icon: igw
  category: network
  placement: { container: vpc, ref: "$r.raw.Attachments.VpcId" }
- type: AWS::EC2::NatGateway
  label: NAT
  icon: nat
  category: network
  placement: { container: subnet, ref: "$r.raw.SubnetId" }
- type: AWS::EC2::VPCEndpoint
  label: Endpoint
  icon: endpoint
  category: network
  placement: { container: vpc, ref: "$r.raw.VpcId" }
- type: External::Internet
  label: Internet
  icon: internet
  category: external
  placement: { container: none }
- { type: AWS::EC2::VPC, label: VPC, icon: vpc, category: network, hidden: true }
- { type: AWS::EC2::Subnet, label: Subnet, icon: vpc, category: network, hidden: true }
- { type: AWS::EC2::RouteTable, label: RT, icon: vpc, category: network, hidden: true }
- { type: AWS::EC2::SecurityGroup, label: SG, icon: vpc, category: network, hidden: true }
- { type: AWS::EC2::NetworkAcl, label: NACL, icon: vpc, category: network, hidden: true }
`,
  },
]);
expect(rules.errors).toEqual([]);

const snap = (resources: Resource[], extra: Partial<RawSnapshot> = {}): RawSnapshot => ({
  schemaVersion: 1,
  meta: {
    profileId: 'p',
    accountId: '000000000000',
    regions: [R],
    startedAt: '2026-01-01T00:00:00Z',
    finishedAt: '2026-01-01T00:01:00Z',
    scannerVersion: 'test',
  },
  resources,
  errors: [],
  ...extra,
});

function must<T>(v: T | undefined, what: string): T {
  if (v === undefined) throw new Error(`${what} introuvable`);
  return v;
}
const node = (g: Graph, label: string) =>
  must(
    g.nodes.find((n) => n.label === label),
    label,
  );
const edgesBetween = (g: Graph, a: string, b: string) =>
  g.edges.filter((e) => e.source === node(g, a).id && e.target === node(g, b).id);

describe('classification des sous-réseaux (7.1)', () => {
  it('public / privé avec NAT / privé isolé (table principale par défaut)', () => {
    const net = buildNetworkModel(network());
    expect(net.subnets.get('sn-pub')?.kind).toBe('public');
    expect(net.subnets.get('sn-nat')?.kind).toBe('private-nat');
    expect(net.subnets.get('sn-iso')?.kind).toBe('private-isolated');
    expect(net.subnets.get('sn-iso')?.routeTableId).toBe('rt-main');
    expect(classifyRouteTable({ Routes: [{ DestinationIpv6CidrBlock: '::/0', GatewayId: 'igw-x' }] })).toBe(
      'public',
    );
    expect(classifyRouteTable(undefined)).toBe('private-isolated');
  });

  it('crée les conteneurs Région > VPC > Zone > Sous-réseau', async () => {
    const g = await buildGraph(snap([...network(), ...nodes()]), rules);
    const kinds = Object.fromEntries(g.containers.map((c) => [c.id, c.kind]));
    expect(kinds['subnet:sn-pub']).toBe('subnet-public');
    expect(kinds['subnet:sn-iso']).toBe('subnet-private');
    expect(g.containers.find((c) => c.id === 'subnet:sn-pub')?.parentId).toBe(`az:vpc-1:${R}a`);
    expect(g.containers.find((c) => c.id === `az:vpc-1:${R}a`)?.parentId).toBe('vpc:vpc-1');
    expect(g.containers.find((c) => c.id === 'vpc:vpc-1')?.parentId).toBe(`region:${R}`);
  });
});

describe('inférence des flux (7.2)', () => {
  it('référence de groupe : arêtes fusionnées avec plusieurs ports', async () => {
    const g = await buildGraph(snap([...network(), ...nodes()]), rules);
    const e = edgesBetween(g, 'app', 'db');
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ kind: 'network', label: 'TCP 5432, 5433', state: 'autorise' });
    expect(e[0]?.evidence.join(' ')).toMatch(/sg-db règle entrante depuis sg-app/);
  });

  it('egress bloqué côté source : arête rouge conservée', async () => {
    const g = await buildGraph(snap([...network(), ...nodes()]), rules);
    const e = edgesBetween(g, 'lb', 'app');
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ label: 'TCP 8080', state: 'bloque' });
    expect(e[0]?.evidence.join(' ')).toMatch(/sortante/);
  });

  it('CIDR : 0.0.0.0/0 sur sous-réseau public → depuis l’IGW, sinon depuis Internet', async () => {
    const g = await buildGraph(snap([...network(), ...nodes()]), rules);
    expect(edgesBetween(g, 'IGW', 'lb')[0]?.label).toBe('TCP 443');
    const noIgw = parseRules([
      {
        name: 'x.yaml',
        content: 'type: AWS::EC2::InternetGateway\nlabel: IGW\nicon: igw\ncategory: network\nhidden: true\n',
      },
    ]);
    const merged = { ...rules, byType: new Map([...rules.byType, ...noIgw.byType]) };
    const g2 = await buildGraph(snap([...network(), ...nodes()]), merged);
    expect(edgesBetween(g2, 'Internet', 'lb')[0]?.label).toBe('TCP 443');
  });

  it('CIDR connu : arête depuis le conteneur du sous-réseau propriétaire', async () => {
    const g = await buildGraph(snap([...network(), ...nodes()]), rules);
    const e = g.edges.find((x) => x.source === 'subnet:sn-pub' && x.target === node(g, 'app').id);
    expect(e?.label).toBe('TCP 22');
  });

  it('NACL : un port refusé produit une arête bloquée distincte', async () => {
    const nacl = res('AWS::EC2::NetworkAcl', 'acl-1', {
      Associations: [{ SubnetId: 'sn-iso' }],
      Entries: [
        {
          RuleNumber: 90,
          Protocol: '6',
          RuleAction: 'deny',
          Egress: false,
          CidrBlock: '10.0.1.0/24',
          PortRange: { From: 5432, To: 5432 },
        },
        { RuleNumber: 100, Protocol: '-1', RuleAction: 'allow', Egress: false, CidrBlock: '0.0.0.0/0' },
        { RuleNumber: 100, Protocol: '-1', RuleAction: 'allow', Egress: true, CidrBlock: '0.0.0.0/0' },
      ],
    });
    const g = await buildGraph(snap([...network([nacl]), ...nodes()]), rules);
    const e = edgesBetween(g, 'app', 'db');
    expect(e.map((x) => `${x.label}|${x.state}`).sort()).toEqual(['TCP 5432|bloque', 'TCP 5433|autorise']);
    expect(naclAllows([], false, '10.0.0.0/24', 'tcp', 80)).toBe(false);
  });

  it('sortie vers un service AWS : via NAT, ou via endpoint VPC s’il existe', async () => {
    const g = await buildGraph(snap([...network(), ...nodes()]), rules);
    expect(edgesBetween(g, 'app', 'NAT')[0]?.label).toBe('TCP 443');
    expect(edgesBetween(g, 'NAT', 'secret')[0]?.label).toBe('TCP 443');
    const vpce = res('AWS::EC2::VPCEndpoint', 'vpce-1', {
      VpcId: 'vpc-1',
      ServiceName: `com.amazonaws.${R}.secretsmanager`,
      VpcEndpointType: 'Interface',
    });
    const g2 = await buildGraph(snap([...network([vpce]), ...nodes()]), rules);
    expect(edgesBetween(g2, 'app', 'Endpoint')[0]?.label).toBe('TCP 443');
    expect(edgesBetween(g2, 'app', 'NAT')).toHaveLength(0);
  });
});

describe('flux observés (7.3)', () => {
  it('observé, non expliqué et inutilisé', async () => {
    const g = await buildGraph(
      snap([...network(), ...nodes()], {
        flowObservations: [
          {
            srcIp: '10.0.1.10',
            dstIp: '10.0.2.10',
            dstPort: 5433,
            protocol: '6',
            bytes: 1.2 * 1024 ** 3,
            packets: 10,
          },
          { srcIp: '10.0.2.10', dstIp: '10.0.1.10', dstPort: 9000, protocol: '6', bytes: 10, packets: 1 },
        ],
      }),
      rules,
    );
    const appDb = edgesBetween(g, 'app', 'db')[0];
    expect(appDb?.state).toBe('observe');
    expect(appDb?.evidence).toContain('flow logs : 1,2 Go');
    expect(edgesBetween(g, 'db', 'app')[0]).toMatchObject({ state: 'non-explique', label: 'TCP 9000' });
    expect(edgesBetween(g, 'IGW', 'lb')[0]?.state).toBe('inutilise');
  });
});

describe('regroupement et diff (8)', () => {
  const many = Array.from({ length: 7 }, (_, i) =>
    res('Test::Node', `w${i}`, { Name: `worker-${i}`, SubnetId: 'sn-nat', Sgs: ['sg-app'] }),
  );

  it('regroupe au-delà du seuil et permet de déplier', async () => {
    const g = await buildGraph(snap([...network(), ...nodes(many)]), rules, {}, { groupingThreshold: 5 });
    const group = must(
      g.nodes.find((n) => n.groupCount),
      'groupe',
    );
    expect(group).toMatchObject({ label: '8 × Nœud', groupCount: 8, containerId: 'subnet:sn-nat' });
    expect(g.nodes.some((n) => n.label === 'worker-1')).toBe(false);
    expect(g.edges.some((e) => e.source === group.id && e.target === node(g, 'db').id)).toBe(true);
    const open = await buildGraph(
      snap([...network(), ...nodes(many)]),
      rules,
      {},
      {
        groupingThreshold: 5,
        expandedGroups: [group.id],
      },
    );
    expect(open.nodes.some((n) => n.label === 'worker-1')).toBe(true);
  });

  it('diff : ajoutés, supprimés, modifiés (statut, ports)', async () => {
    const a = await buildGraph(snap([...network(), ...nodes()]), rules);
    const sgDb = must(
      network().find((r) => r.id === 'sg-db'),
      'sg-db',
    );
    const changed = network().map((r) =>
      r.id === 'sg-db'
        ? { ...sgDb, raw: { ...(sgDb.raw as object), IpPermissions: [tcp(5432, { sg: 'sg-app' })] } }
        : r,
    );
    const b = await buildGraph(
      snap([
        ...changed,
        ...nodes([res('Test::Node', 'new', { Name: 'nouveau', SubnetId: 'sn-pub' })]).filter(
          (r) => r.id !== 'lb',
        ),
      ]),
      rules,
    );
    const d = diff(a, b);
    expect(d.nodes.added).toContain(node(b, 'nouveau').id);
    expect(d.nodes.removed).toContain(node(a, 'lb').id);
    const appDb = must(edgesBetween(b, 'app', 'db')[0], 'arête app → db');
    expect(d.edges.modified.find((m) => m.id === appDb.id)?.changes[0]).toMatch(/TCP 5432, 5433 → TCP 5432/);
  });
});
