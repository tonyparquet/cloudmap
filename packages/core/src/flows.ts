import { cidrContains, cidrOverlaps, isAnyCidr } from './cidr.ts';
import type { IpPermission, NaclEntry, NetworkModel, SecurityGroup } from './network.ts';

/**
 * Inférence des flux réseau autorisés (section 7.2) à partir des groupes de sécurité, des NACL,
 * des tables de routage et des passerelles. Fonctions pures : le graphe fournit les nœuds et
 * la manière de désigner les sources (IGW, nœud Internet, conteneur d'une plage CIDR).
 */

export interface FlowNode {
  id: string;
  /** Type de la ressource (choix du fournisseur qui infère ses flux). */
  type: string;
  label: string;
  sgs: string[];
  ips: string[];
  subnetId?: string;
  vpcId?: string;
}

export interface FlowEdgeRequest {
  source: string;
  target: string;
  proto: string;
  ports: string;
  state: 'autorise' | 'bloque';
  evidence: string[];
}

export interface FlowContext {
  net: NetworkModel;
  nodes: FlowNode[];
  /** Source pour 0.0.0.0/0 : l'IGW du VPC s'il est dessiné, sinon le nœud externe « Internet ». */
  internetSource(vpcId: string | undefined): string;
  /** Source pour une plage CIDR : conteneur (sous-réseau, VPC, VPC appairé) ou nœud externe. */
  cidrSource(cidr: string, vpcId: string | undefined): string | undefined;
}

export function normProto(p: string | undefined): string {
  switch ((p ?? '-1').toLowerCase()) {
    case '-1':
    case 'all':
      return 'all';
    case '6':
    case 'tcp':
      return 'tcp';
    case '17':
    case 'udp':
      return 'udp';
    case '1':
    case 'icmp':
      return 'icmp';
    case '58':
    case 'icmpv6':
      return 'icmpv6';
    default:
      return p ?? 'all';
  }
}

/** Plage de ports d'une permission : [début, fin], ou undefined pour « tous ». */
function permRange(perm: IpPermission): [number, number] | undefined {
  const proto = normProto(perm.IpProtocol);
  if (proto === 'all' || proto.startsWith('icmp')) return undefined;
  const from = perm.FromPort ?? -1;
  const to = perm.ToPort ?? -1;
  if (from < 0 || (from === 0 && to === 65535)) return undefined;
  return [from, to];
}

export function portText(perm: IpPermission): string {
  const r = permRange(perm);
  if (!r) return '*';
  return r[0] === r[1] ? String(r[0]) : `${r[0]}-${r[1]}`;
}

/** Étiquette d'arête : `TCP 5432`, `TCP 443, 8080`, `UDP tous ports`, `Tout trafic`. */
export function flowLabel(proto: string, ports: string[]): string {
  if (proto === 'all') return 'Tout trafic';
  const name = proto.toUpperCase();
  if (proto.startsWith('icmp') || ports.length === 0 || ports.includes('*')) {
    return proto.startsWith('icmp') ? name : `${name} tous ports`;
  }
  const sorted = [...new Set(ports)].sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
  return `${name} ${sorted.join(', ')}`;
}

/** Vrai si `ports` (ex. `443`, `1024-2048`, `*`) couvre le port donné. */
export function portsCover(ports: Iterable<string>, port: number): boolean {
  for (const p of ports) {
    if (p === '*') return true;
    const [a, b] = p.split('-').map(Number);
    if (a !== undefined && port >= a && port <= (b ?? a)) return true;
  }
  return false;
}

function permCovers(perm: IpPermission, proto: string, range: [number, number] | undefined): boolean {
  const p = normProto(perm.IpProtocol);
  if (p !== 'all' && p !== proto) return false;
  const pr = permRange(perm);
  if (!pr) return true;
  if (!range) return false;
  return pr[0] <= range[0] && range[1] <= pr[1];
}

function egressAllowed(
  net: NetworkModel,
  src: FlowNode,
  dstSgs: string[],
  dstCidrs: string[],
  proto: string,
  range: [number, number] | undefined,
): boolean {
  if (src.sgs.length === 0) return true;
  for (const sgId of src.sgs) {
    const sg = net.securityGroups.get(sgId);
    if (!sg) return true; // groupe inconnu (non scanné) : on ne conclut pas au blocage
    for (const perm of sg.IpPermissionsEgress ?? []) {
      if (!permCovers(perm, proto, range)) continue;
      if ((perm.UserIdGroupPairs ?? []).some((p) => p.GroupId && dstSgs.includes(p.GroupId))) return true;
      const cidrs = [
        ...(perm.IpRanges ?? []).map((r) => r.CidrIp),
        ...(perm.Ipv6Ranges ?? []).map((r) => r.CidrIpv6),
      ];
      for (const c of cidrs) {
        if (!c) continue;
        if (isAnyCidr(c) || dstCidrs.some((d) => cidrContains(c, d))) return true;
      }
    }
  }
  return false;
}

