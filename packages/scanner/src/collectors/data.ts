import {
  DescribeTableCommand,
  DynamoDBClient,
  ListTagsOfResourceCommand,
  paginateListTables,
} from '@aws-sdk/client-dynamodb';
import {
  DescribeMountTargetsCommand,
  DescribeMountTargetSecurityGroupsCommand,
  EFSClient,
  paginateDescribeFileSystems,
} from '@aws-sdk/client-efs';
import {
  ElastiCacheClient,
  paginateDescribeCacheClusters,
  paginateDescribeCacheSubnetGroups,
} from '@aws-sdk/client-elasticache';
import {
  paginateDescribeDBClusters,
  paginateDescribeDBInstances,
  paginateDescribeDBSubnetGroups,
  RDSClient,
} from '@aws-sdk/client-rds';
import {
  GetBucketLocationCommand,
  GetBucketTaggingCommand,
  GetBucketWebsiteCommand,
  GetPublicAccessBlockCommand,
  paginateListBuckets,
  S3Client,
} from '@aws-sdk/client-s3';
import { clientConfig, collect, errorCode, resource, tagsOf, type Collector } from '../context.ts';

export const rdsCollector: Collector = {
  service: 'rds',
  async collect(ctx) {
    const client = new RDSClient(ctx.clientConfig);
    const dbs = (await collect(paginateDescribeDBInstances({ client }, {}))).flatMap(
      (p) => p.DBInstances ?? [],
    );
    for (const db of dbs) {
      if (!db.DBInstanceIdentifier) continue;
      ctx.emit(
        resource('AWS::RDS::DBInstance', db.DBInstanceIdentifier, ctx.region, db, {
          ...(db.DBInstanceArn ? { arn: db.DBInstanceArn } : {}),
          tags: tagsOf(db.TagList),
        }),
      );
    }
    const clusters = (await collect(paginateDescribeDBClusters({ client }, {}))).flatMap(
      (p) => p.DBClusters ?? [],
    );
    for (const c of clusters) {
      if (!c.DBClusterIdentifier) continue;
      ctx.emit(
        resource('AWS::RDS::DBCluster', c.DBClusterIdentifier, ctx.region, c, {
          ...(c.DBClusterArn ? { arn: c.DBClusterArn } : {}),
          tags: tagsOf(c.TagList),
        }),
      );
    }
    const groups = (await collect(paginateDescribeDBSubnetGroups({ client }, {}))).flatMap(
      (p) => p.DBSubnetGroups ?? [],
    );
    for (const g of groups) {
      if (!g.DBSubnetGroupName) continue;
      ctx.emit(
        resource('AWS::RDS::DBSubnetGroup', g.DBSubnetGroupName, ctx.region, g, {
          ...(g.DBSubnetGroupArn ? { arn: g.DBSubnetGroupArn } : {}),
        }),
      );
    }
  },
};

export const dynamodbCollector: Collector = {
  service: 'dynamodb',
  async collect(ctx) {
    const client = new DynamoDBClient(ctx.clientConfig);
    const names = (await collect(paginateListTables({ client }, {}))).flatMap((p) => p.TableNames ?? []);
    for (const TableName of names) {
      const out = await ctx.tryCall('dynamodb:DescribeTable', () =>
        client.send(new DescribeTableCommand({ TableName })),
      );
      const t = out?.Table;
      const arn = t?.TableArn;
      const tags = arn
        ? await ctx.tryCall('dynamodb:ListTagsOfResource', () =>
            client.send(new ListTagsOfResourceCommand({ ResourceArn: arn })),
          )
        : undefined;
      const raw = t ?? {
        TableName,
        _status: 'inconnu',
        _statusReason: 'accès refusé : dynamodb:DescribeTable',
      };
      ctx.emit(
        resource('AWS::DynamoDB::Table', TableName, ctx.region, raw, {
          ...(arn ? { arn } : {}),
          tags: tagsOf(tags?.Tags),
        }),
      );
    }
  },
};

export const elasticacheCollector: Collector = {
  service: 'elasticache',
  async collect(ctx) {
    const client = new ElastiCacheClient(ctx.clientConfig);
    const groups = (await collect(paginateDescribeCacheSubnetGroups({ client }, {}))).flatMap(
      (p) => p.CacheSubnetGroups ?? [],
    );
    const subnetsByGroup = new Map(groups.map((g) => [g.CacheSubnetGroupName, g.Subnets ?? []]));
    const clusters = (
      await collect(paginateDescribeCacheClusters({ client }, { ShowCacheNodeInfo: true }))
    ).flatMap((p) => p.CacheClusters ?? []);
    for (const c of clusters) {
      if (!c.CacheClusterId) continue;
      const raw = { ...c, _subnets: subnetsByGroup.get(c.CacheSubnetGroupName) ?? [] };
      ctx.emit(
        resource(
          'AWS::ElastiCache::CacheCluster',
          c.CacheClusterId,
          ctx.region,
          raw,
          c.ARN ? { arn: c.ARN } : {},
        ),
      );
    }
  },
};

