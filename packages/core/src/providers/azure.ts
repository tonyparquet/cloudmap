import { cidrContains, isPrivateIpv4, parseCidr } from '../cidr.ts';
import { normProto, type FlowContext, type FlowEdgeRequest, type FlowNode } from '../flows.ts';
import type { NetworkModel, SubnetKind } from '../network.ts';
import type { Resource } from '../schemas.ts';
import { buildAzureOrgGraph } from './azure/org.ts';
import type { NetworkProvider } from './types.ts';

export { buildAzureOrgGraph };

/**
 * Azure : types ARM en minuscules (Resource Graph), identifiants ARM en minuscules (scanner).
 * Réseau : VNet et sous-réseaux (classés public / NAT / isolé), appairages, NSG et ASG ; flux
 * autorisés par les règles NSG personnalisées (règles par défaut ignorées : elles autorisent tout
 * le trafic interne au VNet et rendraient le diagramme illisible).
 */

type Props = Record<string, unknown>;
const props = (r: Resource) => (((r.raw ?? {}) as Props).properties ?? {}) as Props;
const nameOf = (r: Resource) => ((r.raw ?? {}) as Props).name as string | undefined;
const idOf = (v: unknown) => (v as { id?: string } | undefined)?.id?.toLowerCase();
const list = <T>(v: unknown) => (Array.isArray(v) ? (v as T[]) : []);

export interface NsgRule {
  name: string;
  priority: number;
  access: 'Allow' | 'Deny';
  protocol: string;
  sources: string[];
  sourceAsgs: string[];
  destinations: string[];
  destinationAsgs: string[];
  ports: string[];
}

export interface AzureNetworkData {
  /** Règles entrantes personnalisées de chaque NSG, triées par priorité. */
  nsgs: Map<string, { name: string; rules: NsgRule[] }>;
  subnetNsg: Map<string, string>;
}

const T = {
  vnet: 'microsoft.network/virtualnetworks',
  nsg: 'microsoft.network/networksecuritygroups',
  nic: 'microsoft.network/networkinterfaces',
  routes: 'microsoft.network/routetables',
  appgw: 'microsoft.network/applicationgateways',
};

function inboundRules(nsg: Resource): NsgRule[] {
  return list<{ name?: string; properties?: Props }>(props(nsg).securityRules)
    .map((r) => ({ name: r.name ?? '?', p: r.properties ?? {} }))
    .filter(({ p }) => p.direction === 'Inbound')
    .map(({ name, p }) => ({
      name,
      priority: Number(p.priority ?? 4096),
      access: p.access === 'Deny' ? ('Deny' as const) : ('Allow' as const),
      protocol: String(p.protocol ?? '*'),
      sources: [p.sourceAddressPrefix, ...list<string>(p.sourceAddressPrefixes)].filter(Boolean) as string[],
      sourceAsgs: list<unknown>(p.sourceApplicationSecurityGroups).map(idOf).filter(Boolean) as string[],
      destinations: [p.destinationAddressPrefix, ...list<string>(p.destinationAddressPrefixes)].filter(
        Boolean,
      ) as string[],
      destinationAsgs: list<unknown>(p.destinationApplicationSecurityGroups)
        .map(idOf)
        .filter(Boolean) as string[],
      ports: [p.destinationPortRange, ...list<string>(p.destinationPortRanges)].filter(Boolean).map(String),
    }))
    .sort((a, b) => a.priority - b.priority);
}

