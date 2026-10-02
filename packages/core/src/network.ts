import type { Resource } from './schemas.ts';

/**
 * Modèle réseau EC2 (VPC, sous-réseaux, tables de routage, groupes de sécurité, NACL, passerelles).
 * Ces primitives réseau sont nécessairement connues ici : elles servent à construire les conteneurs
 * et à inférer les flux (section 7). Les formes suivent les réponses du SDK EC2 v3.
 */

export interface Tag {
  Key?: string;
  Value?: string;
}
export interface IpPermission {
  IpProtocol?: string;
  FromPort?: number;
  ToPort?: number;
  IpRanges?: { CidrIp?: string }[];
  Ipv6Ranges?: { CidrIpv6?: string }[];
  UserIdGroupPairs?: { GroupId?: string }[];
  PrefixListIds?: { PrefixListId?: string }[];
}
export interface SecurityGroup {
  GroupId: string;
  GroupName?: string;
  VpcId?: string;
  IpPermissions?: IpPermission[];
  IpPermissionsEgress?: IpPermission[];
}
export interface NaclEntry {
  RuleNumber?: number;
  Protocol?: string;
  RuleAction?: string;
  Egress?: boolean;
  CidrBlock?: string;
  PortRange?: { From?: number; To?: number };
}
interface RouteTable {
  RouteTableId?: string;
  VpcId?: string;
  Associations?: { Main?: boolean; SubnetId?: string }[];
  Routes?: {
    DestinationCidrBlock?: string;
    DestinationIpv6CidrBlock?: string;
    GatewayId?: string;
    NatGatewayId?: string;
  }[];
}

export type SubnetKind = 'public' | 'private-nat' | 'private-isolated';

export interface SubnetInfo {
  id: string;
  vpcId: string;
  az: string;
  cidr: string;
  name?: string;
  region: string;
  kind: SubnetKind;
  routeTableId?: string;
}
export interface VpcInfo {
  id: string;
  cidrs: string[];
  name?: string;
  region: string;
  hasNat: boolean;
}
export interface EndpointInfo {
  resource: Resource;
  vpcId: string;
  serviceName: string;
  endpointType: string;
  routeTableIds: string[];
}
export interface PeeringInfo {
  id: string;
  vpcIds: string[];
  cidrs: string[];
}

export interface NetworkModel {
  vpcs: Map<string, VpcInfo>;
  subnets: Map<string, SubnetInfo>;
  securityGroups: Map<string, SecurityGroup>;
  naclEntriesBySubnet: Map<string, NaclEntry[]>;
  igwByVpc: Map<string, Resource>;
  natByVpc: Map<string, Resource[]>;
  endpoints: EndpointInfo[];
  peerings: PeeringInfo[];
}

const obj = (r: Resource) => (r.raw ?? {}) as Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

export function nameTag(r: Resource): string | undefined {
  if (r.tags?.Name) return r.tags.Name;
  const tags = obj(r).Tags;
  return Array.isArray(tags) ? (tags as Tag[]).find((t) => t.Key === 'Name')?.Value : undefined;
}

/** Classification 7.1 : route par défaut vers igw-* → public, vers nat-* → privé avec NAT, sinon isolé. */
export function classifyRouteTable(rt: RouteTable | undefined): SubnetKind {
  const defaults = (rt?.Routes ?? []).filter(
    (r) => r.DestinationCidrBlock === '0.0.0.0/0' || r.DestinationIpv6CidrBlock === '::/0',
  );
  if (defaults.some((r) => r.GatewayId?.startsWith('igw-'))) return 'public';
  if (defaults.some((r) => r.NatGatewayId?.startsWith('nat-'))) return 'private-nat';
  return 'private-isolated';
}

