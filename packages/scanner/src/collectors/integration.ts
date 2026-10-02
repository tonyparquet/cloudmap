import {
  EventBridgeClient,
  ListEventBusesCommand,
  ListRulesCommand,
  ListTagsForResourceCommand as ListEventTagsCommand,
  ListTargetsByRuleCommand,
} from '@aws-sdk/client-eventbridge';
import { DescribeStreamSummaryCommand, KinesisClient, paginateListStreams } from '@aws-sdk/client-kinesis';
import {
  ListTagsForResourceCommand as ListSdTagsCommand,
  paginateListInstances,
  paginateListNamespaces,
  paginateListServices,
  ServiceDiscoveryClient,
} from '@aws-sdk/client-servicediscovery';
import {
  ListTagsForResourceCommand as ListSnsTagsCommand,
  paginateListSubscriptionsByTopic,
  paginateListTopics,
  SNSClient,
} from '@aws-sdk/client-sns';
import {
  GetQueueAttributesCommand,
  ListQueueTagsCommand,
  paginateListQueues,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { collect, resource, tagsOf, type Collector } from '../context.ts';

/** Abonnement SNS sans donnée personnelle : seuls les ARN (SQS, Lambda…) et les hôtes HTTP(S) sont gardés. */
export function sanitizeSubscription(s: { Protocol?: string; Endpoint?: string; SubscriptionArn?: string }) {
  let endpoint: string | undefined;
  if (s.Endpoint?.startsWith('arn:')) endpoint = s.Endpoint;
  else if (s.Protocol === 'http' || s.Protocol === 'https') {
    try {
      endpoint = new URL(s.Endpoint ?? '').origin;
    } catch {
      endpoint = undefined;
    }
  }
  return { Protocol: s.Protocol, ...(endpoint ? { Endpoint: endpoint } : {}) };
}

export const sqsCollector: Collector = {
  service: 'sqs',
  async collect(ctx) {
    const client = new SQSClient(ctx.clientConfig);
    const urls = (await collect(paginateListQueues({ client }, {}))).flatMap((p) => p.QueueUrls ?? []);
    for (const QueueUrl of urls) {
      const name = QueueUrl.split('/').pop() ?? QueueUrl;
      const attrs = await ctx.tryCall('sqs:GetQueueAttributes', () =>
        client.send(new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ['All'] })),
      );
      const tags = await ctx.tryCall('sqs:ListQueueTags', () =>
        client.send(new ListQueueTagsCommand({ QueueUrl })),
      );
      const attributes = { ...(attrs?.Attributes ?? {}) };
      delete attributes.Policy; // politique d'accès : non nécessaire au diagramme
      const arn = attributes.QueueArn;
      ctx.emit(
        resource(
          'AWS::SQS::Queue',
          name,
          ctx.region,
          { QueueUrl, QueueName: name, Attributes: attributes },
          {
            ...(arn ? { arn } : {}),
            tags: tagsOf(tags?.Tags),
          },
        ),
      );
    }
  },
};

export const snsCollector: Collector = {
  service: 'sns',
  async collect(ctx) {
    const client = new SNSClient(ctx.clientConfig);
    const topics = (await collect(paginateListTopics({ client }, {}))).flatMap((p) => p.Topics ?? []);
    for (const t of topics) {
      if (!t.TopicArn) continue;
      const TopicArn = t.TopicArn;
      const subs = await ctx.tryCall('sns:ListSubscriptionsByTopic', () =>
        collect(paginateListSubscriptionsByTopic({ client }, { TopicArn })),
      );
      const tags = await ctx.tryCall('sns:ListTagsForResource', () =>
        client.send(new ListSnsTagsCommand({ ResourceArn: TopicArn })),
      );
      const raw = {
        TopicArn,
        _subscriptions: (subs ?? []).flatMap((p) => p.Subscriptions ?? []).map(sanitizeSubscription),
      };
      ctx.emit(
        resource('AWS::SNS::Topic', TopicArn.split(':').pop() ?? TopicArn, ctx.region, raw, {
          arn: TopicArn,
          tags: tagsOf(tags?.Tags),
        }),
      );
    }
  },
};

