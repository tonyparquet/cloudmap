import { CloudWatchClient, GetMetricDataCommand, type MetricDataQuery } from '@aws-sdk/client-cloudwatch';
import {
  CloudWatchLogsClient,
  GetQueryResultsCommand,
  StartQueryCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import { EC2Client, paginateDescribeFlowLogs } from '@aws-sdk/client-ec2';
import type { RawSnapshot, Resource } from '@carto/core';
import { chunks, collect, type CollectorContext } from './context.ts';

type Metric = NonNullable<RawSnapshot['metrics']>[number];
type FlowObservation = NonNullable<RawSnapshot['flowObservations']>[number];

/** Métriques clés (dernière heure) utilisables par les règles de statut : `$all.metrics[resourceId = $r.id]`. */
export async function collectMetrics(ctx: CollectorContext, resources: Resource[]): Promise<Metric[]> {
  const queries: { query: MetricDataQuery; resourceId: string; name: string }[] = [];
  const add = (resourceId: string, namespace: string, metric: string, dims: Record<string, string>) => {
    queries.push({
      resourceId,
      name: metric,
      query: {
        Id: `m${queries.length}`,
        MetricStat: {
          Metric: {
            Namespace: namespace,
            MetricName: metric,
            Dimensions: Object.entries(dims).map(([Name, Value]) => ({ Name, Value })),
          },
          Period: 3600,
          Stat: 'Sum',
        },
      },
    });
  };
  for (const r of resources) {
    if (r.region !== ctx.region) continue;
    if (r.type === 'AWS::Lambda::Function') {
      add(r.id, 'AWS/Lambda', 'Invocations', { FunctionName: r.id });
      add(r.id, 'AWS/Lambda', 'Errors', { FunctionName: r.id });
    } else if (
      r.type === 'AWS::ElasticLoadBalancingV2::LoadBalancer' &&
      r.arn?.includes(':loadbalancer/app/')
    ) {
      const dim = r.arn.split(':loadbalancer/')[1] ?? '';
      add(r.id, 'AWS/ApplicationELB', 'RequestCount', { LoadBalancer: dim });
      add(r.id, 'AWS/ApplicationELB', 'HTTPCode_Target_5XX_Count', { LoadBalancer: dim });
    } else if (r.type === 'AWS::ApiGatewayV2::Api') {
      add(r.id, 'AWS/ApiGateway', 'Count', { ApiId: r.id });
      add(r.id, 'AWS/ApiGateway', '5xx', { ApiId: r.id });
    }
  }
  if (queries.length === 0) return [];
  const client = new CloudWatchClient(ctx.clientConfig);
  const end = new Date();
  const start = new Date(end.getTime() - 3600_000);
  const out: Metric[] = [];
  for (const batch of chunks(queries, 500)) {
    const res = await client.send(
      new GetMetricDataCommand({
        MetricDataQueries: batch.map((q) => q.query),
        StartTime: start,
        EndTime: end,
      }),
    );
    for (const r of res.MetricDataResults ?? []) {
      const q = batch.find((x) => x.query.Id === r.Id);
      if (q)
        out.push({
          resourceId: q.resourceId,
          name: q.name,
          value: (r.Values ?? []).reduce((a, b) => a + b, 0),
          period: 'PT1H',
        });
    }
  }
  return out;
}

const FLOW_QUERY = [
  'fields srcAddr, dstAddr, dstPort, protocol, bytes, packets',
  "| filter action = 'ACCEPT'",
  '| stats sum(bytes) as totalBytes, sum(packets) as totalPackets by srcAddr, dstAddr, dstPort, protocol',
  '| sort totalBytes desc',
  '| limit 10000',
].join(' ');

/** Flux observés (section 7.3) : requête Logs Insights agrégée sur les Flow Logs VPC. */
export async function collectFlowObservations(
  ctx: CollectorContext,
  flowLogs: { logGroups?: string[]; lookbackHours: number },
  timeoutMs = 120_000,
): Promise<FlowObservation[]> {
  let groups = flowLogs.logGroups ?? [];
  if (groups.length === 0) {
    const ec2 = new EC2Client(ctx.clientConfig);
    const pages = await collect(paginateDescribeFlowLogs({ client: ec2 }, {}));
    groups = [
      ...new Set(
        pages
          .flatMap((p) => p.FlowLogs ?? [])
          .filter(
            (f) => (f.LogDestinationType ?? 'cloud-watch-logs') === 'cloud-watch-logs' && f.LogGroupName,
          )
          .map((f) => f.LogGroupName as string),
      ),
    ];
  }
  if (groups.length === 0) return [];
  const logs = new CloudWatchLogsClient(ctx.clientConfig);
  const end = Math.floor(Date.now() / 1000);
  const start = await logs.send(
    new StartQueryCommand({
      logGroupNames: groups.slice(0, 50),
      startTime: end - flowLogs.lookbackHours * 3600,
      endTime: end,
      queryString: FLOW_QUERY,
      limit: 10000,
    }),
  );
  const queryId = start.queryId;
  if (!queryId) return [];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await logs.send(new GetQueryResultsCommand({ queryId }));
    if (res.status === 'Complete') {
      return (res.results ?? []).map((row) => {
        const f = Object.fromEntries(row.map((c) => [c.field ?? '', c.value ?? '']));
        return {
          srcIp: f.srcAddr ?? '',
          dstIp: f.dstAddr ?? '',
          dstPort: Number(f.dstPort ?? 0),
          protocol: f.protocol ?? '',
          bytes: Number(f.totalBytes ?? 0),
          packets: Number(f.totalPackets ?? 0),
        };
      });
    }
    if (res.status === 'Failed' || res.status === 'Cancelled' || res.status === 'Timeout') {
      throw new Error(`Requête Logs Insights terminée avec l'état ${res.status}`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error('Requête Logs Insights trop longue : délai dépassé');
}
