import { cidrContains, isAnyCidr, isPrivateIpv4 } from '../cidr.ts';
import { normProto, type FlowContext, type FlowEdgeRequest, type FlowNode } from '../flows.ts';
import type { NetworkModel, SubnetKind } from '../network.ts';
import type { Resource } from '../schemas.ts';
import { buildGcpOrgGraph } from './gcp/org.ts';
import type { NetworkProvider } from './types.ts';

export { buildGcpOrgGraph };

/**
 * Google Cloud : types Cloud Asset Inventory (`compute.googleapis.com/Instance`), identifiant = nom
 * d'actif (`//compute.googleapis.com/projects/p/zones/z/instances/i`). Le scanner convertit toutes les
 * références (selfLink, chemins `projects/…`) en noms d'actifs : le modèle les compare telles quelles.
 */
const T = {
  network: 'compute.googleapis.com/Network',
  subnet: 'compute.googleapis.com/Subnetwork',
  firewall: 'compute.googleapis.com/Firewall',
  router: 'compute.googleapis.com/Router',
  instance: 'compute.googleapis.com/Instance',
  cluster: 'container.googleapis.com/Cluster',
  forwarding: ['compute.googleapis.com/ForwardingRule', 'compute.googleapis.com/GlobalForwardingRule'],
};

type Raw = Record<string, unknown>;
const raw = (r: Resource) => (r.raw ?? {}) as Raw;
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const arr = <X = Raw>(v: unknown) => (Array.isArray(v) ? (v as X[]) : []);
const strs = (v: unknown) => arr<unknown>(v).filter((x): x is string => typeof x === 'string');
const link = str;

interface PortRule {
  proto: string;
  /** Plages de ports (`443`, `8000-8080`) ; vide : tous les ports. */
  ports: string[];
}

export interface GcpFirewall {
  id: string;
  name: string;
  network: string;
  priority: number;
  direction: 'INGRESS' | 'EGRESS';
  action: 'allow' | 'deny';
  rules: PortRule[];
  sourceRanges: string[];
  destinationRanges: string[];
  sourceTags: string[];
  targetTags: string[];
  sourceServiceAccounts: string[];
  targetServiceAccounts: string[];
}

interface GcpData {
  firewalls: GcpFirewall[];
  /** Ressources par nom d'actif (nœuds du diagramme, pour les flux d'équilibreurs). */
  byId: Map<string, Resource>;
  /** Sous-réseau → routeur Cloud NAT qui le couvre. */
  natBySubnet: Map<string, string>;
}

function firewallOf(r: Resource): GcpFirewall | undefined {
  const x = raw(r);
  if (x.disabled === true) return undefined;
  const allowed = arr(x.allowed);
  const denied = arr(x.denied);
  return {
    id: r.id,
    name: str(x.name) ?? r.id,
    network: link(x.network) ?? '',
    priority: typeof x.priority === 'number' ? x.priority : 1000,
    direction: x.direction === 'EGRESS' ? 'EGRESS' : 'INGRESS',
    action: denied.length && !allowed.length ? 'deny' : 'allow',
    rules: (allowed.length ? allowed : denied).map((p) => ({
      proto: normProto(str(p.IPProtocol)),
      ports: strs(p.ports),
    })),
    sourceRanges: strs(x.sourceRanges),
    destinationRanges: strs(x.destinationRanges),
    sourceTags: strs(x.sourceTags),
    targetTags: strs(x.targetTags),
    sourceServiceAccounts: strs(x.sourceServiceAccounts),
    targetServiceAccounts: strs(x.targetServiceAccounts),
  };
}

/** Sous-réseaux couverts par Cloud NAT (→ routeur) : routeur de la même région et du même réseau. */
function natSubnets(resources: Resource[], subnets: Resource[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const router of resources.filter((r) => r.type === T.router)) {
    const rx = raw(router);
    for (const nat of arr(rx.nats)) {
      if (nat.sourceSubnetworkIpRangesToNat === 'LIST_OF_SUBNETWORKS') {
        for (const s of arr(nat.subnetworks)) {
          const name = link(s.name);
          if (name) out.set(name, router.id);
        }
      } else {
        for (const s of subnets)
          if (s.region === router.region && link(raw(s).network) === link(rx.network))
            out.set(s.id, router.id);
      }
    }
  }
  return out;
}