/** Évalue une NACL (règles triées, première correspondance, refus implicite). */
export function naclAllows(
  entries: NaclEntry[] | undefined,
  egress: boolean,
  peer: string,
  proto: string,
  port: number | undefined,
): boolean {
  if (!entries) return true;
  const sorted = entries
    .filter((e) => !!e.Egress === egress)
    .sort((a, b) => (a.RuleNumber ?? 0) - (b.RuleNumber ?? 0));
  for (const e of sorted) {
    const p = normProto(e.Protocol);
    if (p !== 'all' && p !== proto) continue;
    if (p !== 'all' && e.PortRange && port !== undefined) {
      if (port < (e.PortRange.From ?? 0) || port > (e.PortRange.To ?? 65535)) continue;
    }
    if (!e.CidrBlock) continue;
    const applies = isAnyCidr(peer) ? isAnyCidr(e.CidrBlock) : cidrOverlaps(e.CidrBlock, peer);
    if (!applies) continue;
    return e.RuleAction === 'allow';
  }
  return false;
}

function sgLabel(sg: SecurityGroup): string {
  return sg.GroupName ? `${sg.GroupId} (${sg.GroupName})` : sg.GroupId;
}

function nodeCidrs(net: NetworkModel, n: FlowNode): string[] {
  const subnet = n.subnetId ? net.subnets.get(n.subnetId) : undefined;
  return [...(subnet?.cidr ? [subnet.cidr] : []), ...n.ips.map((ip) => `${ip}/32`)];
}

/** Raison du blocage d'un flux src → dst (egress du côté source ou NACL), sinon undefined. */
function blockReason(
  net: NetworkModel,
  src: FlowNode,
  dst: FlowNode,
  proto: string,
  range: [number, number] | undefined,
): string | undefined {
  if (!egressAllowed(net, src, dst.sgs, nodeCidrs(net, dst), proto, range)) {
    return `bloqué : aucune règle sortante des groupes de ${src.label} ne l’autorise`;
  }
  const s = src.subnetId ? net.subnets.get(src.subnetId) : undefined;
  const d = dst.subnetId ? net.subnets.get(dst.subnetId) : undefined;
  if (s && d && s.id !== d.id) {
    if (!naclAllows(net.naclEntriesBySubnet.get(s.id), true, d.cidr, proto, range?.[0])) {
      return `bloqué : NACL sortante du sous-réseau ${s.cidr}`;
    }
    if (!naclAllows(net.naclEntriesBySubnet.get(d.id), false, s.cidr, proto, range?.[0])) {
      return `bloqué : NACL entrante du sous-réseau ${d.cidr}`;
    }
  }
  return undefined;
}

export function inferSecurityGroupFlows(ctx: FlowContext): FlowEdgeRequest[] {
  const { net } = ctx;
  const members = new Map<string, FlowNode[]>();
  for (const n of ctx.nodes) for (const sg of n.sgs) members.set(sg, [...(members.get(sg) ?? []), n]);

  const out: FlowEdgeRequest[] = [];
  for (const target of ctx.nodes) {
    const targetSubnet = target.subnetId ? net.subnets.get(target.subnetId) : undefined;
    for (const sgId of target.sgs) {
      const sg = net.securityGroups.get(sgId);
      if (!sg) continue;
      for (const perm of sg.IpPermissions ?? []) {
        const proto = normProto(perm.IpProtocol);
        const range = permRange(perm);
        const ports = portText(perm);
        const rule = `${sgLabel(sg)} règle entrante`;

        for (const pair of perm.UserIdGroupPairs ?? []) {
          for (const src of members.get(pair.GroupId ?? '') ?? []) {
            if (src.id === target.id) continue;
            const blocked = blockReason(net, src, target, proto, range);
            out.push({
              source: src.id,
              target: target.id,
              proto,
              ports,
              state: blocked ? 'bloque' : 'autorise',
              evidence: [`${rule} depuis ${pair.GroupId}`, ...(blocked ? [blocked] : [])],
            });
          }
        }

        const cidrs = [
          ...(perm.IpRanges ?? []).map((r) => r.CidrIp),
          ...(perm.Ipv6Ranges ?? []).map((r) => r.CidrIpv6),
        ].filter((c): c is string => !!c);
        for (const cidr of new Set(cidrs.map((c) => (c === '::/0' ? '0.0.0.0/0' : c)))) {
          let source: string | undefined;
          let peer = cidr;
          if (isAnyCidr(cidr)) {
            // Internet n'atteint la ressource que si elle est dans un sous-réseau public.
            if (targetSubnet?.kind !== 'public') continue;
            source = ctx.internetSource(target.vpcId);
          } else {
            if (cidr.includes(':')) continue; // plages IPv6 spécifiques non représentées
            source = ctx.cidrSource(cidr, target.vpcId);
            peer = cidr;
          }
          if (!source || source === target.id) continue;
          // Le trafic interne au sous-réseau de la cible ne traverse pas sa NACL.
          const naclOk =
            !targetSubnet ||
            cidr === targetSubnet.cidr ||
            naclAllows(net.naclEntriesBySubnet.get(targetSubnet.id), false, peer, proto, range?.[0]);
          out.push({
            source,
            target: target.id,
            proto,
            ports,
            state: naclOk ? 'autorise' : 'bloque',
            evidence: [
              `${rule} depuis ${cidr}`,
              ...(naclOk ? [] : [`bloqué : NACL entrante du sous-réseau ${targetSubnet?.cidr ?? ''}`]),
            ],
          });
        }
      }
    }
  }
  return out;
}