export function buildNetworkModel(resources: Resource[]): NetworkModel {
  const of = (type: string) => resources.filter((r) => r.type === type);
  const model: NetworkModel = {
    vpcs: new Map(),
    subnets: new Map(),
    securityGroups: new Map(),
    naclEntriesBySubnet: new Map(),
    igwByVpc: new Map(),
    natByVpc: new Map(),
    endpoints: [],
    peerings: [],
  };

  for (const r of of('AWS::EC2::NatGateway')) {
    const vpcId = str(obj(r).VpcId);
    const state = str(obj(r).State);
    if (vpcId && state !== 'deleted' && state !== 'failed') {
      model.natByVpc.set(vpcId, [...(model.natByVpc.get(vpcId) ?? []), r]);
    }
  }
  for (const r of of('AWS::EC2::VPC')) {
    const raw = obj(r);
    const assoc = (raw.CidrBlockAssociationSet as { CidrBlock?: string }[] | undefined) ?? [];
    const cidrs = [
      ...new Set([str(raw.CidrBlock), ...assoc.map((a) => a.CidrBlock)].filter(Boolean)),
    ] as string[];
    model.vpcs.set(r.id, {
      id: r.id,
      cidrs,
      name: nameTag(r),
      region: r.region,
      hasNat: model.natByVpc.has(r.id),
    });
  }

  const routeTables = of('AWS::EC2::RouteTable').map((r) => r.raw as RouteTable);
  const explicit = new Map<string, RouteTable>();
  const main = new Map<string, RouteTable>();
  for (const rt of routeTables) {
    for (const a of rt.Associations ?? []) {
      if (a.SubnetId) explicit.set(a.SubnetId, rt);
      if (a.Main && rt.VpcId) main.set(rt.VpcId, rt);
    }
  }
  for (const r of of('AWS::EC2::Subnet')) {
    const raw = obj(r);
    const vpcId = str(raw.VpcId) ?? '';
    const rt = explicit.get(r.id) ?? main.get(vpcId);
    model.subnets.set(r.id, {
      id: r.id,
      vpcId,
      az: str(raw.AvailabilityZone) ?? 'inconnue',
      cidr: str(raw.CidrBlock) ?? '',
      name: nameTag(r),
      region: r.region,
      kind: classifyRouteTable(rt),
      routeTableId: rt?.RouteTableId,
    });
  }

  for (const r of of('AWS::EC2::SecurityGroup')) {
    const sg = r.raw as SecurityGroup;
    model.securityGroups.set(sg.GroupId ?? r.id, { ...sg, GroupId: sg.GroupId ?? r.id });
  }
  for (const r of of('AWS::EC2::NetworkAcl')) {
    const raw = obj(r);
    const entries = (raw.Entries as NaclEntry[] | undefined) ?? [];
    for (const a of (raw.Associations as { SubnetId?: string }[] | undefined) ?? []) {
      if (a.SubnetId) model.naclEntriesBySubnet.set(a.SubnetId, entries);
    }
  }
  for (const r of of('AWS::EC2::InternetGateway')) {
    for (const a of (obj(r).Attachments as { VpcId?: string }[] | undefined) ?? []) {
      if (a.VpcId) model.igwByVpc.set(a.VpcId, r);
    }
  }
  for (const r of of('AWS::EC2::VPCEndpoint')) {
    const raw = obj(r);
    model.endpoints.push({
      resource: r,
      vpcId: str(raw.VpcId) ?? '',
      serviceName: str(raw.ServiceName) ?? '',
      endpointType: str(raw.VpcEndpointType) ?? 'Interface',
      routeTableIds: (raw.RouteTableIds as string[] | undefined) ?? [],
    });
  }
  for (const r of of('AWS::EC2::VPCPeeringConnection')) {
    const raw = obj(r);
    const sides = [raw.AccepterVpcInfo, raw.RequesterVpcInfo] as (
      { VpcId?: string; CidrBlock?: string } | undefined
    )[];
    model.peerings.push({
      id: r.id,
      vpcIds: sides.map((s) => s?.VpcId).filter(Boolean) as string[],
      cidrs: sides.map((s) => s?.CidrBlock).filter(Boolean) as string[],
    });
  }
  return model;
}
