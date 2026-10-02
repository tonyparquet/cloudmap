import type { Graph, GraphEdge, GraphNode } from './schemas.ts';

export interface DiffEntry {
  id: string;
  changes: string[];
}

export interface GraphDiff {
  nodes: { added: string[]; removed: string[]; modified: DiffEntry[] };
  edges: { added: string[]; removed: string[]; modified: DiffEntry[] };
}

const NODE_FIELDS = ['status', 'label', 'sublabel', 'containerId', 'groupCount'] as const;
const EDGE_FIELDS = ['label', 'state'] as const;

function compare<T extends GraphNode | GraphEdge>(a: T[], b: T[], fields: readonly (keyof T)[]) {
  const before = new Map(a.map((x) => [x.id, x]));
  const after = new Map(b.map((x) => [x.id, x]));
  const added = [...after.keys()].filter((id) => !before.has(id));
  const removed = [...before.keys()].filter((id) => !after.has(id));
  const modified: DiffEntry[] = [];
  for (const [id, x] of after) {
    const old = before.get(id);
    if (!old) continue;
    const changes = fields
      .filter((f) => (old[f] ?? null) !== (x[f] ?? null))
      .map((f) => `${String(f)} : ${String(old[f] ?? '—')} → ${String(x[f] ?? '—')}`);
    if (changes.length) modified.push({ id, changes });
  }
  return { added, removed, modified };
}

/** Différences entre deux graphes : A (ancien) → B (récent). Les ports d'une arête sont dans son libellé. */
export function diff(a: Graph, b: Graph): GraphDiff {
  return {
    nodes: compare(a.nodes, b.nodes, NODE_FIELDS),
    edges: compare(a.edges, b.edges, EDGE_FIELDS),
  };
}
