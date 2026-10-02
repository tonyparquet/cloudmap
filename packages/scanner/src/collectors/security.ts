import { ACMClient, DescribeCertificateCommand, paginateListCertificates } from '@aws-sdk/client-acm';
import { DescribeKeyCommand, KMSClient, paginateListAliases } from '@aws-sdk/client-kms';
import { paginateListSecrets, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { paginateDescribeParameters, SSMClient } from '@aws-sdk/client-ssm';
import { collect, resource, tagsOf, type Collector } from '../context.ts';

/**
 * Sécurité : uniquement des métadonnées. Aucune valeur de secret (GetSecretValue) ni de paramètre
 * (GetParameter*) n'est jamais demandée — vérifié par le test de liste blanche.
 */

export const secretsCollector: Collector = {
  service: 'secretsmanager',
  async collect(ctx) {
    const client = new SecretsManagerClient(ctx.clientConfig);
    const secrets = (await collect(paginateListSecrets({ client }, {}))).flatMap((p) => p.SecretList ?? []);
    for (const s of secrets) {
      if (!s.Name || !s.ARN) continue;
      ctx.emit(
        resource(
          'AWS::SecretsManager::Secret',
          s.Name,
          ctx.region,
          { ...s, SecretVersionsToStages: undefined },
          {
            arn: s.ARN,
            tags: tagsOf(s.Tags),
          },
        ),
      );
    }
  },
};

export const ssmCollector: Collector = {
  service: 'ssm',
  async collect(ctx) {
    const client = new SSMClient(ctx.clientConfig);
    const params = (await collect(paginateDescribeParameters({ client }, {}))).flatMap(
      (p) => p.Parameters ?? [],
    );
    for (const p of params) {
      if (!p.Name) continue;
      const path = p.Name.startsWith('/') ? p.Name : `/${p.Name}`;
      ctx.emit(
        resource('AWS::SSM::Parameter', p.Name, ctx.region, p, {
          arn: p.ARN ?? `arn:${ctx.partition}:ssm:${ctx.region}:${ctx.accountId}:parameter${path}`,
        }),
      );
    }
  },
};

export const kmsCollector: Collector = {
  service: 'kms',
  async collect(ctx) {
    const client = new KMSClient(ctx.clientConfig);
    const aliases = (await collect(paginateListAliases({ client }, {}))).flatMap((p) => p.Aliases ?? []);
    const byKey = new Map<string, string[]>();
    for (const a of aliases) {
      // Les alias gérés par AWS (alias/aws/*) sont omis.
      if (!a.TargetKeyId || !a.AliasName || a.AliasName.startsWith('alias/aws/')) continue;
      byKey.set(a.TargetKeyId, [...(byKey.get(a.TargetKeyId) ?? []), a.AliasName]);
    }
    for (const [KeyId, names] of byKey) {
      const d = await ctx.tryCall('kms:DescribeKey', () => client.send(new DescribeKeyCommand({ KeyId })));
      const meta = d?.KeyMetadata;
      const arn = meta?.Arn ?? `arn:${ctx.partition}:kms:${ctx.region}:${ctx.accountId}:key/${KeyId}`;
      ctx.emit(
        resource(
          'AWS::KMS::Key',
          KeyId,
          ctx.region,
          {
            KeyId,
            KeyState: meta?.KeyState,
            KeyManager: meta?.KeyManager,
            KeyUsage: meta?.KeyUsage,
            Description: meta?.Description,
            _aliases: names,
          },
          { arn },
        ),
      );
    }
  },
};

export const acmCollector: Collector = {
  service: 'acm',
  async collect(ctx) {
    const client = new ACMClient(ctx.clientConfig);
    const certs = (await collect(paginateListCertificates({ client }, {}))).flatMap(
      (p) => p.CertificateSummaryList ?? [],
    );
    for (const c of certs) {
      if (!c.CertificateArn) continue;
      const CertificateArn = c.CertificateArn;
      const d = await ctx.tryCall('acm:DescribeCertificate', () =>
        client.send(new DescribeCertificateCommand({ CertificateArn })),
      );
      const cert = d?.Certificate;
      const raw = cert
        ? {
            DomainName: cert.DomainName,
            SubjectAlternativeNames: cert.SubjectAlternativeNames,
            Status: cert.Status,
            Type: cert.Type,
            NotAfter: cert.NotAfter,
            InUseBy: cert.InUseBy,
          }
        : { DomainName: c.DomainName, Status: c.Status, NotAfter: c.NotAfter, InUseBy: [] };
      ctx.emit(
        resource(
          'AWS::CertificateManager::Certificate',
          CertificateArn.split('/').pop() ?? CertificateArn,
          ctx.region,
          raw,
          { arn: CertificateArn },
        ),
      );
    }
  },
};
