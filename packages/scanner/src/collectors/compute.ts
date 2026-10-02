import { AutoScalingClient, paginateDescribeAutoScalingGroups } from '@aws-sdk/client-auto-scaling';
import {
  DescribeClustersCommand,
  DescribeServicesCommand,
  DescribeTaskDefinitionCommand,
  DescribeTasksCommand,
  ECSClient,
  paginateListClusters,
  paginateListServices,
  paginateListTasks,
  type ContainerDefinition,
  type TaskDefinition,
} from '@aws-sdk/client-ecs';
import {
  DescribeClusterCommand,
  DescribeNodegroupCommand,
  EKSClient,
  paginateListClusters as paginateListEksClusters,
  paginateListNodegroups,
} from '@aws-sdk/client-eks';
import {
  GetFunctionConfigurationCommand,
  LambdaClient,
  ListTagsCommand,
  paginateListEventSourceMappings,
  paginateListFunctions,
  type FunctionConfiguration,
} from '@aws-sdk/client-lambda';
import { chunks, collect, markUnknown, resource, tagsOf, type Collector } from '../context.ts';

/** Définition de conteneur ECS sans aucune valeur sensible (variables réduites à leurs noms). */
export function sanitizeContainerDefinition(c: ContainerDefinition) {
  return {
    name: c.name,
    image: c.image,
    essential: c.essential,
    cpu: c.cpu,
    memory: c.memory,
    portMappings: c.portMappings,
    environment: (c.environment ?? []).map((e) => ({ name: e.name })),
    secrets: (c.secrets ?? []).map((s) => ({ name: s.name, valueFrom: s.valueFrom })),
    dependsOn: c.dependsOn,
    logDriver: c.logConfiguration?.logDriver,
  };
}

export function sanitizeTaskDefinition(td: TaskDefinition | undefined) {
  if (!td) return undefined;
  return {
    taskDefinitionArn: td.taskDefinitionArn,
    family: td.family,
    revision: td.revision,
    networkMode: td.networkMode,
    taskRoleArn: td.taskRoleArn,
    executionRoleArn: td.executionRoleArn,
    containerDefinitions: (td.containerDefinitions ?? []).map(sanitizeContainerDefinition),
  };
}

/** Configuration Lambda sans valeur de variable d'environnement. */
export function sanitizeFunction(fn: FunctionConfiguration) {
  const { Environment, ...rest } = fn;
  return {
    ...rest,
    Environment: { VariableNames: Object.keys(Environment?.Variables ?? {}) },
  };
}

export const ecsCollector: Collector = {
  service: 'ecs',
  async collect(ctx) {
    const client = new ECSClient(ctx.clientConfig);
    const clusterArns = (await collect(paginateListClusters({ client }, {}))).flatMap(
      (p) => p.clusterArns ?? [],
    );
    const taskDefs = new Map<string, ReturnType<typeof sanitizeTaskDefinition> | null>();

    for (const batch of chunks(clusterArns, 100)) {
      const out = await client.send(new DescribeClustersCommand({ clusters: batch, include: ['TAGS'] }));
      for (const cl of out.clusters ?? []) {
        if (!cl.clusterArn) continue;
        ctx.emit(
          resource('AWS::ECS::Cluster', cl.clusterName ?? cl.clusterArn, ctx.region, cl, {
            arn: cl.clusterArn,
            tags: tagsOf(cl.tags),
          }),
        );
      }
    }

    for (const cluster of clusterArns) {
      const serviceArns = (await collect(paginateListServices({ client }, { cluster }))).flatMap(
        (p) => p.serviceArns ?? [],
      );
      for (const batch of chunks(serviceArns, 10)) {
        const out = await client.send(
          new DescribeServicesCommand({ cluster, services: batch, include: ['TAGS'] }),
        );
        for (const svc of out.services ?? []) {
          if (!svc.serviceArn || !svc.serviceName) continue;
          const raw: Record<string, unknown> = { ...svc, deployments: undefined, events: undefined };

          const tdArn = svc.taskDefinition;
          if (tdArn && !taskDefs.has(tdArn)) {
            const td = await ctx.tryCall('ecs:DescribeTaskDefinition', () =>
              client.send(new DescribeTaskDefinitionCommand({ taskDefinition: tdArn })),
            );
            taskDefs.set(tdArn, td ? sanitizeTaskDefinition(td.taskDefinition) : null);
          }
          const td = tdArn ? taskDefs.get(tdArn) : undefined;
          if (td) raw._taskDefinition = td;
          else if (tdArn) markUnknown(raw, 'ecs:DescribeTaskDefinition');

          const tasks = await ctx.tryCall('ecs:ListTasks', () =>
            collect(paginateListTasks({ client }, { cluster, serviceName: svc.serviceName })),
          );
          if (!tasks) markUnknown(raw, 'ecs:ListTasks');
          const taskArns = (tasks ?? []).flatMap((p) => p.taskArns ?? []);
          const described = [];
          for (const b of chunks(taskArns, 100)) {
            const d = await ctx.tryCall('ecs:DescribeTasks', () =>
              client.send(new DescribeTasksCommand({ cluster, tasks: b })),
            );
            described.push(
              ...(d?.tasks ?? []).map((t) => ({
                taskArn: t.taskArn,
                lastStatus: t.lastStatus,
                attachments: (t.attachments ?? []).map((a) => ({
                  type: a.type,
                  details: (a.details ?? []).filter((x) =>
                    ['privateIPv4Address', 'subnetId', 'networkInterfaceId'].includes(x.name ?? ''),
                  ),
                })),
              })),
            );
          }
          raw._tasks = described;
          ctx.emit(
            resource('AWS::ECS::Service', svc.serviceName, ctx.region, raw, {
              arn: svc.serviceArn,
              tags: tagsOf(svc.tags),
            }),
          );
        }
      }
    }
  },
};