export const eventbridgeCollector: Collector = {
  service: 'eventbridge',
  async collect(ctx) {
    const client = new EventBridgeClient(ctx.clientConfig);
    const buses: string[] = [];
    let bt: string | undefined;
    do {
      const page = await client.send(new ListEventBusesCommand({ NextToken: bt }));
      buses.push(...(page.EventBuses ?? []).map((b) => b.Name).filter((n): n is string => !!n));
      bt = page.NextToken;
    } while (bt);
    for (const EventBusName of buses) {
      let rt: string | undefined;
      do {
        const page = await client.send(new ListRulesCommand({ EventBusName, NextToken: rt }));
        for (const rule of page.Rules ?? []) {
          if (!rule.Name || !rule.Arn) continue;
          const Rule = rule.Name;
          const targets = await ctx.tryCall('events:ListTargetsByRule', () =>
            client.send(new ListTargetsByRuleCommand({ Rule, EventBusName })),
          );
          const arn = rule.Arn;
          const tags = await ctx.tryCall('events:ListTagsForResource', () =>
            client.send(new ListEventTagsCommand({ ResourceARN: arn })),
          );
          // Les champs Input / InputTransformer des cibles peuvent contenir des données : non conservés.
          const raw = { ...rule, _targets: (targets?.Targets ?? []).map((x) => ({ Id: x.Id, Arn: x.Arn })) };
          ctx.emit(
            resource('AWS::Events::Rule', `${EventBusName}/${Rule}`, ctx.region, raw, {
              arn,
              tags: tagsOf(tags?.Tags),
            }),
          );
        }
        rt = page.NextToken;
      } while (rt);
    }
  },
};

export const kinesisCollector: Collector = {
  service: 'kinesis',
  async collect(ctx) {
    const client = new KinesisClient(ctx.clientConfig);
    const names = (await collect(paginateListStreams({ client }, {}))).flatMap((p) => p.StreamNames ?? []);
    for (const StreamName of names) {
      const out = await ctx.tryCall('kinesis:DescribeStreamSummary', () =>
        client.send(new DescribeStreamSummaryCommand({ StreamName })),
      );
      const s = out?.StreamDescriptionSummary;
      ctx.emit(
        resource(
          'AWS::Kinesis::Stream',
          StreamName,
          ctx.region,
          s ?? { StreamName },
          s?.StreamARN ? { arn: s.StreamARN } : {},
        ),
      );
    }
  },
};

export const cloudmapCollector: Collector = {
  service: 'cloudmap',
  async collect(ctx) {
    const client = new ServiceDiscoveryClient(ctx.clientConfig);
    const namespaces = (await collect(paginateListNamespaces({ client }, {}))).flatMap(
      (p) => p.Namespaces ?? [],
    );
    for (const ns of namespaces) {
      if (!ns.Id) continue;
      ctx.emit(
        resource('AWS::ServiceDiscovery::Namespace', ns.Id, ctx.region, ns, ns.Arn ? { arn: ns.Arn } : {}),
      );
    }
    const services = (await collect(paginateListServices({ client }, {}))).flatMap((p) => p.Services ?? []);
    for (const svc of services) {
      if (!svc.Id) continue;
      const ServiceId = svc.Id;
      const instances = await ctx.tryCall('servicediscovery:ListInstances', () =>
        collect(paginateListInstances({ client }, { ServiceId })),
      );
      const arn = svc.Arn;
      const tags = arn
        ? await ctx.tryCall('servicediscovery:ListTagsForResource', () =>
            client.send(new ListSdTagsCommand({ ResourceARN: arn })),
          )
        : undefined;
      const raw: Record<string, unknown> = { ...svc };
      if (instances) raw._instanceCount = instances.flatMap((p) => p.Instances ?? []).length;
      else {
        raw._status = 'inconnu';
        raw._statusReason = 'accès refusé : servicediscovery:ListInstances';
      }
      ctx.emit(
        resource('AWS::ServiceDiscovery::Service', ServiceId, ctx.region, raw, {
          ...(arn ? { arn } : {}),
          tags: tagsOf(tags?.Tags),
        }),
      );
    }
  },
};