export interface ServiceUse {
  from: FlowNode;
  serviceNode: string;
  awsService: string;
  serviceLabel: string;
}

export interface EgressGateways {
  /** Nœud dessiné d'une ressource passerelle (IGW, NAT, endpoint), s'il existe. */
  nodeOf(resourceArnOrId: string): string | undefined;
}

/**
 * Sorties vers les services AWS (ECR, Secrets Manager, S3…) : via un endpoint VPC s'il existe,
 * sinon l'IGW (sous-réseau public) ou la passerelle NAT (privé avec NAT). Arête TCP 443.
 */
export function inferEgressFlows(
  ctx: FlowContext,
  uses: ServiceUse[],
  gateways: EgressGateways,
): { edges: FlowEdgeRequest[]; warnings: string[] } {
  const { net } = ctx;
  const edges: FlowEdgeRequest[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const use of uses) {
    const key = `${use.from.id}|${use.serviceNode}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const subnet = use.from.subnetId ? net.subnets.get(use.from.subnetId) : undefined;
    if (!subnet) continue;

    const endpoint = net.endpoints.find(
      (e) =>
        e.vpcId === subnet.vpcId &&
        (e.serviceName.endsWith(`.${use.awsService}`) || e.serviceName === use.awsService) &&
        (e.endpointType !== 'Gateway' ||
          (!!subnet.routeTableId && e.routeTableIds.includes(subnet.routeTableId))),
    );
    let via: string | undefined;
    let how = '';
    let dstSgs: string[] = [];
    if (endpoint) {
      via = gateways.nodeOf(endpoint.resource.arn ?? endpoint.resource.id);
      how = `endpoint VPC ${endpoint.resource.id}`;
      const groups = (endpoint.resource.raw as { Groups?: { GroupId?: string }[] }).Groups ?? [];
      dstSgs = groups.map((g) => g.GroupId).filter((g): g is string => !!g);
    } else if (subnet.kind === 'public') {
      const igw = net.igwByVpc.get(subnet.vpcId);
      via = igw ? gateways.nodeOf(igw.arn ?? igw.id) : undefined;
      how = 'passerelle Internet';
    } else if (subnet.kind === 'private-nat') {
      const nat = net.natByVpc.get(subnet.vpcId)?.[0];
      via = nat ? gateways.nodeOf(nat.arn ?? nat.id) : undefined;
      how = 'passerelle NAT';
    }

    const allowed = egressAllowed(net, use.from, dstSgs, ['0.0.0.0/0'], 'tcp', [443, 443]);
    const evidence = [
      `${use.from.label} doit joindre ${use.serviceLabel} (${use.awsService}) via ${how || 'aucune route'}`,
    ];
    if (!allowed)
      evidence.push(`bloqué : aucune règle sortante TCP 443 sur les groupes de ${use.from.label}`);

    if (!via) {
      warnings.push(
        `${use.from.label} ne peut pas joindre ${use.serviceLabel} : sous-réseau ${subnet.cidr} sans endpoint, NAT ni IGW`,
      );
      edges.push({
        source: use.from.id,
        target: use.serviceNode,
        proto: 'tcp',
        ports: '443',
        state: 'bloque',
        evidence,
      });
      continue;
    }
    edges.push({
      source: use.from.id,
      target: via,
      proto: 'tcp',
      ports: '443',
      state: allowed ? 'autorise' : 'bloque',
      evidence,
    });
    edges.push({
      source: via,
      target: use.serviceNode,
      proto: 'tcp',
      ports: '443',
      state: 'autorise',
      evidence: [`sortie vers ${use.awsService} via ${how}`],
    });
  }
  return { edges, warnings };
}