export const lambdaCollector: Collector = {
  service: 'lambda',
  async collect(ctx) {
    const client = new LambdaClient(ctx.clientConfig);
    const functions = (await collect(paginateListFunctions({ client }, {}))).flatMap(
      (p) => p.Functions ?? [],
    );
    const mappings =
      (await ctx.tryCall('lambda:ListEventSourceMappings', () =>
        collect(paginateListEventSourceMappings({ client }, {})),
      )) ?? [];
    const esm = mappings.flatMap((p) => p.EventSourceMappings ?? []);
    for (const listed of functions) {
      if (!listed.FunctionName || !listed.FunctionArn) continue;
      const name = listed.FunctionName;
      const full = await ctx.tryCall('lambda:GetFunctionConfiguration', () =>
        client.send(new GetFunctionConfigurationCommand({ FunctionName: name })),
      );
      const raw: Record<string, unknown> = sanitizeFunction(full ?? listed);
      const arn = listed.FunctionArn;
      raw._eventSourceMappings = esm
        .filter((m) => m.FunctionArn === arn || m.FunctionArn?.startsWith(`${arn}:`))
        .map((m) => ({ UUID: m.UUID, EventSourceArn: m.EventSourceArn, State: m.State }));
      const tags = await ctx.tryCall('lambda:ListTags', () =>
        client.send(new ListTagsCommand({ Resource: arn })),
      );
      ctx.emit(resource('AWS::Lambda::Function', name, ctx.region, raw, { arn, tags: tagsOf(tags?.Tags) }));
    }
  },
};

export const autoscalingCollector: Collector = {
  service: 'autoscaling',
  async collect(ctx) {
    const client = new AutoScalingClient(ctx.clientConfig);
    const groups = (await collect(paginateDescribeAutoScalingGroups({ client }, {}))).flatMap(
      (p) => p.AutoScalingGroups ?? [],
    );
    for (const g of groups) {
      if (!g.AutoScalingGroupName) continue;
      ctx.emit(
        resource('AWS::AutoScaling::AutoScalingGroup', g.AutoScalingGroupName, ctx.region, g, {
          ...(g.AutoScalingGroupARN ? { arn: g.AutoScalingGroupARN } : {}),
          tags: tagsOf(g.Tags?.map((t) => ({ Key: t.Key, Value: t.Value }))),
        }),
      );
    }
  },
};

export const eksCollector: Collector = {
  service: 'eks',
  async collect(ctx) {
    const client = new EKSClient(ctx.clientConfig);
    const names = (await collect(paginateListEksClusters({ client }, {}))).flatMap((p) => p.clusters ?? []);
    for (const name of names) {
      const out = await client.send(new DescribeClusterCommand({ name }));
      const cl = out.cluster;
      if (!cl) continue;
      // Les données de certificat et d'identité ne sont pas utiles au diagramme.
      const raw = { ...cl, certificateAuthority: undefined, identity: undefined };
      ctx.emit(
        resource('AWS::EKS::Cluster', name, ctx.region, raw, {
          ...(cl.arn ? { arn: cl.arn } : {}),
          tags: tagsOf(cl.tags),
        }),
      );
      const groups =
        (await ctx.tryCall('eks:ListNodegroups', () =>
          collect(paginateListNodegroups({ client }, { clusterName: name })),
        )) ?? [];
      for (const ng of groups.flatMap((p) => p.nodegroups ?? [])) {
        const d = await ctx.tryCall('eks:DescribeNodegroup', () =>
          client.send(new DescribeNodegroupCommand({ clusterName: name, nodegroupName: ng })),
        );
        const n = d?.nodegroup;
        if (!n) continue;
        ctx.emit(
          resource('AWS::EKS::Nodegroup', `${name}/${ng}`, ctx.region, n, {
            ...(n.nodegroupArn ? { arn: n.nodegroupArn } : {}),
            tags: tagsOf(n.tags),
          }),
        );
      }
    }
  },
};
