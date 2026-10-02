import { ConfigServiceClient, SelectResourceConfigCommand } from '@aws-sdk/client-config-service';
import { DescribeVpcsCommand, EC2Client } from '@aws-sdk/client-ec2';
import {
  DescribeClustersCommand,
  DescribeServicesCommand,
  DescribeTaskDefinitionCommand,
  ECSClient,
  ListClustersCommand,
  ListServicesCommand,
  ListTasksCommand,
} from '@aws-sdk/client-ecs';
import { ListIndexesCommand, ResourceExplorer2Client } from '@aws-sdk/client-resource-explorer-2';
import { ListSecretsCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { rawSnapshotSchema } from '@carto/core';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scanAccount } from '../src/index.ts';

const ACCOUNT = '123456789012';
const credentials = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'exemple' };
const sts = mockClient(STSClient);
const ec2 = mockClient(EC2Client);
const ecs = mockClient(ECSClient);
const secrets = mockClient(SecretsManagerClient);
const re = mockClient(ResourceExplorer2Client);
const config = mockClient(ConfigServiceClient);

const awsError = (name: string, message: string) =>
  Object.assign(new Error(message), { name, $metadata: {} });
const base = {
  profileId: 'p',
  accountId: ACCOUNT,
  regions: ['eu-west-3'],
  credentials,
  throttleBackoffMs: 1,
};

beforeEach(() => {
  sts
    .on(GetCallerIdentityCommand)
    .resolves({ Account: ACCOUNT, Arn: `arn:aws:iam::${ACCOUNT}:user/lecteur`, UserId: 'U' });
  ec2.onAnyCommand().resolves({});
});
afterEach(() => {
  for (const m of [sts, ec2, ecs, secrets, re, config]) m.reset();
});

