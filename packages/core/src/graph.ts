import { cidrContains, isPrivateIpv4 } from './cidr.ts';
import {
  flowLabel,
  inferEgressFlows,
  inferSecurityGroupFlows,
  normProto,
  portsCover,
  portText,
  type FlowContext,
  type FlowEdgeRequest,
  type FlowNode,
  type ServiceUse,
} from './flows.ts';
import { buildNetworkModel, nameTag, type NetworkModel, type SecurityGroup } from './network.ts';
import { NETWORK_PROVIDERS } from './providers/index.ts';
import { Evaluator, findRule, type Resolver, type Rule, type RuleSet } from './rules.ts';
import type {
  EdgeKind,
  EdgeState,
  Graph,
  GraphContainer,
  GraphEdge,
  GraphNode,
  NodeStatus,
  Profile,
  RawSnapshot,
  Resource,
} from './schemas.ts';
import { STATUSES } from './schemas.ts';

export interface BuildOptions {
  /** Au-delà de ce nombre de ressources semblables (type + conteneur + clé), création d'un nœud groupé. */
  groupingThreshold?: number;
  /** Identifiants de groupes à déplier. */
  expandedGroups?: string[];
  /** Vue multi-comptes : libellé du cadre de chaque compte (nom du profil). */
  accountLabels?: Record<string, string>;
}

export type GraphProfile = Partial<Pick<Profile, 'externalNodes' | 'probes' | 'tagFilters'>>;

interface NodeMeta {
  node: GraphNode;
  resource?: Resource;
  rule?: Rule;
  sgs: string[];
  ips: string[];
  subnetId?: string;
  vpcId?: string;
  groupKey: string;
}

interface EdgeAcc {
  source: string;
  target: string;
  kind: EdgeKind;
  state: EdgeState;
  proto?: string;
  ports: Set<string>;
  label?: string;
  evidence: Set<string>;
  bytes?: number;
}

export const resourceKey = (r: Resource): string =>
  r.arn ?? (r.account ? `${r.type}:${r.account}:${r.region}:${r.id}` : `${r.type}:${r.region}:${r.id}`);

export function resourceName(r: Resource): string {
  const raw = (r.raw ?? {}) as Record<string, unknown>;
  for (const k of ['Name', 'name', 'resourceName', 'FunctionName', 'serviceName', 'DBInstanceIdentifier']) {
    if (typeof raw[k] === 'string' && raw[k]) return raw[k];
  }
  return nameTag(r) ?? r.id;
}

const externalType = (icon: string) => `External::${icon.charAt(0).toUpperCase()}${icon.slice(1)}`;

function externalResources(profile: GraphProfile): Resource[] {
  return (profile.externalNodes ?? []).map((n) => ({
    id: `external:${n.id}`,
    type: externalType(n.icon),
    region: 'global',
    raw: { ...n },
    tags: { Name: n.label },
  }));
}

