import {
  APIGatewayClient,
  GetStagesCommand,
  paginateGetResources,
  paginateGetRestApis,
  paginateGetVpcLinks,
} from '@aws-sdk/client-api-gateway';
import {
  ApiGatewayV2Client,
  GetApisCommand,
  GetIntegrationsCommand,
  GetStagesCommand as GetStagesV2Command,
  GetVpcLinksCommand,
} from '@aws-sdk/client-apigatewayv2';
import {
  CloudFrontClient,
  ListTagsForResourceCommand as ListCfTagsCommand,
  paginateListDistributions,
} from '@aws-sdk/client-cloudfront';
import {
  DescribeTagsCommand,
  DescribeTargetHealthCommand,
  ElasticLoadBalancingV2Client,
  paginateDescribeListeners,
  paginateDescribeLoadBalancers,
  paginateDescribeTargetGroups,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import {
  ListResourceRecordSetsCommand,
  paginateListHostedZones,
  type ListResourceRecordSetsCommandOutput,
  Route53Client,
  type ResourceRecordSet,
  type RRType,
} from '@aws-sdk/client-route-53';
import { ListResourcesForWebACLCommand, ListWebACLsCommand, WAFV2Client } from '@aws-sdk/client-wafv2';
import { chunks, collect, resource, tagsOf, type Collector, type CollectorContext } from '../context.ts';

export const elbv2Collector: Collector = {
  service: 'elbv2',
  async collect(ctx) {
    const client = new ElasticLoadBalancingV2Client(ctx.clientConfig);
    const lbs = (await collect(paginateDescribeLoadBalancers({ client }, {}))).flatMap(
      (p) => p.LoadBalancers ?? [],
    );
    const tgs = (await collect(paginateDescribeTargetGroups({ client }, {}))).flatMap(
      (p) => p.TargetGroups ?? [],
    );
    const arns = [...lbs.map((l) => l.LoadBalancerArn), ...tgs.map((t) => t.TargetGroupArn)].filter(
      (a): a is string => !!a,
    );
    const tags = new Map<string, Record<string, string> | undefined>();
    for (const batch of chunks(arns, 20)) {
      const out = await ctx.tryCall('elasticloadbalancing:DescribeTags', () =>
        client.send(new DescribeTagsCommand({ ResourceArns: batch })),
      );
      for (const d of out?.TagDescriptions ?? []) if (d.ResourceArn) tags.set(d.ResourceArn, tagsOf(d.Tags));
    }
    for (const lb of lbs) {
      if (!lb.LoadBalancerArn || !lb.LoadBalancerName) continue;
      const arn = lb.LoadBalancerArn;
      const listeners = await ctx.tryCall('elasticloadbalancing:DescribeListeners', () =>
        collect(paginateDescribeListeners({ client }, { LoadBalancerArn: arn })),
      );
      const raw = { ...lb, _listeners: (listeners ?? []).flatMap((p) => p.Listeners ?? []) };
      ctx.emit(
        resource('AWS::ElasticLoadBalancingV2::LoadBalancer', lb.LoadBalancerName, ctx.region, raw, {
          arn,
          tags: tags.get(arn),
        }),
      );
    }
    for (const tg of tgs) {
      if (!tg.TargetGroupArn || !tg.TargetGroupName) continue;
      const arn = tg.TargetGroupArn;
      const health = await ctx.tryCall('elasticloadbalancing:DescribeTargetHealth', () =>
        client.send(new DescribeTargetHealthCommand({ TargetGroupArn: arn })),
      );
      const raw: Record<string, unknown> = { ...tg, _targets: health?.TargetHealthDescriptions ?? [] };
      if (!health) {
        raw._status = 'inconnu';
        raw._statusReason = 'accès refusé : elasticloadbalancing:DescribeTargetHealth';
      }
      ctx.emit(
        resource('AWS::ElasticLoadBalancingV2::TargetGroup', tg.TargetGroupName, ctx.region, raw, {
          arn,
          tags: tags.get(arn),
        }),
      );
    }
  },
};

export const apigatewayCollector: Collector = {
  service: 'apigateway',
  async collect(ctx) {
    const v1 = new APIGatewayClient(ctx.clientConfig);
    const apis = (await collect(paginateGetRestApis({ client: v1 }, {}))).flatMap((p) => p.items ?? []);
    for (const api of apis) {
      if (!api.id) continue;
      const restApiId = api.id;
      const stages = await ctx.tryCall('apigateway:GET', () => v1.send(new GetStagesCommand({ restApiId })));
      const resources = await ctx.tryCall('apigateway:GET', () =>
        collect(paginateGetResources({ client: v1 }, { restApiId, embed: ['methods'] })),
      );
      const integrations = (resources ?? [])
        .flatMap((p) => p.items ?? [])
        .flatMap((r) =>
          Object.entries(r.resourceMethods ?? {}).map(([method, m]) => ({
            path: r.path,
            httpMethod: method,
            type: m.methodIntegration?.type,
            uri: m.methodIntegration?.uri,
            connectionType: m.methodIntegration?.connectionType,
            connectionId: m.methodIntegration?.connectionId,
          })),
        )
        .filter((i) => i.type);
      const raw = {
        ...api,
        policy: undefined,
        _stages: (stages?.item ?? []).map((s) => ({ stageName: s.stageName, deploymentId: s.deploymentId })),
        _integrations: integrations,
      };
      ctx.emit(
        resource('AWS::ApiGateway::RestApi', restApiId, ctx.region, raw, {
          arn: `arn:${ctx.partition}:apigateway:${ctx.region}::/restapis/${restApiId}`,
          tags: tagsOf(api.tags),
        }),
      );
    }
    const links = (await collect(paginateGetVpcLinks({ client: v1 }, {}))).flatMap((p) => p.items ?? []);
    for (const l of links) {
      if (!l.id) continue;
      ctx.emit(
        resource('AWS::ApiGateway::VpcLink', l.id, ctx.region, l, {
          arn: `arn:${ctx.partition}:apigateway:${ctx.region}::/vpclinks/${l.id}`,
          tags: tagsOf(l.tags),
        }),
      );
    }

    const v2 = new ApiGatewayV2Client(ctx.clientConfig);
    let token: string | undefined;
    do {
      const page = await v2.send(new GetApisCommand({ NextToken: token }));
      for (const api of page.Items ?? []) {
        if (!api.ApiId) continue;
        const ApiId = api.ApiId;
        const integrations = [];
        let it: string | undefined;
        do {
          const p = await ctx.tryCall('apigateway:GET', () =>
            v2.send(new GetIntegrationsCommand({ ApiId, NextToken: it })),
          );
          integrations.push(
            ...(p?.Items ?? []).map((i) => ({
              IntegrationId: i.IntegrationId,
              IntegrationType: i.IntegrationType,
              IntegrationUri: i.IntegrationUri,
              IntegrationMethod: i.IntegrationMethod,
              ConnectionType: i.ConnectionType,
              ConnectionId: i.ConnectionId,
            })),
          );
          it = p?.NextToken;
        } while (it);
        const stages = await ctx.tryCall('apigateway:GET', () => v2.send(new GetStagesV2Command({ ApiId })));
        const raw = {
          ...api,
          _integrations: integrations,
          _stages: (stages?.Items ?? []).map((s) => ({ StageName: s.StageName, AutoDeploy: s.AutoDeploy })),
        };
        ctx.emit(
          resource('AWS::ApiGatewayV2::Api', ApiId, ctx.region, raw, {
            arn: `arn:${ctx.partition}:apigateway:${ctx.region}::/apis/${ApiId}`,
            tags: tagsOf(api.Tags),
          }),
        );
      }
      token = page.NextToken;
    } while (token);

    let lt: string | undefined;
    do {
      const page = await v2.send(new GetVpcLinksCommand({ NextToken: lt }));
      for (const l of page.Items ?? []) {
        if (!l.VpcLinkId) continue;
        ctx.emit(
          resource('AWS::ApiGatewayV2::VpcLink', l.VpcLinkId, ctx.region, l, {
            arn: `arn:${ctx.partition}:apigateway:${ctx.region}::/vpclinks/${l.VpcLinkId}`,
            tags: tagsOf(l.Tags),
          }),
        );
      }
      lt = page.NextToken;
    } while (lt);
  },
};

export const cloudfrontCollector: Collector = {
  service: 'cloudfront',
  global: true,
  async collect(ctx) {
    const client = new CloudFrontClient(ctx.clientConfig);
    const pages = await collect(paginateListDistributions({ client }, {}));
    for (const d of pages.flatMap((p) => p.DistributionList?.Items ?? [])) {
      if (!d.Id || !d.ARN) continue;
      const arn = d.ARN;
      const tags = await ctx.tryCall('cloudfront:ListTagsForResource', () =>
        client.send(new ListCfTagsCommand({ Resource: arn })),
      );
      ctx.emit(
        resource('AWS::CloudFront::Distribution', d.Id, 'global', d, {
          arn,
          tags: tagsOf(tags?.Tags?.Items),
        }),
      );
    }
  },
};

export const route53Collector: Collector = {
  service: 'route53',
  global: true,
  async collect(ctx) {
    const client = new Route53Client(ctx.clientConfig);
    const zones = (await collect(paginateListHostedZones({ client }, {}))).flatMap(
      (p) => p.HostedZones ?? [],
    );
    for (const z of zones) {
      if (!z.Id) continue;
      const zoneId = z.Id.replace('/hostedzone/', '');
      ctx.emit(
        resource('AWS::Route53::HostedZone', zoneId, 'global', z, {
          arn: `arn:${ctx.partition}:route53:::hostedzone/${zoneId}`,
        }),
      );
      const records = await ctx.tryCall('route53:ListResourceRecordSets', async () => {
        const all: ResourceRecordSet[] = [];
        let next: { name?: string; type?: RRType; id?: string } | undefined = {};
        while (next) {
          const page: ListResourceRecordSetsCommandOutput = await client.send(
            new ListResourceRecordSetsCommand({
              HostedZoneId: zoneId,
              StartRecordName: next.name,
              StartRecordType: next.type,
              StartRecordIdentifier: next.id,
            }),
          );
          all.push(...(page.ResourceRecordSets ?? []));
          next = page.IsTruncated
            ? { name: page.NextRecordName, type: page.NextRecordType, id: page.NextRecordIdentifier }
            : undefined;
        }
        return all;
      });
      for (const r of records ?? []) {
        // Seuls les alias et CNAME portent des relations vers d'autres ressources.
        if (!r.Name || !(r.AliasTarget || r.Type === 'CNAME')) continue;
        const id = `${zoneId}/${r.Name}/${r.Type}/${r.SetIdentifier ?? ''}`;
        ctx.emit(resource('AWS::Route53::RecordSet', id, 'global', { ...r, _hostedZoneName: z.Name }));
      }
    }
  },
};

async function collectWebAcls(
  ctx: CollectorContext,
  scope: 'REGIONAL' | 'CLOUDFRONT',
  region: string,
): Promise<void> {
  const client = new WAFV2Client(ctx.clientConfig);
  let marker: string | undefined;
  do {
    const page = await client.send(new ListWebACLsCommand({ Scope: scope, NextMarker: marker, Limit: 100 }));
    for (const acl of page.WebACLs ?? []) {
      if (!acl.ARN || !acl.Id) continue;
      const arn = acl.ARN;
      let protectedArns: string[] = [];
      if (scope === 'REGIONAL') {
        const out = await ctx.tryCall('wafv2:ListResourcesForWebACL', () =>
          client.send(new ListResourcesForWebACLCommand({ WebACLArn: arn })),
        );
        protectedArns = out?.ResourceArns ?? [];
      }
      ctx.emit(
        resource('AWS::WAFv2::WebACL', acl.Id, region, { ...acl, _resources: protectedArns }, { arn }),
      );
    }
    marker = page.NextMarker;
  } while (marker);
}

export const wafCollector: Collector = {
  service: 'waf',
  collect: (ctx) => collectWebAcls(ctx, 'REGIONAL', ctx.region),
};

export const wafGlobalCollector: Collector = {
  service: 'waf',
  global: true,
  collect: (ctx) => collectWebAcls(ctx, 'CLOUDFRONT', 'global'),
};