function extend(model: NetworkModel, resources: Resource[]): void {
  const of = (type: string) => resources.filter((r) => r.type === type);
  // Sous-réseaux exposés : carte réseau avec IP publique, passerelle d'application à frontal public,
  // route 0.0.0.0/0 explicite vers Internet. Sous-réseaux avec passerelle NAT : privés (NAT).
  const publicSubnets = new Set<string>();
  for (const nic of of(T.nic))
    for (const cfg of list<{ properties?: Props }>(props(nic).ipConfigurations)) {
      const c = cfg.properties ?? {};
      const subnet = idOf(c.subnet);
      if (subnet && c.publicIPAddress) publicSubnets.add(subnet);
    }
  for (const gw of of(T.appgw)) {
    const p = props(gw);
    if (list<{ properties?: Props }>(p.frontendIPConfigurations).some((f) => f.properties?.publicIPAddress))
      for (const g of list<{ properties?: Props }>(p.gatewayIPConfigurations)) {
        const subnet = idOf(g.properties?.subnet);
        if (subnet) publicSubnets.add(subnet);
      }
  }
  const internetRoute = new Set<string>();
  for (const rt of of(T.routes)) {
    const p = props(rt);
    const toInternet = list<{ properties?: Props }>(p.routes).some(
      (x) => x.properties?.addressPrefix === '0.0.0.0/0' && x.properties?.nextHopType === 'Internet',
    );
    if (toInternet) for (const s of list<unknown>(p.subnets)) internetRoute.add(idOf(s) ?? '');
  }

  const data: AzureNetworkData = { nsgs: new Map(), subnetNsg: new Map() };
  for (const nsg of of(T.nsg))
    data.nsgs.set(nsg.id, { name: nameOf(nsg) ?? nsg.id, rules: inboundRules(nsg) });

  const pairs = new Set<string>();
  for (const vnet of of(T.vnet)) {
    const p = props(vnet);
    const cidrs = list<string>((p.addressSpace as Props | undefined)?.addressPrefixes);
    let hasNat = false;
    for (const s of list<{ id?: string; name?: string; properties?: Props }>(p.subnets)) {
      const sp = s.properties ?? {};
      const id = s.id?.toLowerCase();
      if (!id) continue;
      const nat = idOf(sp.natGateway);
      if (nat) hasNat = true;
      const kind: SubnetKind = nat
        ? 'private-nat'
        : publicSubnets.has(id) || internetRoute.has(id)
          ? 'public'
          : 'private-isolated';
      const nsg = idOf(sp.networkSecurityGroup);
      if (nsg) data.subnetNsg.set(id, nsg);
      model.subnets.set(id, {
        id,
        vpcId: vnet.id,
        az: 'régional',
        cidr: String(sp.addressPrefix ?? list<string>(sp.addressPrefixes)[0] ?? ''),
        ...(s.name ? { name: s.name } : {}),
        region: vnet.region,
        kind,
      });
    }
    model.vpcs.set(vnet.id, {
      id: vnet.id,
      cidrs,
      ...(nameOf(vnet) ? { name: nameOf(vnet) } : {}),
      region: vnet.region,
      ...(vnet.account ? { account: vnet.account } : {}),
      hasNat,
    });
    for (const peering of list<{ id?: string; properties?: Props }>(p.virtualNetworkPeerings)) {
      const pp = peering.properties ?? {};
      const remote = idOf(pp.remoteVirtualNetwork);
      if (!remote) continue;
      // Chaque côté déclare l'appairage : une seule entrée par paire de VNet.
      const key = [vnet.id, remote].sort().join('|');
      if (pairs.has(key)) continue;
      pairs.add(key);
      model.peerings.push({
        id: peering.id?.toLowerCase() ?? key,
        vpcIds: [vnet.id, remote],
        cidrs: [...cidrs, ...list<string>((pp.remoteAddressSpace as Props | undefined)?.addressPrefixes)],
        active: pp.peeringState === 'Connected',
      });
    }
  }
  model.providerData.set('azure', data);
}

const isAsg = (id: string) => id.includes('/applicationsecuritygroups/');
const isNsg = (id: string) => id.includes('/networksecuritygroups/');
const ANY = new Set(['*', 'internet', '0.0.0.0/0', 'any']);

/**
 * Le préfixe d'une règle couvre-t-il l'adresse ou la plage donnée ? L'étiquette `Internet` désigne
 * l'espace d'adressage public : elle ne couvre pas une adresse privée.
 */
function prefixCovers(prefix: string, target: string): boolean {
  const p = prefix.toLowerCase();
  if (p === '*' || p === 'any' || p === '0.0.0.0/0') return true;
  if (p === 'internet') return !isPrivateIpv4(target.split('/')[0] ?? '');
  const outer = prefix.includes('/') ? prefix : `${prefix}/32`;
  if (!parseCidr(outer)) return false;
  return cidrContains(outer, target.includes('/') ? target : `${target}/32`);
}

/** Source d'un flux, telle qu'une règle NSG la verrait. */
interface Source {
  id: string;
  ips: string[];
  asgs: string[];
  /** « Internet », « VirtualNetwork » ou plage CIDR pour une source qui n'est pas un nœud. */
  tag?: string;
}

function sourceMatches(rule: NsgRule, src: Source, vnetCidrs: string[]): boolean {
  if (rule.sourceAsgs.length) return rule.sourceAsgs.some((a) => src.asgs.includes(a));
  return rule.sources.some((prefix) => {
    const p = prefix.toLowerCase();
    if (p === '*' || p === 'any') return true;
    if (src.tag === 'Internet') return p === 'internet' || p === '0.0.0.0/0';
    if (p === 'virtualnetwork')
      return src.tag === 'VirtualNetwork' || src.ips.some((ip) => vnetCidrs.some((c) => prefixCovers(c, ip)));
    if (src.tag && src.tag !== 'VirtualNetwork') return prefixCovers(prefix, src.tag);
    return src.ips.some((ip) => prefixCovers(prefix, ip));
  });
}

function destMatches(rule: NsgRule, dst: FlowNode, dstAsgs: string[]): boolean {
  if (rule.destinationAsgs.length) return rule.destinationAsgs.some((a) => dstAsgs.includes(a));
  return rule.destinations.some((prefix) => {
    const p = prefix.toLowerCase();
    return (
      p === '*' || p === 'any' || p === 'virtualnetwork' || dst.ips.some((ip) => prefixCovers(prefix, ip))
    );
  });
}