describe('scanner (mocks AWS)', () => {
  it('suit la pagination jusqu’au bout', async () => {
    ec2
      .on(DescribeVpcsCommand)
      .resolvesOnce({ Vpcs: [{ VpcId: 'vpc-1', CidrBlock: '10.0.0.0/16' }], NextToken: 'page-2' })
      .resolvesOnce({
        Vpcs: [{ VpcId: 'vpc-2', CidrBlock: '10.1.0.0/16', Tags: [{ Key: 'Name', Value: 'prod' }] }],
      });
    const snap = await scanAccount({ ...base, services: ['network'] });
    const vpcs = snap.resources.filter((r) => r.type === 'AWS::EC2::VPC');
    expect(vpcs.map((v) => v.id)).toEqual(['vpc-1', 'vpc-2']);
    expect(vpcs[1]?.tags).toEqual({ Name: 'prod' });
    expect(vpcs[0]?.arn).toBe(`arn:aws:ec2:eu-west-3:${ACCOUNT}:vpc/vpc-1`);
    expect(ec2.commandCalls(DescribeVpcsCommand)[1]?.args[0].input).toMatchObject({ NextToken: 'page-2' });
    expect(() => rawSnapshotSchema.parse(snap)).not.toThrow();
  });

  it('AccessDenied : ressource marquée « inconnu », erreur consignée, le scan continue', async () => {
    ecs.on(ListClustersCommand).resolves({ clusterArns: [`arn:aws:ecs:eu-west-3:${ACCOUNT}:cluster/c1`] });
    ecs
      .on(DescribeClustersCommand)
      .resolves({
        clusters: [{ clusterArn: `arn:aws:ecs:eu-west-3:${ACCOUNT}:cluster/c1`, clusterName: 'c1' }],
      });
    ecs
      .on(ListServicesCommand)
      .resolves({ serviceArns: [`arn:aws:ecs:eu-west-3:${ACCOUNT}:service/c1/api`] });
    ecs.on(DescribeServicesCommand).resolves({
      services: [
        {
          serviceName: 'api',
          serviceArn: `arn:aws:ecs:eu-west-3:${ACCOUNT}:service/c1/api`,
          taskDefinition: 'td-api:1',
          desiredCount: 1,
          runningCount: 1,
        },
      ],
    });
    ecs.on(DescribeTaskDefinitionCommand).resolves({
      taskDefinition: {
        family: 'api',
        containerDefinitions: [
          {
            name: 'api',
            image: 'nginx',
            environment: [{ name: 'DB_PASSWORD', value: 'valeur-ultra-secrete' }],
          },
        ],
      },
    });
    ecs
      .on(ListTasksCommand)
      .rejects(
        awsError(
          'AccessDeniedException',
          'User: arn:x is not authorized to perform: ecs:ListTasks on resource: *',
        ),
      );
    secrets.on(ListSecretsCommand).rejects(awsError('AccessDeniedException', 'not authorized'));

    const snap = await scanAccount({ ...base, services: ['ecs', 'secretsmanager'] });
    const svc = snap.resources.find((r) => r.type === 'AWS::ECS::Service');
    expect(svc?.raw).toMatchObject({ _status: 'inconnu', _statusReason: 'accès refusé : ecs:ListTasks' });
    expect(JSON.stringify(snap)).not.toContain('valeur-ultra-secrete');
    expect(JSON.stringify(svc?.raw)).toContain('DB_PASSWORD');
    expect(snap.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          service: 'ecs',
          code: 'AccessDeniedException',
          message: 'Permission manquante : ecs:ListTasks',
        }),
        expect.objectContaining({ service: 'secretsmanager', code: 'AccessDeniedException' }),
      ]),
    );
  });

  it('throttling : la tâche est relancée puis réussit', async () => {
    ec2
      .on(DescribeVpcsCommand)
      .rejectsOnce(awsError('ThrottlingException', 'Rate exceeded'))
      .resolves({ Vpcs: [{ VpcId: 'vpc-ok' }] });
    const snap = await scanAccount({ ...base, services: ['network'] });
    expect(snap.resources.map((r) => r.id)).toContain('vpc-ok');
    expect(snap.errors).toEqual([]);
  });

  it('throttling persistant : erreur consignée sans faire échouer le scan', async () => {
    ec2.on(DescribeVpcsCommand).rejects(awsError('ThrottlingException', 'Rate exceeded'));
    const snap = await scanAccount({ ...base, services: ['network'] });
    expect(snap.errors[0]).toMatchObject({ service: 'network', code: 'ThrottlingException' });
  });

  it('refuse des identifiants d’un autre compte', async () => {
    await expect(scanAccount({ ...base, accountId: '000000000000', services: ['network'] })).rejects.toThrow(
      /compte 123456789012/,
    );
  });

  it('inventaire générique : AWS Config en repli, sans doublon avec les collecteurs dédiés', async () => {
    ec2.on(DescribeVpcsCommand).resolves({ Vpcs: [{ VpcId: 'vpc-1' }] });
    re.on(ListIndexesCommand).resolves({ Indexes: [] });
    config.on(SelectResourceConfigCommand).resolves({
      Results: [
        JSON.stringify({
          resourceId: 'vpc-1',
          resourceType: 'AWS::EC2::VPC',
          arn: `arn:aws:ec2:eu-west-3:${ACCOUNT}:vpc/vpc-1`,
          awsRegion: 'eu-west-3',
        }),
        JSON.stringify({
          resourceId: 'migration-1',
          resourceName: 'migration',
          resourceType: 'AWS::DMS::ReplicationInstance',
          arn: `arn:aws:dms:eu-west-3:${ACCOUNT}:rep:migration-1`,
          awsRegion: 'eu-west-3',
          tags: [{ key: 'Name', value: 'Migration' }],
        }),
      ],
    });
    const snap = await scanAccount({ ...base, services: ['network', 'inventory'] });
    expect(snap.resources.filter((r) => r.id === 'vpc-1')).toHaveLength(1);
    expect(snap.resources.find((r) => r.type === 'AWS::DMS::ReplicationInstance')).toMatchObject({
      id: 'migration-1',
      tags: { Name: 'Migration' },
    });
  });
});
