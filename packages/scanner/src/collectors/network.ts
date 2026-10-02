import {
  EC2Client,
  paginateDescribeInstances,
  paginateDescribeInternetGateways,
  paginateDescribeNatGateways,
  paginateDescribeNetworkAcls,
  paginateDescribeNetworkInterfaces,
  paginateDescribeRouteTables,
  paginateDescribeSecurityGroups,
  paginateDescribeSubnets,
  paginateDescribeTransitGatewayAttachments,
  paginateDescribeVpcEndpoints,
  paginateDescribeVpcPeeringConnections,
  paginateDescribeVpcs,
} from '@aws-sdk/client-ec2';
import { collect, ec2Arn, resource, tagsOf, type Collector, type CollectorContext } from '../context.ts';

type Tagged = { Tags?: { Key?: string; Value?: string }[] };

/** Émet chaque élément d'une liste EC2 avec ARN construit et tags normalisés. */
function emitAll<T extends Tagged>(
  ctx: CollectorContext,
  type: string,
  arnKind: string,
  items: T[],
  idOf: (item: T) => string | undefined,
): void {
  for (const item of items) {
    const id = idOf(item);
    if (!id) continue;
    ctx.emit(
      resource(type, id, ctx.region, item, {
        arn: ec2Arn(ctx, arnKind, id),
        tags: tagsOf(item.Tags),
      }),
    );
  }
}

export const networkCollector: Collector = {
  service: 'network',
  async collect(ctx) {
    const client = new EC2Client(ctx.clientConfig);
    const c = { client };
    const vpcs = (await collect(paginateDescribeVpcs(c, {}))).flatMap((p) => p.Vpcs ?? []);
    emitAll(ctx, 'AWS::EC2::VPC', 'vpc', vpcs, (x) => x.VpcId);
    const subnets = (await collect(paginateDescribeSubnets(c, {}))).flatMap((p) => p.Subnets ?? []);
    emitAll(ctx, 'AWS::EC2::Subnet', 'subnet', subnets, (x) => x.SubnetId);
    const rts = (await collect(paginateDescribeRouteTables(c, {}))).flatMap((p) => p.RouteTables ?? []);
    emitAll(ctx, 'AWS::EC2::RouteTable', 'route-table', rts, (x) => x.RouteTableId);
    const igws = (await collect(paginateDescribeInternetGateways(c, {}))).flatMap(
      (p) => p.InternetGateways ?? [],
    );
    emitAll(ctx, 'AWS::EC2::InternetGateway', 'internet-gateway', igws, (x) => x.InternetGatewayId);
    const nats = (await collect(paginateDescribeNatGateways(c, {}))).flatMap((p) => p.NatGateways ?? []);
    emitAll(ctx, 'AWS::EC2::NatGateway', 'natgateway', nats, (x) => x.NatGatewayId);
    const vpces = (await collect(paginateDescribeVpcEndpoints(c, {}))).flatMap((p) => p.VpcEndpoints ?? []);
    emitAll(ctx, 'AWS::EC2::VPCEndpoint', 'vpc-endpoint', vpces, (x) => x.VpcEndpointId);
    const sgs = (await collect(paginateDescribeSecurityGroups(c, {}))).flatMap((p) => p.SecurityGroups ?? []);
    emitAll(ctx, 'AWS::EC2::SecurityGroup', 'security-group', sgs, (x) => x.GroupId);
    const acls = (await collect(paginateDescribeNetworkAcls(c, {}))).flatMap((p) => p.NetworkAcls ?? []);
    emitAll(ctx, 'AWS::EC2::NetworkAcl', 'network-acl', acls, (x) => x.NetworkAclId);
    const enis = (await collect(paginateDescribeNetworkInterfaces(c, {}))).flatMap(
      (p) => p.NetworkInterfaces ?? [],
    );
    emitAll(
      ctx,
      'AWS::EC2::NetworkInterface',
      'network-interface',
      enis.map((e) => ({ ...e, Tags: e.TagSet })),
      (x) => x.NetworkInterfaceId,
    );
    const peerings = (await collect(paginateDescribeVpcPeeringConnections(c, {}))).flatMap(
      (p) => p.VpcPeeringConnections ?? [],
    );
    emitAll(
      ctx,
      'AWS::EC2::VPCPeeringConnection',
      'vpc-peering-connection',
      peerings,
      (x) => x.VpcPeeringConnectionId,
    );
    const tgwa = await ctx.tryCall('ec2:DescribeTransitGatewayAttachments', () =>
      collect(paginateDescribeTransitGatewayAttachments(c, {})),
    );
    emitAll(
      ctx,
      'AWS::EC2::TransitGatewayAttachment',
      'transit-gateway-attachment',
      (tgwa ?? []).flatMap((p) => p.TransitGatewayAttachments ?? []),
      (x) => x.TransitGatewayAttachmentId,
    );
  },
};

export const ec2Collector: Collector = {
  service: 'ec2',
  async collect(ctx) {
    const client = new EC2Client(ctx.clientConfig);
    const pages = await collect(paginateDescribeInstances({ client }, {}));
    const instances = pages.flatMap((p) => p.Reservations ?? []).flatMap((r) => r.Instances ?? []);
    // Les données utilisateur (UserData) ne sont pas retournées par DescribeInstances.
    emitAll(ctx, 'AWS::EC2::Instance', 'instance', instances, (x) => x.InstanceId);
  },
};
