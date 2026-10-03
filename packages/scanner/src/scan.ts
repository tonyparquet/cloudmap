import type { Profile, RawSnapshot, Resource } from '@carto/core';
import { probeUrl, redactString } from '@carto/security';
import pLimit from 'p-limit';
import { ecsCollector, eksCollector, lambdaCollector, autoscalingCollector } from './collectors/compute.ts';
import {
  codebuildCollector,
  codeconnectionsCollector,
  codepipelineCollector,
  ecrCollector,
} from './collectors/cicd.ts';
import {
  dynamodbCollector,
  efsCollector,
  elasticacheCollector,
  rdsCollector,
  s3Collector,
} from './collectors/data.ts';
import {
  apigatewayCollector,
  cloudfrontCollector,
  elbv2Collector,
  route53Collector,
  wafCollector,
  wafGlobalCollector,
} from './collectors/ingress.ts';
import {
  cloudmapCollector,
  eventbridgeCollector,
  kinesisCollector,
  snsCollector,
  sqsCollector,
} from './collectors/integration.ts';
import { ec2Collector, networkCollector } from './collectors/network.ts';
import { identityCenterCollector, organizationsCollector } from './collectors/organizations.ts';
import { acmCollector, kmsCollector, secretsCollector, ssmCollector } from './collectors/security.ts';
import {
  clientConfig,
  errorCode,
  isAccessDenied,
  isThrottling,
  missingPermission,
  SCANNER_VERSION,
  type Collector,
  type CollectorContext,
  type Credentials,
  type ScanError,
} from './context.ts';
import { getCallerIdentity } from './credentials.ts';
import { collectInventory } from './inventory.ts';
import { collectFlowObservations, collectMetrics } from './observability.ts';

export const COLLECTORS: Collector[] = [
  networkCollector,
  ec2Collector,
  autoscalingCollector,
  ecsCollector,
  lambdaCollector,
  eksCollector,
  elbv2Collector,
  apigatewayCollector,
  cloudfrontCollector,
  route53Collector,
  wafCollector,
  wafGlobalCollector,
  rdsCollector,
  dynamodbCollector,
  elasticacheCollector,
  s3Collector,
  efsCollector,
  sqsCollector,
  snsCollector,
  eventbridgeCollector,
  kinesisCollector,
  cloudmapCollector,
  codebuildCollector,
  codepipelineCollector,
  ecrCollector,
  codeconnectionsCollector,
  secretsCollector,
  ssmCollector,
  kmsCollector,
  acmCollector,
  organizationsCollector,
  identityCenterCollector,
];

/** Services sélectionnables (page Scan). */
export const SERVICES: { key: string; label: string }[] = [
  { key: 'network', label: 'Réseau (VPC, sous-réseaux, routage, groupes de sécurité, NACL)' },
  { key: 'ec2', label: 'EC2' },
  { key: 'autoscaling', label: 'Auto Scaling' },
  { key: 'ecs', label: 'ECS' },
  { key: 'lambda', label: 'Lambda' },
  { key: 'eks', label: 'EKS' },
  { key: 'elbv2', label: 'Équilibreurs de charge (ALB / NLB)' },
  { key: 'apigateway', label: 'API Gateway' },
  { key: 'cloudfront', label: 'CloudFront' },
  { key: 'route53', label: 'Route 53' },
  { key: 'waf', label: 'WAF' },
  { key: 'rds', label: 'RDS' },
  { key: 'dynamodb', label: 'DynamoDB' },
  { key: 'elasticache', label: 'ElastiCache' },
  { key: 's3', label: 'S3' },
  { key: 'efs', label: 'EFS' },
  { key: 'sqs', label: 'SQS' },
  { key: 'sns', label: 'SNS' },
  { key: 'eventbridge', label: 'EventBridge' },
  { key: 'kinesis', label: 'Kinesis' },
  { key: 'cloudmap', label: 'Cloud Map' },
  { key: 'codebuild', label: 'CodeBuild' },
  { key: 'codepipeline', label: 'CodePipeline' },
  { key: 'ecr', label: 'ECR' },
  { key: 'codeconnections', label: 'CodeConnections' },
  { key: 'secretsmanager', label: 'Secrets Manager (métadonnées)' },
  { key: 'ssm', label: 'SSM Parameter Store (métadonnées)' },
  { key: 'kms', label: 'KMS (alias)' },
  { key: 'acm', label: 'ACM' },
  { key: 'organizations', label: 'AWS Organizations (comptes, OU, SCP / RCP)' },
  { key: 'identitycenter', label: 'IAM Identity Center (groupes, permission sets, affectations)' },
  { key: 'cloudwatch', label: 'CloudWatch (métriques de statut)' },
  { key: 'inventory', label: 'Inventaire générique (Resource Explorer / AWS Config)' },
];