const protoOf = (p: string) => (p === '*' ? 'all' : normProto(p));
const portCovered = (spec: string, port: string) => {
  if (spec === '*' || port === '*') return spec === '*';
  const [a, b] = spec.split('-').map(Number);
  const [c, d] = port.split('-').map(Number);
  return a !== undefined && c !== undefined && c >= a && (d ?? c) <= (b ?? a);
};

/**
 * Flux autorisés vers chaque nœud : règles « Allow » entrantes des NSG de sa carte réseau et de son
 * sous-réseau. Un flux est « bloqué » si une règle « Deny » le couvre : de priorité plus forte dans
 * le même NSG, ou dans l'autre NSG traversé (sous-réseau ↔ carte réseau).
 * ponytail: règles sortantes et règles par défaut non évaluées ; les étiquettes de service autres
 * qu'Internet / VirtualNetwork sont ignorées.
 */
function flows(ctx: FlowContext): FlowEdgeRequest[] {
  const data = ctx.net.providerData.get('azure') as AzureNetworkData | undefined;
  if (!data) return [];
  const out: FlowEdgeRequest[] = [];
  for (const dst of ctx.nodes) {
    const dstAsgs = dst.sgs.filter(isAsg);
    const nsgIds = [
      ...new Set([...dst.sgs.filter(isNsg), ...(dst.subnetId ? [data.subnetNsg.get(dst.subnetId)] : [])]),
    ].filter((x): x is string => !!x && data.nsgs.has(x));
    if (nsgIds.length === 0) continue;
    const vnetCidrs = dst.vpcId ? (ctx.net.vpcs.get(dst.vpcId)?.cidrs ?? []) : [];
    const exposed = dst.subnetId ? ctx.net.subnets.get(dst.subnetId)?.kind === 'public' : false;

    for (const nsgId of nsgIds) {
      const nsg = data.nsgs.get(nsgId);
      if (!nsg) continue;
      for (const rule of nsg.rules) {
        if (rule.access !== 'Allow' || !destMatches(rule, dst, dstAsgs)) continue;
        const sources: { target: string; src: Source }[] = [];
        for (const a of rule.sourceAsgs)
          for (const n of ctx.nodes)
            if (n !== dst && n.sgs.includes(a))
              sources.push({ target: n.id, src: { id: n.id, ips: n.ips, asgs: n.sgs } });
        for (const prefix of rule.sources) {
          const p = prefix.toLowerCase();
          if (ANY.has(p)) {
            if (exposed)
              sources.push({
                target: ctx.internetSource(dst.vpcId),
                src: { id: 'internet', ips: [], asgs: [], tag: 'Internet' },
              });
          } else if (p === 'virtualnetwork') {
            if (dst.vpcId)
              sources.push({
                target: `vpc:${dst.vpcId}`,
                src: { id: 'vnet', ips: [], asgs: [], tag: 'VirtualNetwork' },
              });
          } else if (parseCidr(prefix.includes('/') ? prefix : `${prefix}/32`)) {
            const nodes = ctx.nodes.filter((n) => n !== dst && n.ips.some((ip) => prefixCovers(prefix, ip)));
            for (const n of nodes) sources.push({ target: n.id, src: { id: n.id, ips: n.ips, asgs: n.sgs } });
            const container = nodes.length ? undefined : ctx.cidrSource(prefix, dst.vpcId);
            if (container)
              sources.push({ target: container, src: { id: container, ips: [], asgs: [], tag: prefix } });
          }
        }
        const proto = protoOf(rule.protocol);
        for (const port of rule.ports.length ? rule.ports : ['*']) {
          for (const { target, src } of sources) {
            if (target === dst.id) continue;
            const denied = nsgIds.some((otherId) =>
              (data.nsgs.get(otherId)?.rules ?? []).some(
                (d) =>
                  d.access === 'Deny' &&
                  (otherId !== nsgId || d.priority < rule.priority) &&
                  (protoOf(d.protocol) === 'all' || protoOf(d.protocol) === proto) &&
                  (d.ports.length ? d.ports : ['*']).some((spec) => portCovered(spec, port)) &&
                  destMatches(d, dst, dstAsgs) &&
                  sourceMatches(d, src, vnetCidrs),
              ),
            );
            out.push({
              source: target,
              target: dst.id,
              proto,
              ports: port,
              state: denied ? 'bloque' : 'autorise',
              evidence: [`NSG ${nsg.name} : règle ${rule.name} (priorité ${rule.priority})`],
            });
          }
        }
      }
    }
  }
  return out;
}

/** Azure : types ARM (Resource Graph, en minuscules : `microsoft.network/virtualnetworks`). */
export const azureNetwork: NetworkProvider = {
  id: 'azure',
  owns: (type) => type.toLowerCase().startsWith('microsoft.'),
  extend,
  flows,
};