export const gcpNetwork: NetworkProvider = {
  id: 'gcp',
  owns: (type) => /\.googleapis\.com\//.test(type),

  extend(model: NetworkModel, resources: Resource[]) {
    const subnets = resources.filter((r) => r.type === T.subnet);
    const nat = natSubnets(resources, subnets);
    // Sous-réseau public : une instance y a une IP externe (le reste du trafic sortant passe par Cloud NAT).
    const publicSubnets = new Set<string>();
    for (const i of resources.filter((r) => r.type === T.instance)) {
      for (const nic of arr(raw(i).networkInterfaces)) {
        const s = link(nic.subnetwork);
        if (s && arr(nic.accessConfigs).some((a) => str(a.natIP))) publicSubnets.add(s);
      }
    }
    const routersWithNat = new Set(
      resources
        .filter((r) => r.type === T.router && arr(raw(r).nats).length > 0)
        .map((r) => link(raw(r).network)),
    );

    for (const n of resources.filter((r) => r.type === T.network)) {
      const cidrs = subnets
        .filter((s) => link(raw(s).network) === n.id)
        .map((s) => str(raw(s).ipCidrRange))
        .filter((c): c is string => !!c);
      model.vpcs.set(n.id, {
        id: n.id,
        cidrs,
        name: str(raw(n).name) ?? n.id,
        region: 'global',
        ...(n.account ? { account: n.account } : {}),
        hasNat: routersWithNat.has(n.id),
      });
      // Appairages : un par paire de réseaux (chaque côté le déclare).
      for (const p of arr(raw(n).peerings)) {
        const other = link(p.network);
        if (!other) continue;
        const id = [n.id, other].sort().join('↔');
        if (model.peerings.some((x) => x.id === id)) continue;
        model.peerings.push({ id, vpcIds: [n.id, other], cidrs: [], active: p.state === 'ACTIVE' });
      }
    }
    for (const s of subnets) {
      const x = raw(s);
      const kind: SubnetKind = publicSubnets.has(s.id)
        ? 'public'
        : nat.has(s.id)
          ? 'private-nat'
          : 'private-isolated';
      model.subnets.set(s.id, {
        id: s.id,
        vpcId: link(x.network) ?? '',
        az: s.region,
        cidr: str(x.ipCidrRange) ?? '',
        name: str(x.name) ?? s.id,
        region: s.region,
        kind,
      });
    }
    const data: GcpData = {
      firewalls: resources
        .filter((r) => r.type === T.firewall)
        .map(firewallOf)
        .filter((f): f is GcpFirewall => !!f)
        .sort((a, b) => a.priority - b.priority),
      byId: new Map(resources.map((r) => [r.id, r])),
      natBySubnet: nat,
    };
    model.providerData.set('gcp', data);
  },

  flows(ctx: FlowContext) {
    const data = ctx.net.providerData.get('gcp') as GcpData | undefined;
    return data ? gcpFlows(ctx, data) : [];
  },
};

// ------------------------------------------------------------------ pare-feu VPC

const tagsOf = (n: FlowNode) => n.sgs.filter((s) => s.startsWith('tag:')).map((s) => s.slice(4));
const accountsOf = (n: FlowNode) => n.sgs.filter((s) => s.startsWith('sa:')).map((s) => s.slice(3));

/** Le pare-feu VPC ne filtre que les VM (instances, nœuds GKE). */
const VM_TYPES = new Set([T.instance, T.cluster]);

/** La règle s'applique-t-elle à ce nœud (cibles : comptes de service, tags réseau, ou toutes les instances) ? */
function appliesTo(fw: GcpFirewall, n: FlowNode): boolean {
  if (!VM_TYPES.has(n.type)) return false;
  if (fw.targetServiceAccounts.length)
    return fw.targetServiceAccounts.some((sa) => accountsOf(n).includes(sa));
  if (fw.targetTags.length) return fw.targetTags.some((t) => tagsOf(n).includes(t));
  return true;
}

/** Source désignée par tag réseau ou compte de service (le même réseau uniquement, comme GCP). */
function sourceIsNode(fw: GcpFirewall, src: FlowNode): string | undefined {
  const sa = fw.sourceServiceAccounts.find((s) => accountsOf(src).includes(s));
  if (sa) return `compte de service ${sa}`;
  const tag = fw.sourceTags.find((t) => tagsOf(src).includes(t));
  return tag ? `tag ${tag}` : undefined;
}

const rangeOf = (p: string): [number, number] | undefined => {
  if (!p) return undefined;
  const [a, b] = p.split('-').map(Number);
  return a === undefined || Number.isNaN(a) ? undefined : [a, b ?? a];
};

/** La règle de refus couvre-t-elle entièrement ce protocole et cette plage de ports ? */
function covers(deny: GcpFirewall, proto: string, port: string): boolean {
  return deny.rules.some((r) => {
    if (r.proto !== 'all' && r.proto !== proto) return false;
    if (!r.ports.length) return true;
    const want = rangeOf(port);
    return (
      !!want &&
      r.ports.some((p) => {
        const have = rangeOf(p);
        return !!have && have[0] <= want[0] && want[1] <= have[1];
      })
    );
  });
}

const fwLabel = (fw: GcpFirewall) => `pare-feu ${fw.name} (priorité ${fw.priority})`;