export type ScanEvent =
  | { type: 'start'; total: number; regions: string[] }
  | {
      type: 'progress';
      service: string;
      region: string;
      found: number;
      errors: number;
      done: number;
      total: number;
    }
  | { type: 'error'; service: string; region: string; code: string; message: string }
  | { type: 'done'; resources: number; errors: number };

export interface ScanOptions {
  profileId: string;
  /** Compte attendu : le scan est refusé si les identifiants désignent un autre compte. */
  accountId: string;
  regions: string[];
  services?: string[];
  credentials: Credentials;
  concurrency?: number;
  probes?: Profile['probes'];
  flowLogs?: Profile['flowLogs'];
  probeTimeoutMs?: number;
  throttleBackoffMs?: number;
  onProgress?: (event: ScanEvent) => void;
}

const GLOBAL_API_REGION = 'us-east-1';

/** Scan complet en lecture seule. Ne lève que si l'identité est invalide ; le reste devient des erreurs consignées. */
export async function scanAccount(opts: ScanOptions): Promise<RawSnapshot> {
  const startedAt = new Date().toISOString();
  const identity = await getCallerIdentity(opts.credentials);
  if (identity.account !== opts.accountId) {
    throw new Error(
      `Les identifiants désignent le compte ${identity.account}, le profil attend ${opts.accountId}`,
    );
  }
  const partition = identity.arn.split(':')[1] ?? 'aws';
  const wanted = new Set(opts.services?.length ? opts.services : SERVICES.map((s) => s.key));
  const resources: Resource[] = [];
  const errors: ScanError[] = [];
  const emitError = (e: ScanError) => {
    errors.push(e);
    opts.onProgress?.({ type: 'error', ...e });
  };
  const errorEntry = (service: string, region: string, err: unknown, permission: string): ScanError =>
    isAccessDenied(err)
      ? {
          service,
          region,
          code: errorCode(err),
          message: `Permission manquante : ${missingPermission(err, permission)}`,
        }
      : {
          service,
          region,
          code: errorCode(err),
          message: redactString(String((err as Error)?.message ?? err)).slice(0, 500),
        };

  const makeCtx = (service: string, region: string, sink: Resource[]): CollectorContext => ({
    region,
    accountId: identity.account,
    partition,
    regions: opts.regions,
    clientConfig: clientConfig(region === 'global' ? GLOBAL_API_REGION : region, opts.credentials),
    emit: (r) => sink.push(r),
    tryCall: async (permission, fn) => {
      try {
        return await fn();
      } catch (err) {
        if (!isAccessDenied(err)) throw err;
        emitError(errorEntry(service, region, err, permission));
        return undefined;
      }
    },
  });

  /** Exécute une tâche ; un throttling persistant malgré le mode adaptatif du SDK relance la tâche entière. */
  const run = async (service: string, region: string, task: (ctx: CollectorContext) => Promise<void>) => {
    for (let attempt = 0; ; attempt++) {
      const buffer: Resource[] = [];
      try {
        await task(makeCtx(service, region, buffer));
        resources.push(...buffer);
        return buffer.length;
      } catch (err) {
        if (isThrottling(err) && attempt < 2) {
          await new Promise((r) => setTimeout(r, (opts.throttleBackoffMs ?? 2000) * 2 ** attempt));
          continue;
        }
        resources.push(...buffer);
        emitError(errorEntry(service, region, err, `${service}:*`));
        return buffer.length;
      }
    }
  };

  const tasks: { service: string; region: string; task: (ctx: CollectorContext) => Promise<void> }[] = [];
  for (const c of COLLECTORS) {
    if (!wanted.has(c.service)) continue;
    for (const region of c.global ? ['global'] : opts.regions)
      tasks.push({ service: c.service, region, task: (ctx) => c.collect(ctx) });
  }
  const later =
    (wanted.has('inventory') ? opts.regions.length : 0) +
    (wanted.has('cloudwatch') ? opts.regions.length : 0) +
    (opts.flowLogs?.enabled ? opts.regions.length : 0);
  const total = tasks.length + later;
  opts.onProgress?.({ type: 'start', total, regions: opts.regions });

  const limit = pLimit(Math.max(1, opts.concurrency ?? 6));
  let done = 0;
  const step = async (service: string, region: string, task: (ctx: CollectorContext) => Promise<void>) => {
    const before = errors.length;
    const found = await run(service, region, task);
    done++;
    opts.onProgress?.({
      type: 'progress',
      service,
      region,
      found,
      errors: errors.length - before,
      done,
      total,
    });
  };
  await Promise.all(tasks.map((t) => limit(() => step(t.service, t.region, t.task))));

  // Inventaire générique : seules les ressources inconnues des collecteurs dédiés sont ajoutées.
  if (wanted.has('inventory')) {
    const known = new Set(resources.map((r) => r.arn ?? `${r.type}|${r.id}`));
    await Promise.all(
      opts.regions.map((region) =>
        limit(() =>
          step('inventory', region, async (ctx) => {
            for (const r of await collectInventory(ctx)) {
              if (known.has(r.arn ?? `${r.type}|${r.id}`)) continue;
              const raw = (r.raw ?? {}) as Record<string, unknown>;
              raw._statusReason =
                "issue de l'inventaire générique (aucun collecteur dédié, ou collecteur sans accès)";
              ctx.emit({ ...r, raw });
            }
          }),
        ),
      ),
    );
  }

  const metrics: NonNullable<RawSnapshot['metrics']> = [];
  if (wanted.has('cloudwatch')) {
    await Promise.all(
      opts.regions.map((region) =>
        limit(() =>
          step('cloudwatch', region, async (ctx) => {
            metrics.push(...(await collectMetrics(ctx, resources)));
          }),
        ),
      ),
    );
  }

  const flowObservations: NonNullable<RawSnapshot['flowObservations']> = [];
  const flowLogs = opts.flowLogs;
  if (flowLogs?.enabled) {
    await Promise.all(
      opts.regions.map((region) =>
        limit(() =>
          step('flowlogs', region, async (ctx) => {
            flowObservations.push(...(await collectFlowObservations(ctx, flowLogs)));
          }),
        ),
      ),
    );
  }

  const probes = await Promise.all(
    (opts.probes ?? []).map((p) =>
      probeUrl(p.url, {
        allowHttp: p.allowHttp,
        allowPrivate: p.allowPrivate,
        timeoutMs: opts.probeTimeoutMs ?? 5000,
      }),
    ),
  );

  opts.onProgress?.({ type: 'done', resources: resources.length, errors: errors.length });
  return {
    schemaVersion: 1,
    meta: {
      profileId: opts.profileId,
      accountId: identity.account,
      regions: opts.regions,
      startedAt,
      finishedAt: new Date().toISOString(),
      scannerVersion: SCANNER_VERSION,
    },
    resources,
    ...(metrics.length ? { metrics } : {}),
    ...(flowObservations.length ? { flowObservations } : {}),
    ...(probes.length ? { probes } : {}),
    errors,
  };
}
