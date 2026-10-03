import type { Graph } from '@carto/core';
import ELK, { type ElkExtendedEdge, type ElkNode } from 'elkjs/lib/elk.bundled.js';

export const NODE_W = 150;
export const NODE_H = 96;

const elk = new ELK();

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Mise en page ELK (section 9.1) : `layered`, direction DOWN, conteneurs hiérarchiques
 * (`INCLUDE_CHILDREN`), routage orthogonal. La structure attendue est imposée par des arêtes
 * factices d'ordonnancement (les partitions ELK ne sont pas appliquées en mode hiérarchique) :
 * externes → (Comptes →) Global → Régions ; services entrants au-dessus du VPC, cibles de sortie en dessous ;
 * zones de disponibilité → bordure du VPC (IGW, endpoints) ; sous-réseaux privés → publics.
 * Dans un VPC, seules les arêtes internes à un sous-réseau influencent la mise en page :
 * les zones restent côte à côte quels que soient les flux qui les traversent.
 */
export async function layoutGraph(graph: Graph): Promise<Map<string, Box>> {
  const containers = new Map(graph.containers.map((c) => [c.id, c]));
  const parentOf = new Map<string, string | undefined>([
    ...graph.containers.map((c) => [c.id, c.parentId] as const),
    ...graph.nodes.map((n) => [n.id, n.containerId] as const),
  ]);
  const ancestor = (id: string, kind: (k: string) => boolean): string | undefined => {
    for (let p = parentOf.get(id); p; p = parentOf.get(p)) if (kind(containers.get(p)?.kind ?? '')) return p;
    return undefined;
  };
  const vpcOf = (id: string) => (containers.get(id)?.kind === 'vpc' ? id : ancestor(id, (k) => k === 'vpc'));
  const subnetOf = (id: string) => ancestor(id, (k) => k.startsWith('subnet'));

  const elkNodes = new Map<string, ElkNode>();
  const root: ElkNode = {
    id: '__racine',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'DOWN',
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.spacing.nodeNode': '36',
      'elk.layered.spacing.nodeNodeBetweenLayers': '48',
      'elk.layered.spacing.edgeNodeBetweenLayers': '16',
      'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
    },
    children: [],
  };
  for (const c of graph.containers) {
    elkNodes.set(c.id, {
      id: c.id,
      children: [],
      layoutOptions: {
        'elk.padding':
          c.kind === 'subnet-public'
            ? '[top=18,left=18,bottom=40,right=18]'
            : '[top=42,left=18,bottom=18,right=18]',
        'elk.nodeSize.constraints': 'MINIMUM_SIZE',
        'elk.nodeSize.minimum': '(200,110)',
      },
    });
  }
  for (const c of graph.containers) {
    const parent = c.parentId ? elkNodes.get(c.parentId) : undefined;
    (parent ?? root).children?.push(elkNodes.get(c.id) as ElkNode);
  }
  for (const n of graph.nodes) {
    const node: ElkNode = { id: n.id, width: NODE_W, height: NODE_H };
    elkNodes.set(n.id, node);
    const parent = n.containerId ? elkNodes.get(n.containerId) : undefined;
    (parent ?? root).children?.push(node);
  }

  const edges: ElkExtendedEdge[] = [];
  const seen = new Set<string>();
  const add = (source: string, target: string) => {
    const key = `${source}>${target}`;
    if (source === target || seen.has(key) || !elkNodes.has(source) || !elkNodes.has(target)) return;
    seen.add(key);
    edges.push({ id: `e${edges.length}`, sources: [source], targets: [target] });
  };

  // Arêtes factices de structure, à la racine et dans chaque cadre « Compte » (vue multi-comptes) :
  // nœuds libres → Global → Régions ; à la racine, les externes restent au-dessus des comptes.
  const scopes = [undefined, ...graph.containers.filter((c) => c.kind === 'account').map((c) => c.id)];
  for (const scope of scopes) {
    const top = graph.containers.filter((c) => c.parentId === scope);
    const global = top.find((c) => c.kind === 'global');
    const regions = top.filter((c) => c.kind === 'region');
    const accounts = top.filter((c) => c.kind === 'account');
    for (const n of graph.nodes.filter((x) => x.containerId === scope))
      for (const c of global ? [global] : regions.length ? regions : accounts) add(n.id, c.id);
    if (global) for (const r of regions) add(global.id, r.id);
  }
  for (const r of graph.containers.filter((c) => c.kind === 'region')) {
    const vpcs = graph.containers.filter((c) => c.parentId === r.id && c.kind === 'vpc');
    for (const n of graph.nodes.filter((x) => x.containerId === r.id)) {
      const fromVpc = graph.edges.some((e) => e.target === n.id && vpcOf(e.source));
      const toVpc = graph.edges.some((e) => e.source === n.id && vpcOf(e.target));
      for (const v of vpcs) {
        if (fromVpc && !toVpc) add(v.id, n.id);
        else add(n.id, v.id);
      }
    }
  }
  for (const v of graph.containers.filter((c) => c.kind === 'vpc')) {
    const azs = graph.containers.filter((c) => c.parentId === v.id && c.kind === 'az');
    for (const n of graph.nodes.filter((x) => x.containerId === v.id)) for (const az of azs) add(az.id, n.id);
  }
  for (const az of graph.containers.filter((c) => c.kind === 'az')) {
    const subnets = graph.containers.filter((c) => c.parentId === az.id);
    for (const p of subnets.filter((s) => s.kind === 'subnet-private')) {
      for (const q of subnets.filter((s) => s.kind === 'subnet-public')) add(p.id, q.id);
    }
  }
  // Arêtes réelles, sauf celles qui traversent la structure interne d'un VPC ou relient deux comptes
  // (vue multi-comptes : les comptes restent côte à côte, les liens sont dessinés quand même).
  const accountOf = (id: string) => ancestor(id, (k) => k === 'account');
  for (const e of graph.edges) {
    const sv = vpcOf(e.source);
    if (sv && sv === vpcOf(e.target) && subnetOf(e.source) !== subnetOf(e.target)) continue;
    const sa = accountOf(e.source);
    const ta = accountOf(e.target);
    if (sa && ta && sa !== ta) continue;
    add(e.source, e.target);
  }
  root.edges = edges;

  const laid = await elk.layout(root);
  const boxes = new Map<string, Box>();
  const walk = (n: ElkNode) => {
    for (const c of n.children ?? []) {
      boxes.set(c.id, { x: c.x ?? 0, y: c.y ?? 0, width: c.width ?? NODE_W, height: c.height ?? NODE_H });
      walk(c);
    }
  };
  walk(laid);
  return boxes;
}