const NOT_CONFIGURED =
  /^(NoSuchWebsiteConfiguration|NoSuchPublicAccessBlockConfiguration|NoSuchTagSet|NoSuchTagSetError)$/;

export const s3Collector: Collector = {
  service: 's3',
  global: true,
  async collect(ctx) {
    const client = new S3Client({ ...ctx.clientConfig, followRegionRedirects: true });
    const buckets = (await collect(paginateListBuckets({ client }, {}))).flatMap((p) => p.Buckets ?? []);
    for (const b of buckets) {
      if (!b.Name) continue;
      const Bucket = b.Name;
      let region = b.BucketRegion;
      if (!region) {
        const loc = await ctx.tryCall('s3:GetBucketLocation', () =>
          client.send(new GetBucketLocationCommand({ Bucket })),
        );
        region = !loc?.LocationConstraint
          ? 'us-east-1'
          : loc.LocationConstraint === 'EU'
            ? 'eu-west-1'
            : loc.LocationConstraint;
      }
      // Les compartiments sont listés pour tout le compte : seuls ceux des régions du profil sont conservés.
      if (!ctx.regions.includes(region)) continue;
      const regional = new S3Client({
        ...clientConfig(region, ctx.clientConfig.credentials),
        followRegionRedirects: true,
      });
      const optional = async <T>(permission: string, fn: () => Promise<T>) => {
        try {
          return await ctx.tryCall(permission, fn);
        } catch (err) {
          if (NOT_CONFIGURED.test(errorCode(err))) return undefined;
          throw err;
        }
      };
      const website = await optional('s3:GetBucketWebsite', () =>
        regional.send(new GetBucketWebsiteCommand({ Bucket })),
      );
      const pab = await optional('s3:GetBucketPublicAccessBlock', () =>
        regional.send(new GetPublicAccessBlockCommand({ Bucket })),
      );
      const tagging = await optional('s3:GetBucketTagging', () =>
        regional.send(new GetBucketTaggingCommand({ Bucket })),
      );
      const raw = {
        Name: Bucket,
        CreationDate: b.CreationDate,
        ...(website
          ? {
              _website: {
                IndexDocument: website.IndexDocument,
                RedirectAllRequestsTo: website.RedirectAllRequestsTo,
              },
            }
          : {}),
        ...(pab?.PublicAccessBlockConfiguration
          ? { _publicAccessBlock: pab.PublicAccessBlockConfiguration }
          : {}),
      };
      ctx.emit(
        resource('AWS::S3::Bucket', Bucket, region, raw, {
          arn: `arn:${ctx.partition}:s3:::${Bucket}`,
          tags: tagsOf(tagging?.TagSet),
        }),
      );
    }
  },
};

export const efsCollector: Collector = {
  service: 'efs',
  async collect(ctx) {
    const client = new EFSClient(ctx.clientConfig);
    const fss = (await collect(paginateDescribeFileSystems({ client }, {}))).flatMap(
      (p) => p.FileSystems ?? [],
    );
    for (const fs of fss) {
      if (!fs.FileSystemId) continue;
      const FileSystemId = fs.FileSystemId;
      const mts = await ctx.tryCall('elasticfilesystem:DescribeMountTargets', () =>
        client.send(new DescribeMountTargetsCommand({ FileSystemId })),
      );
      const mountTargets = [];
      for (const mt of mts?.MountTargets ?? []) {
        const id = mt.MountTargetId;
        const sgs = id
          ? await ctx.tryCall('elasticfilesystem:DescribeMountTargetSecurityGroups', () =>
              client.send(new DescribeMountTargetSecurityGroupsCommand({ MountTargetId: id })),
            )
          : undefined;
        mountTargets.push({ ...mt, SecurityGroups: sgs?.SecurityGroups ?? [] });
      }
      ctx.emit(
        resource(
          'AWS::EFS::FileSystem',
          FileSystemId,
          ctx.region,
          { ...fs, _mountTargets: mountTargets },
          {
            ...(fs.FileSystemArn ? { arn: fs.FileSystemArn } : {}),
            tags: tagsOf(fs.Tags),
          },
        ),
      );
    }
  },
};
