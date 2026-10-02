import {
  BatchGetBuildsCommand,
  BatchGetProjectsCommand,
  CodeBuildClient,
  ListBuildsForProjectCommand,
  paginateListProjects,
  type Project,
} from '@aws-sdk/client-codebuild';
import { CodeConnectionsClient, ListConnectionsCommand } from '@aws-sdk/client-codeconnections';
import {
  CodePipelineClient,
  GetPipelineCommand,
  GetPipelineStateCommand,
  paginateListPipelines,
} from '@aws-sdk/client-codepipeline';
import {
  ECRClient,
  ListTagsForResourceCommand as ListEcrTagsCommand,
  paginateDescribeRepositories,
  paginateListImages,
} from '@aws-sdk/client-ecr';
import { chunks, collect, resource, tagsOf, type Collector } from '../context.ts';

const REPO_VAR = /REPO|IMAGE|ECR|REGISTRY/i;
const SAFE_VALUE = /^[\w.\-/:@]{1,256}$/;

/**
 * Projet CodeBuild sans valeur sensible : buildspec en ligne retiré, variables d'environnement réduites
 * à leurs noms, sauf les variables en clair désignant un dépôt d'images (nécessaires à la relation → ECR).
 */
export function sanitizeProject(p: Project) {
  const env = p.environment;
  return {
    ...p,
    source: p.source
      ? {
          ...p.source,
          buildspec: undefined,
          auth: p.source.auth ? { type: p.source.auth.type, resource: p.source.auth.resource } : undefined,
        }
      : undefined,
    secondarySources: undefined,
    environment: env
      ? {
          ...env,
          environmentVariables: (env.environmentVariables ?? []).map((v) => ({
            name: v.name,
            type: v.type,
            ...(v.type === 'PLAINTEXT' && REPO_VAR.test(v.name ?? '') && SAFE_VALUE.test(v.value ?? '')
              ? { value: v.value }
              : {}),
          })),
        }
      : undefined,
  };
}

const SENSITIVE_CONFIG = /token|secret|password|passphrase|credential|key$/i;

function sanitizePipelineConfig(config: Record<string, string> | undefined) {
  if (!config) return undefined;
  return Object.fromEntries(Object.entries(config).filter(([k]) => !SENSITIVE_CONFIG.test(k)));
}

export const codebuildCollector: Collector = {
  service: 'codebuild',
  async collect(ctx) {
    const client = new CodeBuildClient(ctx.clientConfig);
    const names = (await collect(paginateListProjects({ client }, {}))).flatMap((p) => p.projects ?? []);
    for (const batch of chunks(names, 100)) {
      const out = await client.send(new BatchGetProjectsCommand({ names: batch }));
      for (const project of out.projects ?? []) {
        if (!project.name) continue;
        const projectName = project.name;
        const raw: Record<string, unknown> = sanitizeProject(project);
        const ids = await ctx.tryCall('codebuild:ListBuildsForProject', () =>
          client.send(new ListBuildsForProjectCommand({ projectName, sortOrder: 'DESCENDING' })),
        );
        const lastId = ids?.ids?.[0];
        if (lastId) {
          const builds = await ctx.tryCall('codebuild:BatchGetBuilds', () =>
            client.send(new BatchGetBuildsCommand({ ids: [lastId] })),
          );
          const b = builds?.builds?.[0];
          if (b) raw._lastBuild = { buildStatus: b.buildStatus, startTime: b.startTime, endTime: b.endTime };
        }
        ctx.emit(
          resource('AWS::CodeBuild::Project', projectName, ctx.region, raw, {
            ...(project.arn ? { arn: project.arn } : {}),
            tags: tagsOf(project.tags?.map((t) => ({ Key: t.key, Value: t.value }))),
          }),
        );
      }
    }
  },
};

export const codepipelineCollector: Collector = {
  service: 'codepipeline',
  async collect(ctx) {
    const client = new CodePipelineClient(ctx.clientConfig);
    const pipelines = (await collect(paginateListPipelines({ client }, {}))).flatMap(
      (p) => p.pipelines ?? [],
    );
    for (const summary of pipelines) {
      if (!summary.name) continue;
      const name = summary.name;
      const out = await ctx.tryCall('codepipeline:GetPipeline', () =>
        client.send(new GetPipelineCommand({ name })),
      );
      const state = await ctx.tryCall('codepipeline:GetPipelineState', () =>
        client.send(new GetPipelineStateCommand({ name })),
      );
      const p = out?.pipeline;
      const raw: Record<string, unknown> = {
        name,
        stages: (p?.stages ?? []).map((s) => ({
          name: s.name,
          actions: (s.actions ?? []).map((a) => ({
            name: a.name,
            actionTypeId: a.actionTypeId,
            configuration: sanitizePipelineConfig(a.configuration),
          })),
        })),
        _state: {
          stageStates: (state?.stageStates ?? []).map((s) => ({
            stageName: s.stageName,
            latestExecution: s.latestExecution,
          })),
        },
      };
      if (!p) {
        raw._status = 'inconnu';
        raw._statusReason = 'accès refusé : codepipeline:GetPipeline';
      }
      const arn =
        out?.metadata?.pipelineArn ??
        `arn:${ctx.partition}:codepipeline:${ctx.region}:${ctx.accountId}:${name}`;
      ctx.emit(resource('AWS::CodePipeline::Pipeline', name, ctx.region, raw, { arn }));
    }
  },
};

export const ecrCollector: Collector = {
  service: 'ecr',
  async collect(ctx) {
    const client = new ECRClient(ctx.clientConfig);
    const repos = (await collect(paginateDescribeRepositories({ client }, {}))).flatMap(
      (p) => p.repositories ?? [],
    );
    for (const repo of repos) {
      if (!repo.repositoryName || !repo.repositoryArn) continue;
      const repositoryName = repo.repositoryName;
      const arn = repo.repositoryArn;
      const images = await ctx.tryCall('ecr:ListImages', () =>
        collect(paginateListImages({ client }, { repositoryName, filter: { tagStatus: 'ANY' } })),
      );
      const tags = await ctx.tryCall('ecr:ListTagsForResource', () =>
        client.send(new ListEcrTagsCommand({ resourceArn: arn })),
      );
      const raw: Record<string, unknown> = { ...repo };
      if (images) raw._imageCount = images.flatMap((p) => p.imageIds ?? []).length;
      ctx.emit(
        resource('AWS::ECR::Repository', repositoryName, ctx.region, raw, { arn, tags: tagsOf(tags?.tags) }),
      );
    }
  },
};

export const codeconnectionsCollector: Collector = {
  service: 'codeconnections',
  async collect(ctx) {
    const client = new CodeConnectionsClient(ctx.clientConfig);
    let token: string | undefined;
    do {
      const page = await client.send(new ListConnectionsCommand({ NextToken: token }));
      for (const c of page.Connections ?? []) {
        if (!c.ConnectionArn) continue;
        ctx.emit(
          resource(
            'AWS::CodeConnections::Connection',
            c.ConnectionArn.split('/').pop() ?? c.ConnectionArn,
            ctx.region,
            c,
            {
              arn: c.ConnectionArn,
            },
          ),
        );
      }
      token = page.NextToken;
    } while (token);
  },
};
