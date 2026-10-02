import { ConfigServiceClient, SelectResourceConfigCommand } from '@aws-sdk/client-config-service';
import {
  ListIndexesCommand,
  ListResourcesCommand,
  ResourceExplorer2Client,
} from '@aws-sdk/client-resource-explorer-2';
import type { Resource } from '@carto/core';
import { errorCode, isAccessDenied, resource, tagsOf, type CollectorContext } from './context.ts';

/**
 * Inventaire générique (section 5.1) : Resource Explorer si un index existe, sinon AWS Config.
 * Chaque type sans collecteur dédié deviendra un nœud générique ; les types Resource Explorer
 * correspondant à un collecteur dédié sont convertis au format CloudFormation pour que les règles s'appliquent.
 */

const RE_TO_CFN: Record<string, string> = {
  'ec2:instance': 'AWS::EC2::Instance',
  'ec2:vpc': 'AWS::EC2::VPC',
  'ec2:subnet': 'AWS::EC2::Subnet',
  'ec2:security-group': 'AWS::EC2::SecurityGroup',
  'ec2:internet-gateway': 'AWS::EC2::InternetGateway',
  'ec2:natgateway': 'AWS::EC2::NatGateway',
  'ec2:vpc-endpoint': 'AWS::EC2::VPCEndpoint',
  'ec2:route-table': 'AWS::EC2::RouteTable',
  'ec2:network-acl': 'AWS::EC2::NetworkAcl',
  'ec2:network-interface': 'AWS::EC2::NetworkInterface',
  'ecs:cluster': 'AWS::ECS::Cluster',
  'ecs:service': 'AWS::ECS::Service',
  'lambda:function': 'AWS::Lambda::Function',
  'eks:cluster': 'AWS::EKS::Cluster',
  'elasticloadbalancing:loadbalancer/app': 'AWS::ElasticLoadBalancingV2::LoadBalancer',
  'elasticloadbalancing:loadbalancer/net': 'AWS::ElasticLoadBalancingV2::LoadBalancer',
  'elasticloadbalancing:targetgroup': 'AWS::ElasticLoadBalancingV2::TargetGroup',
  'cloudfront:distribution': 'AWS::CloudFront::Distribution',
  'rds:db': 'AWS::RDS::DBInstance',
  'rds:cluster': 'AWS::RDS::DBCluster',
  'dynamodb:table': 'AWS::DynamoDB::Table',
  's3:bucket': 'AWS::S3::Bucket',
  'sqs:queue': 'AWS::SQS::Queue',
  'sns:topic': 'AWS::SNS::Topic',
  'events:rule': 'AWS::Events::Rule',
  'kinesis:stream': 'AWS::Kinesis::Stream',
  'codebuild:project': 'AWS::CodeBuild::Project',
  'codepipeline:pipeline': 'AWS::CodePipeline::Pipeline',
  'ecr:repository': 'AWS::ECR::Repository',
  'secretsmanager:secret': 'AWS::SecretsManager::Secret',
  'ssm:parameter': 'AWS::SSM::Parameter',
  'kms:key': 'AWS::KMS::Key',
  'acm:certificate': 'AWS::CertificateManager::Certificate',
};

const idFromArn = (arn: string) => arn.split(/[:/]/).filter(Boolean).pop() ?? arn;

async function fromResourceExplorer(ctx: CollectorContext): Promise<Resource[] | undefined> {
  const client = new ResourceExplorer2Client(ctx.clientConfig);
  const indexes = await client.send(new ListIndexesCommand({ Regions: [ctx.region] }));
  if (!(indexes.Indexes ?? []).length) return undefined;
  const out: Resource[] = [];
  let token: string | undefined;
  do {
    const page = await client.send(
      new ListResourcesCommand({
        Filters: { FilterString: `region:${ctx.region}` },
        MaxResults: 1000,
        NextToken: token,
      }),
    );
    for (const r of page.Resources ?? []) {
      if (!r.Arn || !r.ResourceType) continue;
      const tagProp = (r.Properties ?? []).find((p) => p.Name === 'tags')?.Data;
      const type = RE_TO_CFN[r.ResourceType] ?? r.ResourceType;
      out.push(
        resource(
          type,
          idFromArn(r.Arn),
          r.Region ?? ctx.region,
          { resourceName: idFromArn(r.Arn), resourceType: r.ResourceType },
          {
            arn: r.Arn,
            tags: tagsOf(
              Array.isArray(tagProp) ? (tagProp as { Key?: string; Value?: string }[]) : undefined,
            ),
          },
        ),
      );
    }
    token = page.NextToken;
  } while (token);
  return out;
}

async function fromConfig(ctx: CollectorContext): Promise<Resource[]> {
  const client = new ConfigServiceClient(ctx.clientConfig);
  const out: Resource[] = [];
  let token: string | undefined;
  const expression = `SELECT resourceId, resourceName, resourceType, arn, awsRegion, tags WHERE awsRegion = '${ctx.region}'`;
  do {
    const page = await client.send(
      new SelectResourceConfigCommand({ Expression: expression, Limit: 100, NextToken: token }),
    );
    for (const line of page.Results ?? []) {
      const item = JSON.parse(line) as {
        resourceId?: string;
        resourceName?: string;
        resourceType?: string;
        arn?: string;
        awsRegion?: string;
        tags?: { key?: string; value?: string }[];
      };
      if (!item.resourceId || !item.resourceType) continue;
      out.push(
        resource(
          item.resourceType,
          item.resourceId,
          item.awsRegion ?? ctx.region,
          { resourceName: item.resourceName, resourceType: item.resourceType },
          {
            ...(item.arn ? { arn: item.arn } : {}),
            tags: tagsOf(item.tags),
          },
        ),
      );
    }
    token = page.NextToken;
  } while (token);
  return out;
}

/** Inventaire d'une région ; lève une erreur explicite si aucune des deux sources n'est utilisable. */
export async function collectInventory(ctx: CollectorContext): Promise<Resource[]> {
  let reError: unknown;
  try {
    const re = await fromResourceExplorer(ctx);
    if (re) return re;
  } catch (err) {
    reError = err;
  }
  try {
    return await fromConfig(ctx);
  } catch (err) {
    const reason = isAccessDenied(err) || isAccessDenied(reError) ? 'accès refusé' : errorCode(err);
    throw Object.assign(
      new Error(
        `Inventaire générique indisponible (${reason}) : aucun index Resource Explorer et AWS Config inaccessible ou non activé`,
      ),
      { name: errorCode(err) },
    );
  }
}