function formatBytes(bytes: number): string {
  const units = ['o', 'Ko', 'Mo', 'Go', 'To'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 }).format(v)} ${units[i]}`;
}

function normalizeHost(value: string): string {
  let v = value.trim().toLowerCase();
  if (v.includes('://')) {
    try {
      v = new URL(v).hostname;
    } catch {
      /* valeur conservée */
    }
  }
  v = v.split('/')[0] ?? v;
  v = v.replace(/:\d+$/, '').replace(/\.$/, '');
  return v.startsWith('dualstack.') ? v.slice('dualstack.'.length) : v;
}

function ecrArn(image: string): string | undefined {
  const m = /^(\d{12})\.dkr\.ecr\.([a-z0-9-]+)\.amazonaws\.com(\.cn)?\/([^:@]+)/.exec(image);
  if (!m) return undefined;
  return `arn:${m[3] ? 'aws-cn' : 'aws'}:ecr:${m[2]}:${m[1]}:repository/${m[4]}`;
}

function bucketName(value: string): string {
  const arn = /^arn:aws[a-z-]*:s3:::([^/]+)/.exec(value);
  if (arn?.[1]) return arn[1];
  const uri = /^s3:\/\/([^/]+)/.exec(value);
  if (uri?.[1]) return uri[1];
  const host = /^(.+?)\.s3[.-]/.exec(normalizeHost(value));
  return host?.[1] ?? value;
}

function sgSummary(net: NetworkModel, id: string) {
  const sg: SecurityGroup | undefined = net.securityGroups.get(id);
  if (!sg) return { id, inbound: [], outbound: [] };
  const lines = (perms: SecurityGroup['IpPermissions'], arrow: string) =>
    (perms ?? []).flatMap((p) => {
      const label = flowLabel(normProto(p.IpProtocol), [portText(p)]);
      const peers = [
        ...(p.UserIdGroupPairs ?? []).map((x) => x.GroupId),
        ...(p.IpRanges ?? []).map((x) => x.CidrIp),
        ...(p.Ipv6Ranges ?? []).map((x) => x.CidrIpv6),
        ...(p.PrefixListIds ?? []).map((x) => x.PrefixListId),
      ].filter(Boolean);
      return peers.map((peer) => `${label} ${arrow} ${peer}`);
    });
  return {
    id,
    name: sg.GroupName,
    inbound: lines(sg.IpPermissions, '←'),
    outbound: lines(sg.IpPermissionsEgress, '→'),
  };
}

class GraphBuilder {
  private readonly warnings = new Set<string>();
  private readonly containers = new Map<string, GraphContainer>();
  private readonly metas = new Map<string, NodeMeta>();
  private readonly nodesByResource = new Map<string, string[]>();
  private readonly edges = new Map<string, EdgeAcc>();
  private readonly alias = new Map<string, string>();
  private readonly byArn = new Map<string, Resource>();
  private readonly byId = new Map<string, Resource[]>();
  private readonly dnsIndex = new Map<string, Resource[]>();
  private readonly serviceUses: ServiceUse[] = [];
  private readonly net: NetworkModel;
  private readonly ev: Evaluator;
  private readonly resources: Resource[];

  constructor(
    private readonly snapshot: RawSnapshot,
    private readonly rules: RuleSet,
    private readonly profile: GraphProfile,
    private readonly options: BuildOptions,
  ) {
    this.resources = [...snapshot.resources, ...externalResources(profile)];
    this.net = buildNetworkModel(snapshot.resources);
    for (const p of NETWORK_PROVIDERS) {
      const own = snapshot.resources.filter((r) => p.owns(r.type));
      if (own.length) p.extend(this.net, own);
    }
    this.ev = new Evaluator(snapshot, this.resources, rules, this.warnings);
    for (const r of this.resources) {
      if (r.arn) this.byArn.set(r.arn, r);
      this.byId.set(r.id, [...(this.byId.get(r.id) ?? []), r]);
    }
  }

  async build(): Promise<Graph> {
    this.createNetworkContainers();
    for (const r of this.resources) await this.addResource(r);
    await this.indexDnsNames();
    this.applyProbes();
    this.decideGroups();
    for (const meta of [...this.metas.values()]) await this.addRelations(meta);
    this.addFlows();
    this.addPeerings();
    this.applyObservations();
    for (const e of this.snapshot.errors) {
      this.warnings.add(`${e.service} (${e.region}) : ${e.code} — ${e.message}`);
    }
    return this.finalize();
  }

  // ------------------------------------------------------------------ conteneurs

  /** Vue multi-comptes : un cadre par compte, qui contient son « Global » et ses régions. */
  private ensureAccount(account: string): string {
    const id = `account:${account}`;
    if (!this.containers.has(id)) {
      const label = this.options.accountLabels?.[account] ?? account;
      this.containers.set(id, { id, kind: 'account', label, sublabel: account });
    }
    return id;
  }

  private ensureGlobal(account?: string): string {
    const id = account ? `account:${account}/global` : 'global';
    if (!this.containers.has(id)) {
      this.containers.set(id, {
        id,
        kind: 'global',
        label: 'Global',
        ...(account ? { parentId: this.ensureAccount(account) } : {}),
      });
    }
    return id;
  }

  private ensureRegion(region: string, account?: string): string {
    if (region === 'global') return this.ensureGlobal(account);
    const id = account ? `account:${account}/region:${region}` : `region:${region}`;
    if (!this.containers.has(id)) {
      this.containers.set(id, {
        id,
        kind: 'region',
        label: region,
        ...(account ? { parentId: this.ensureAccount(account) } : {}),
      });
    }
    return id;
  }

  private createNetworkContainers(): void {
    for (const vpc of this.net.vpcs.values()) {
      this.containers.set(`vpc:${vpc.id}`, {
        id: `vpc:${vpc.id}`,
        kind: 'vpc',
        label: vpc.name ?? vpc.id,
        sublabel: vpc.cidrs.join(', '),
        parentId: this.ensureRegion(vpc.region, vpc.account),
      });
    }
    const kindText = {
      public: 'public',
      'private-nat': 'privé (NAT)',
      'private-isolated': 'privé isolé',
    } as const;
    for (const s of this.net.subnets.values()) {
      if (!this.containers.has(`vpc:${s.vpcId}`)) continue;
      const azId = `az:${s.vpcId}:${s.az}`;
      if (!this.containers.has(azId)) {
        this.containers.set(azId, { id: azId, kind: 'az', label: s.az, parentId: `vpc:${s.vpcId}` });
      }
      this.containers.set(`subnet:${s.id}`, {
        id: `subnet:${s.id}`,
        kind: s.kind === 'public' ? 'subnet-public' : 'subnet-private',
        label: s.cidr,
        sublabel: `${s.name ?? s.id} · ${kindText[s.kind]}`,
        parentId: azId,
      });
    }
  }

  private async placement(rule: Rule | undefined, r: Resource): Promise<(string | undefined)[]> {
    const fallback = this.ensureRegion(r.region, r.account);
    const p = rule?.placement;
    if (!p) return [fallback];
    switch (p.container) {
      case 'none':
        return [undefined];
      case 'global':
        return [this.ensureGlobal(r.account)];
      case 'region':
        return [fallback];
      case 'vpc': {
        const vpc = (await this.ev.strings(p.ref, r)).find((id) => this.containers.has(`vpc:${id}`));
        return [vpc ? `vpc:${vpc}` : fallback];
      }
      case 'az':
      case 'subnet': {
        const subnets = (await this.ev.strings(p.ref, r)).filter((id) => this.containers.has(`subnet:${id}`));
        if (subnets.length === 0) {
          const vpc = (await this.ev.strings(p.vpcRef, r)).find((id) => this.containers.has(`vpc:${id}`));
          return [vpc ? `vpc:${vpc}` : fallback];
        }
        const chosen = p.multi === 'replicate' ? subnets : subnets.slice(0, 1);
        return [
          ...new Set(
            chosen.map((id) => {
              const s = this.net.subnets.get(id);
              return p.container === 'subnet' || !s ? `subnet:${id}` : `az:${s.vpcId}:${s.az}`;
            }),
          ),
        ];
      }
    }
  }

  // ------------------------------------------------------------------ nœuds

  private matchesTagFilters(r: Resource): boolean {
    const filters = this.profile.tagFilters ?? [];
    if (filters.length === 0 || r.type.startsWith('External::')) return true;
    return filters.every((f) => {
      const v = r.tags?.[f.key];
      return v !== undefined && (f.values.length === 0 || f.values.includes(v));
    });
  }

  private async status(rule: Rule | undefined, r: Resource): Promise<{ status: NodeStatus; source: string }> {
    const raw = (r.raw ?? {}) as { _status?: unknown; _statusReason?: unknown };
    if (typeof raw._status === 'string' && (STATUSES as readonly string[]).includes(raw._status)) {
      const reason = typeof raw._statusReason === 'string' ? raw._statusReason : 'collecteur';
      return { status: raw._status as NodeStatus, source: reason };
    }
    for (const entry of rule?.status ?? []) {
      if ('default' in entry) return { status: entry.default, source: 'règle : valeur par défaut' };
      if (await this.ev.bool(entry.when, r)) return { status: entry.value, source: `règle : ${entry.when}` };
    }
    return { status: 'inconnu', source: 'aucune règle de statut' };
  }

  private async addResource(r: Resource): Promise<void> {
    const rule = findRule(this.rules, r.type);
    if (rule?.hidden || !this.matchesTagFilters(r)) return;
    const raw = (r.raw ?? {}) as Record<string, unknown>;
    const external = r.type.startsWith('External::');
    // Les nœuds externes déclarés dans le profil gardent leur libellé et leur sous-libellé.
    const label =
      (external && typeof raw.label === 'string' ? raw.label : undefined) ||
      (rule ? await this.ev.str(rule.label, r) : undefined) ||
      nameTag(r) ||
      resourceName(r);
    const sublabel =
      external && typeof raw.sublabel === 'string'
        ? raw.sublabel
        : rule?.sublabel
          ? await this.ev.str(rule.sublabel, r)
          : undefined;
    const { status, source } = await this.status(rule, r);
    const containerIds = await this.placement(rule, r);
    const sgs = await this.ev.strings(rule?.securityGroups, r);
    const ips = await this.ev.strings(rule?.ips, r);
    const groupKey = rule?.group ? ((await this.ev.str(rule.group.key, r)) ?? '') : '';
    const extra: Record<string, unknown> = {};
    for (const [k, source] of Object.entries(rule?.details ?? {})) extra[k] = await this.ev.value(source, r);
    const consoleUrl =
      (rule?.console ? await this.ev.str(rule.console, r) : undefined) ??
      (r.arn?.startsWith('arn:')
        ? `https://console.aws.amazon.com/go/view?arn=${encodeURIComponent(r.arn)}`
        : undefined);
    const icon = external && typeof raw.icon === 'string' ? raw.icon : (rule?.icon ?? 'generic');

    const baseId = resourceKey(r);
    const ids: string[] = [];
    for (const containerId of containerIds) {
      const id = containerIds.length > 1 ? `${baseId}@${containerId}` : baseId;
      const subnetId = containerId?.startsWith('subnet:') ? containerId.slice(7) : undefined;
      const vpcId = subnetId
        ? this.net.subnets.get(subnetId)?.vpcId
        : containerId?.startsWith('vpc:')
          ? containerId.slice(4)
          : containerId?.startsWith('az:')
            ? containerId.split(':')[1]
            : undefined;
      const node: GraphNode = {
        id,
        resourceRef: baseId,
        type: r.type,
        label,
        ...(sublabel ? { sublabel } : {}),
        icon,
        category: rule?.category ?? 'generic',
        status,
        ...(containerId ? { containerId } : {}),
        details: {
          typeLabel: rule?.typeLabel ?? r.type,
          resourceId: r.id,
          arn: r.arn,
          region: r.region,
          tags: r.tags ?? {},
          statusSource: source,
          securityGroups: sgs.map((sg) => sgSummary(this.net, sg)),
          ips,
          consoleUrl,
          generic: !rule,
          ...extra,
        },
      };
      this.metas.set(id, { node, resource: r, rule, sgs, ips, subnetId, vpcId, groupKey });
      ids.push(id);
    }
    this.nodesByResource.set(baseId, ids);
  }

  /** Nœud externe synthétique (Internet, domaine, plage CIDR) créé à la volée. */
  private syntheticExternal(id: string, type: string, label: string, sublabel?: string): string {
    if (this.metas.has(id)) return id;
    const rule = findRule(this.rules, type);
    const node: GraphNode = {
      id,
      type,
      label,
      ...(sublabel ? { sublabel } : {}),
      icon: rule?.icon ?? 'internet',
      category: rule?.category ?? 'external',
      status: 'inconnu',
      details: { typeLabel: rule?.typeLabel ?? type, statusSource: 'nœud externe déduit' },
    };
    this.metas.set(id, { node, sgs: [], ips: [], groupKey: '' });
    return id;
  }

  /** Nœud externe du profil correspondant à un domaine (ex. `gitlab.com` ↔ nœud d'id ou de libellé « GitLab »). */
  private profileExternalFor(host: string): string | undefined {
    const parts = host.split('.');
    const candidates = new Set([host, parts.length >= 2 ? parts[parts.length - 2] : host]);
    const match = (this.profile.externalNodes ?? []).find(
      (n) => candidates.has(n.id.toLowerCase()) || candidates.has(n.label.toLowerCase()),
    );
    if (!match) return undefined;
    const r = this.byId.get(`external:${match.id}`)?.[0];
    return r ? this.nodesByResource.get(resourceKey(r))?.[0] : undefined;
  }

  private internetNode(): string {
    const rule = findRule(this.rules, 'External::Internet');
    const label = rule && !rule.label.includes('$') ? rule.label : 'Internet';
    return this.syntheticExternal('external:internet', 'External::Internet', label);
  }

  private async indexDnsNames(): Promise<void> {
    for (const r of this.resources) {
      const rule = findRule(this.rules, r.type);
      if (!rule?.dnsNames) continue;
      for (const name of await this.ev.strings(rule.dnsNames, r)) {
        const host = normalizeHost(name);
        this.dnsIndex.set(host, [...(this.dnsIndex.get(host) ?? []), r]);
      }
    }
  }

  private metasForRef(ref: string): NodeMeta[] {
    const ids = new Set<string>([ref, ...(this.nodesByResource.get(ref) ?? [])]);
    for (const r of [
      ...(this.byId.get(ref) ?? []),
      ...(this.byArn.has(ref) ? [this.byArn.get(ref) as Resource] : []),
    ]) {
      for (const id of this.nodesByResource.get(resourceKey(r)) ?? []) ids.add(id);
    }
    return [...ids].map((id) => this.metas.get(id)).filter((m): m is NodeMeta => !!m);
  }

  private applyProbes(): void {
    for (const probe of this.profile.probes ?? []) {
      if (!probe.attachTo) continue;
      const result = this.snapshot.probes?.find((p) => p.url === probe.url);
      if (!result) continue;
      let prefix = 'HTTP';
      try {
        const path = new URL(probe.url).pathname;
        if (path && path !== '/') prefix = path;
      } catch {
        /* URL déjà validée par le schéma */
      }
      for (const meta of this.metasForRef(probe.attachTo)) {
        const n = meta.node;
        n.sublabel =
          result.status !== undefined
            ? `${prefix} ${result.status}`
            : `${prefix} : ${result.error ?? 'erreur'}`;
        n.details.probe = result;
        if (result.error || (result.status ?? 0) >= 500) {
          n.status = 'erreur';
          n.details.statusSource = `sonde ${probe.url}`;
        } else if ((result.status ?? 0) < 400) {
          n.status = 'actif';
          n.details.statusSource = `sonde ${probe.url}`;
        }
      }
    }
  }

  // ------------------------------------------------------------------ regroupement

  private decideGroups(): void {
    const threshold = this.options.groupingThreshold ?? 5;
    const expanded = new Set(this.options.expandedGroups ?? []);
    const buckets = new Map<string, NodeMeta[]>();
    for (const meta of this.metas.values()) {
      if (!meta.resource || meta.node.type.startsWith('External::')) continue;
      const key = `${meta.node.type}|${meta.node.containerId ?? ''}|${meta.groupKey}`;
      buckets.set(key, [...(buckets.get(key) ?? []), meta]);
    }
    for (const members of buckets.values()) {
      if (members.length <= threshold) continue;
      const first = members[0] as NodeMeta;
      const groupId = `group:${first.node.type}:${first.node.containerId ?? 'racine'}:${first.groupKey}`;
      if (expanded.has(groupId)) continue;
      const statuses = members.map((m) => m.node.status);
      const status: NodeStatus = statuses.includes('erreur')
        ? 'erreur'
        : statuses.includes('actif')
          ? 'actif'
          : first.node.status;
      const typeLabel = String(first.node.details.typeLabel ?? first.node.type);
      const group: GraphNode = {
        id: groupId,
        type: first.node.type,
        label: `${members.length} × ${typeLabel}`,
        sublabel: first.groupKey ? first.groupKey.split(/[/:]/).pop() : undefined,
        icon: first.node.icon,
        category: first.node.category,
        status,
        ...(first.node.containerId ? { containerId: first.node.containerId } : {}),
        groupCount: members.length,
        details: {
          typeLabel,
          statusSource: 'agrégat des membres',
          groupKey: first.groupKey,
          members: members.map((m) => ({ id: m.node.id, label: m.node.label, status: m.node.status })),
        },
      };
      if (!group.sublabel) delete group.sublabel;
      for (const m of members) this.alias.set(m.node.id, groupId);
      this.metas.set(groupId, { node: group, sgs: [], ips: [], groupKey: first.groupKey });
    }
  }

  private visible(id: string): string {
    return this.alias.get(id) ?? id;
  }

  // ------------------------------------------------------------------ arêtes

  private addEdge(e: {
    source: string;
    target: string;
    kind: EdgeKind;
    state: EdgeState;
    proto?: string;
    port?: string;
    label?: string;
    evidence: string[];
  }): EdgeAcc | undefined {
    const source = this.visible(e.source);
    const target = this.visible(e.target);
    if (source === target) return undefined;
    const suffix = e.proto ? `:${e.proto}` : e.label ? `:${e.label}` : '';
    const stateSuffix = e.state === 'bloque' ? ':bloque' : e.state === 'non-explique' ? ':obs' : '';
    const id = `${e.kind}:${source}->${target}${suffix}${stateSuffix}`;
    const acc = this.edges.get(id) ?? {
      source,
      target,
      kind: e.kind,
      state: e.state,
      ...(e.proto ? { proto: e.proto } : {}),
      ports: new Set<string>(),
      ...(e.label ? { label: e.label } : {}),
      evidence: new Set<string>(),
    };
    if (e.port) acc.ports.add(e.port);
    for (const ev of e.evidence) acc.evidence.add(ev);
    this.edges.set(id, acc);
    return acc;
  }

  private resolve(resolver: Resolver, value: string): string[] {
    const nodesOf = (rs: (Resource | undefined)[]) =>
      rs.flatMap((r) => (r ? (this.nodesByResource.get(resourceKey(r)) ?? []) : []));
    switch (resolver) {
      case 'arn': {
        const exact = this.byArn.get(value);
        if (exact) return nodesOf([exact]);
        // ARN suffixé (ex. secret avec clé JSON) : plus long ARN connu préfixe de la valeur.
        let best: Resource | undefined;
        for (const [arn, r] of this.byArn) {
          if (value.startsWith(arn) && arn.length > (best?.arn?.length ?? 0)) best = r;
        }
        return nodesOf([best]);
      }
      case 'id':
        return nodesOf([this.byArn.get(value), ...(this.byId.get(value) ?? [])]);
      case 'ecr-image': {
        const arn = ecrArn(value);
        if (arn) return nodesOf([this.byArn.get(arn)]);
        return nodesOf((this.byId.get(value) ?? []).filter((r) => r.arn?.includes(':repository/')));
      }
      case 'dns-name':
        return nodesOf(this.dnsIndex.get(normalizeHost(value)) ?? []);
      case 's3-bucket': {
        const bucket = bucketName(value);
        const byArn = [...this.byArn.values()].filter(
          (r) => /^arn:aws[a-z-]*:s3:::/.test(r.arn ?? '') && r.id === bucket,
        );
        return nodesOf(byArn.length ? byArn : (this.byId.get(bucket) ?? []));
      }
      case 'security-group':
        return [...this.metas.values()].filter((m) => m.sgs.includes(value)).map((m) => m.node.id);
      case 'target-group-targets': {
        if (/^\d+\.\d+\.\d+\.\d+$/.test(value)) {
          return [...this.metas.values()].filter((m) => m.ips.includes(value)).map((m) => m.node.id);
        }
        return nodesOf([this.byArn.get(value), ...(this.byId.get(value) ?? [])]);
      }
    }
  }

  private async addRelations(meta: NodeMeta): Promise<void> {
    const r = meta.resource;
    if (!r || !meta.rule?.relations) return;
    for (const rel of meta.rule.relations) {
      for (const value of await this.ev.strings(rel.to, r)) {
        let targets = this.resolve(rel.resolve ?? 'id', value);
        if (targets.length === 0) {
          if (rel.unresolved !== 'external') continue;
          const host = normalizeHost(value);
          targets = [
            this.profileExternalFor(host) ??
              this.syntheticExternal(
                `external:dns:${host}`,
                rel.externalType ?? 'External::Internet',
                host,
                'domaine externe',
              ),
          ];
        }
        for (const t of targets) {
          if (t === meta.node.id) continue;
          const [source, target] = rel.reverse ? [t, meta.node.id] : [meta.node.id, t];
          this.addEdge({
            source,
            target,
            kind: rel.kind,
            state: 'autorise',
            ...(rel.label ? { label: rel.label } : {}),
            evidence: [`relation ${r.type} : ${value}`],
          });
          const targetMeta = this.metas.get(t);
          const awsService = targetMeta?.rule?.awsService;
          // Seules les dépendances directes de la ressource (données, réseau) impliquent une sortie vers le service.
          const outbound = !rel.reverse && (rel.kind === 'data' || rel.kind === 'network');
          if (meta.subnetId && awsService && outbound && targetMeta) {
            this.serviceUses.push({
              from: this.flowNode(meta),
              serviceNode: t,
              awsService,
              serviceLabel: targetMeta.node.label,
            });
          }
        }
      }
    }
  }

  private flowNode(m: NodeMeta): FlowNode {
    return {
      id: m.node.id,
      type: m.node.type,
      label: m.node.label,
      sgs: m.sgs,
      ips: m.ips,
      ...(m.subnetId ? { subnetId: m.subnetId } : {}),
      ...(m.vpcId ? { vpcId: m.vpcId } : {}),
    };
  }

  /** Appairages actifs dont les deux VPC sont connus (même compte ou vue multi-comptes). */
  private addPeerings(): void {
    for (const p of this.net.peerings) {
      const [a, b] = [...new Set(p.vpcIds)].map((v) => `vpc:${v}`);
      if (!p.active || !a || !b || !this.containers.has(a) || !this.containers.has(b)) continue;
      this.addEdge({
        source: a,
        target: b,
        kind: 'network',
        state: 'autorise',
        label: 'appairage',
        evidence: [`appairage VPC ${p.id}`],
      });
    }
  }

  private cidrSource(cidr: string, vpcId: string | undefined): string | undefined {
    const subnets = [...this.net.subnets.values()].filter((s) => s.cidr === cidr);
    const subnet = subnets.find((s) => s.vpcId === vpcId) ?? subnets[0];
    if (subnet && this.containers.has(`subnet:${subnet.id}`)) return `subnet:${subnet.id}`;
    const vpcs = [...this.net.vpcs.values()];
    const vpc =
      vpcs.find((v) => v.id === vpcId && v.cidrs.includes(cidr)) ??
      vpcs.find((v) => v.cidrs.includes(cidr)) ??
      vpcs.find((v) => v.id === vpcId && v.cidrs.some((c) => cidrContains(c, cidr)));
    if (vpc && this.containers.has(`vpc:${vpc.id}`)) return `vpc:${vpc.id}`;
    const peering = this.net.peerings.find((p) => p.cidrs.includes(cidr));
    return this.syntheticExternal(
      `external:cidr:${cidr}`,
      'External::Internet',
      cidr,
      peering ? `VPC appairé (${peering.id})` : 'plage externe',
    );
  }

  private addFlows(): void {
    const flowNodes = [...this.metas.values()]
      .filter((m) => m.resource && (m.sgs.length || m.subnetId))
      .map((m) => this.flowNode(m));
    const ctx: FlowContext = {
      net: this.net,
      nodes: flowNodes,
      internetSource: (vpcId) => {
        const igw = vpcId ? this.net.igwByVpc.get(vpcId) : undefined;
        const igwNode = igw ? this.nodesByResource.get(resourceKey(igw))?.[0] : undefined;
        return igwNode ?? this.internetNode();
      },
      cidrSource: (cidr, vpcId) => this.cidrSource(cidr, vpcId),
    };
    const push = (f: FlowEdgeRequest) =>
      this.addEdge({
        source: f.source,
        target: f.target,
        kind: 'network',
        state: f.state,
        proto: f.proto,
        port: f.ports,
        evidence: f.evidence,
      });
    // AWS : groupes de sécurité et NACL ; autres fournisseurs : leurs propres règles, sur leurs nœuds.
    const others = new Set(NETWORK_PROVIDERS.flatMap((p) => flowNodes.filter((n) => p.owns(n.type))));
    inferSecurityGroupFlows({ ...ctx, nodes: flowNodes.filter((n) => !others.has(n)) }).forEach(push);
    for (const p of NETWORK_PROVIDERS) {
      const nodes = flowNodes.filter((n) => p.owns(n.type));
      if (nodes.length) p.flows({ ...ctx, nodes }).forEach(push);
    }
    const egress = inferEgressFlows(ctx, this.serviceUses, {
      nodeOf: (ref) => this.nodesByResource.get(ref)?.[0] ?? this.metasForRef(ref)[0]?.node.id,
    });
    egress.edges.forEach(push);
    egress.warnings.forEach((w) => this.warnings.add(w));
  }

  /** Flux observés (section 7.3) : correspondance des IP des Flow Logs avec les nœuds connus. */
  private applyObservations(): void {
    const observations = this.snapshot.flowObservations ?? [];
    if (observations.length === 0) return;
    const ipIndex = new Map<string, string[]>();
    for (const m of this.metas.values())
      for (const ip of m.ips) ipIndex.set(ip, [...(ipIndex.get(ip) ?? []), m.node.id]);
    const gatewayTypes = new Set(['AWS::EC2::InternetGateway', 'AWS::EC2::NatGateway']);

    for (const o of observations) {
      const proto = normProto(o.protocol);
      const srcs = ipIndex.get(o.srcIp) ?? (isPrivateIpv4(o.srcIp) ? [] : [this.internetNode()]);
      const dsts = ipIndex.get(o.dstIp) ?? [];
      const evidence = `flow logs : ${formatBytes(o.bytes)}`;
      for (const s of srcs.map((x) => this.visible(x))) {
        let candidates = dsts.map((d) => this.visible(d));
        if (candidates.length === 0 && !isPrivateIpv4(o.dstIp)) {
          candidates = [...this.edges.values()]
            .filter((e) => e.source === s && gatewayTypes.has(this.metas.get(e.target)?.node.type ?? ''))
            .map((e) => e.target);
        }
        for (const d of candidates) {
          const match = [...this.edges.values()].find(
            (e) =>
              e.kind === 'network' &&
              e.source === s &&
              e.target === d &&
              e.state !== 'bloque' &&
              (e.proto === 'all' || e.proto === proto) &&
              (e.proto === 'all' || portsCover(e.ports, o.dstPort)),
          );
          if (match) {
            match.state = 'observe';
            match.bytes = (match.bytes ?? 0) + o.bytes;
            match.evidence.add(evidence);
          } else {
            const added = this.addEdge({
              source: s,
              target: d,
              kind: 'network',
              state: 'non-explique',
              proto,
              port: String(o.dstPort),
              evidence: [evidence, 'aucune règle de groupe de sécurité correspondante'],
            });
            if (added) added.bytes = (added.bytes ?? 0) + o.bytes;
          }
        }
      }
    }
    for (const e of this.edges.values())
      if (e.kind === 'network' && e.state === 'autorise') e.state = 'inutilise';
  }

  // ------------------------------------------------------------------ finalisation

  private finalize(): Graph {
    const nodes = [...this.metas.values()].map((m) => m.node).filter((n) => !this.alias.has(n.id));
    const nodeIds = new Set(nodes.map((n) => n.id));
    const edges: GraphEdge[] = [];
    for (const [id, e] of this.edges) {
      if (!nodeIds.has(e.source) && !this.containers.has(e.source)) continue;
      if (!nodeIds.has(e.target) && !this.containers.has(e.target)) continue;
      edges.push({
        id,
        source: e.source,
        target: e.target,
        kind: e.kind,
        ...(e.kind === 'network' && e.proto
          ? { label: flowLabel(e.proto, [...e.ports]) }
          : e.label
            ? { label: e.label }
            : {}),
        state: e.state,
        evidence: [...e.evidence],
        ...(e.bytes ? { bytes: e.bytes } : {}),
      });
    }

    // Conteneurs conservés : ceux qui contiennent un nœud ou portent une arête, avec leurs ancêtres ;
    // un VPC conservé garde tous ses sous-réseaux (même vides).
    const used = new Set<string>();
    const markUp = (id: string | undefined) => {
      for (
        let c = id ? this.containers.get(id) : undefined;
        c && !used.has(c.id);
        c = c.parentId ? this.containers.get(c.parentId) : undefined
      ) {
        used.add(c.id);
      }
    };
    nodes.forEach((n) => markUp(n.containerId));
    edges.forEach((e) => {
      markUp(e.source);
      markUp(e.target);
    });
    for (const c of this.containers.values()) {
      if (c.kind === 'az' || c.kind.startsWith('subnet')) {
        const vpcId = c.kind === 'az' ? c.parentId : this.containers.get(c.parentId ?? '')?.parentId;
        if (vpcId && used.has(vpcId)) used.add(c.id);
      }
    }
    const containers = [...this.containers.values()].filter((c) => used.has(c.id));
    return { containers, nodes, edges, warnings: [...this.warnings] };
  }
}

/** Construit le graphe normalisé à partir d'un snapshot brut. Fonction pure : aucun appel réseau. */
export function buildGraph(
  snapshot: RawSnapshot,
  rules: RuleSet,
  profile: GraphProfile = {},
  options: BuildOptions = {},
): Promise<Graph> {
  return new GraphBuilder(snapshot, rules, profile, options).build();
}