/**
 * Flux autorisés par les règles de pare-feu VPC : priorité (la plus basse l'emporte, refus prioritaire à
 * égalité), cibles par tags réseau ou comptes de service, sources par tags / comptes de service (nœuds)
 * ou plages (Internet, sous-réseau, VPC, plage externe). Entrée refusée et sortie autorisée par défaut.
 * Un flux autorisé mais masqué par une règle de refus plus prioritaire est marqué « bloqué ».
 */
function gcpFlows(ctx: FlowContext, data: GcpData): FlowEdgeRequest[] {
  const out: FlowEdgeRequest[] = [];
  const byNetwork = new Map<string, FlowNode[]>();
  for (const n of ctx.nodes) if (n.vpcId) byNetwork.set(n.vpcId, [...(byNetwork.get(n.vpcId) ?? []), n]);

  for (const target of ctx.nodes) {
    const network = target.vpcId;
    if (!network) continue;
    const rules = data.firewalls.filter(
      (f) => f.network === network && f.direction === 'INGRESS' && appliesTo(f, target),
    );
    const denies = rules.filter((f) => f.action === 'deny');
    const publicIp = target.ips.some((ip) => !isPrivateIpv4(ip));

    for (const allow of rules.filter((f) => f.action === 'allow')) {
      /** Arête par protocole et plage de ports ; bloquée si un refus prioritaire couvre ce trafic depuis cette source. */
      const push = (source: string, from: string, deniedFor: (d: GcpFirewall) => boolean) => {
        for (const r of allow.rules) {
          for (const port of r.ports.length ? r.ports : ['*']) {
            const deny = denies.find(
              (d) => d.priority <= allow.priority && covers(d, r.proto, port) && deniedFor(d),
            );
            out.push({
              source,
              target: target.id,
              proto: r.proto,
              ports: port,
              state: deny ? 'bloque' : 'autorise',
              evidence: [`${fwLabel(allow)} depuis ${from}`, ...(deny ? [`bloqué : ${fwLabel(deny)}`] : [])],
            });
          }
        }
      };

      // Sources nœuds : tags réseau et comptes de service du même réseau.
      for (const src of byNetwork.get(network) ?? []) {
        if (src.id === target.id) continue;
        const from = sourceIsNode(allow, src);
        if (!from) continue;
        push(
          src.id,
          from,
          (d) =>
            !!sourceIsNode(d, src) || d.sourceRanges.some((c) => src.ips.some((ip) => cidrContains(c, ip))),
        );
      }

      // Sources plages ; aucune source déclarée : 0.0.0.0/0.
      const ranges =
        allow.sourceRanges.length || allow.sourceTags.length || allow.sourceServiceAccounts.length
          ? allow.sourceRanges
          : ['0.0.0.0/0'];
      for (const range of ranges) {
        let source: string | undefined;
        if (isAnyCidr(range)) {
          if (!publicIp) continue; // Internet n'atteint que les ressources dotées d'une IP externe.
          source = ctx.internetSource(network);
        } else {
          if (range.includes(':')) continue;
          source = ctx.cidrSource(range, network);
        }
        if (!source || source === target.id) continue;
        push(source, range, (d) => d.sourceRanges.some((c) => isAnyCidr(c) || cidrContains(c, range)));
      }
    }
  }

  // Sortie Internet des VM sans IP externe par Cloud NAT (sortie autorisée par défaut).
  for (const n of ctx.nodes) {
    const router = n.subnetId ? data.natBySubnet.get(n.subnetId) : undefined;
    if (!router || !VM_TYPES.has(n.type) || n.ips.some((ip) => !isPrivateIpv4(ip))) continue;
    const res = data.byId.get(router);
    const name = res ? str(raw(res).name) : undefined;
    out.push({
      source: n.id,
      target: router,
      proto: 'all',
      ports: '*',
      state: 'autorise',
      evidence: [`sortie Internet par Cloud NAT ${name ?? router}`],
    });
  }

  // Équilibreurs externes : Internet → règle de transfert (les frontaux Google ne passent pas par le pare-feu VPC).
  for (const n of ctx.nodes) {
    const r = data.byId.get(n.id.split('@')[0] ?? n.id);
    if (!r || !T.forwarding.includes(r.type)) continue;
    const x = raw(r);
    if (!str(x.loadBalancingScheme)?.startsWith('EXTERNAL')) continue;
    const range = str(x.portRange) ?? '';
    const [a, b] = range.split('-');
    out.push({
      source: ctx.internetSource(undefined),
      target: n.id,
      proto: normProto(str(x.IPProtocol) ?? 'tcp'),
      ports: !a ? '*' : a === b || !b ? a : `${a}-${b}`,
      state: 'autorise',
      evidence: [`règle de transfert externe ${str(x.name) ?? r.id} (${str(x.IPAddress) ?? 'IP externe'})`],
    });
  }
  return out;
}
