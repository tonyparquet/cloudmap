import {
  EDGE_KINDS,
  EDGE_STATES,
  STATUSES,
  type Graph,
  type GraphDiff,
  type GraphEdge,
  type GraphNode,
} from '@carto/core';
import {
  Background,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
  type Edge,
  type Node,
} from '@xyflow/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { get, put } from '../api.ts';
import { t, tOr } from '../i18n/index.ts';
import type { ProfileView } from '../pages/Profiles.tsx';
import { Link } from '../router.tsx';
import { useApp } from '../store.ts';
import { Alert, Check, useLoad } from '../ui.tsx';
import { edgeStyle, edgeTypes, type FlowEdgeType } from './edges.tsx';
import { runExport, type ExportFormat } from './exports.ts';
import { layoutGraph, type Box } from './layout.ts';
import { nodeTypes, type DiffMark } from './nodes.tsx';
import { SidePanel } from './SidePanel.tsx';

interface SnapshotRow {
  id: string;
  created_at: string;
  source: string;
  resource_count: number;
}
type Positions = Record<string, { x: number; y: number }>;

interface Filters {
  kinds: string[];
  states: string[];
  categories: string[] | null;
  statuses: string[];
  tag: string;
  hideStandby: boolean;
  hideUnused: boolean;
}
const DEFAULT_FILTERS: Filters = {
  kinds: [...EDGE_KINDS],
  states: [...EDGE_STATES],
  categories: null,
  statuses: [...STATUSES],
  tag: '',
  hideStandby: false,
  hideUnused: false,
};

/** Fusion avant/après pour la comparaison : les éléments supprimés restent visibles, marqués en rouge. */
function mergeDiff(before: Graph, after: Graph, diff: GraphDiff) {
  const have = new Set(after.containers.map((c) => c.id));
  const removed = new Set(diff.nodes.removed);
  const removedEdges = new Set(diff.edges.removed);
  const graph: Graph = {
    containers: [...after.containers, ...before.containers.filter((c) => !have.has(c.id))],
    nodes: [...after.nodes, ...before.nodes.filter((n) => removed.has(n.id))],
    edges: [...after.edges, ...before.edges.filter((e) => removedEdges.has(e.id))],
    warnings: after.warnings,
  };
  const nodes = new Map<string, DiffMark>();
  const edges = new Map<string, DiffMark>();
  diff.nodes.added.forEach((id) => nodes.set(id, 'added'));
  diff.nodes.removed.forEach((id) => nodes.set(id, 'removed'));
  diff.nodes.modified.forEach((m) => nodes.set(m.id, 'modified'));
  diff.edges.added.forEach((id) => edges.set(id, 'added'));
  diff.edges.removed.forEach((id) => edges.set(id, 'removed'));
  diff.edges.modified.forEach((m) => edges.set(m.id, 'modified'));
  for (const c of before.containers) if (!have.has(c.id)) nodes.set(c.id, 'removed');
  return { graph, marks: { nodes, edges } };
}

function depth(id: string | undefined, graph: Graph): number {
  let d = 0;
  for (
    let c = graph.containers.find((x) => x.id === id);
    c?.parentId;
    c = graph.containers.find((x) => x.id === c?.parentId)
  )
    d++;
  return d;
}

interface MultiAccount {
  profileId: string;
  name: string;
  accountId: string;
  createdAt: string;
}

/** Diagramme d'un profil, ou vue multi-comptes (`multi` : profils dont les derniers snapshots sont fusionnés). */
function DiagramInner({ profileId, multi }: { profileId: string; multi?: string[] }) {
  const theme = useApp((s) => s.theme);
  const rf = useReactFlow();
  const multiKey = multi?.join(',');
  const profile = useLoad(
    () =>
      multi
        ? Promise.resolve<{ profile?: ProfileView }>({})
        : get<{ profile?: ProfileView }>(`/api/profiles/${profileId}`),
    [profileId, multiKey],
  );
  const snaps = useLoad(
    () =>
      multi
        ? Promise.resolve({ snapshots: [] as SnapshotRow[] })
        : get<{ snapshots: SnapshotRow[] }>(`/api/profiles/${profileId}/snapshots`),
    [profileId, multiKey],
  );
  const [accounts, setAccounts] = useState<{ list: MultiAccount[]; missing: string[]; canEdit: boolean }>();
  const [snapshotId, setSnapshotId] = useState<string>();
  const [compareId, setCompareId] = useState('');
  const [expanded, setExpanded] = useState<string[]>([]);
  const [infraGraph, setGraph] = useState<Graph>();
  const [orgGraph, setOrgGraph] = useState<Graph | null>(null);
  const [view, setView] = useState<'infra' | 'org'>('infra');
  const [marks, setMarks] = useState<{ nodes: Map<string, DiffMark>; edges: Map<string, DiffMark> }>();
  const [errors, setErrors] = useState<{ service: string; region: string; message: string }[]>([]);
  const [boxes, setBoxes] = useState<Map<string, Box>>();
  const [positions, setPositions] = useState<Positions>({});
  const [selected, setSelected] = useState<string>();
  const [hover, setHover] = useState<{ edge: GraphEdge; x: number; y: number }>();
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [search, setSearch] = useState('');
  const [panel, setPanel] = useState<'filtres' | 'export' | 'avert' | undefined>();
  const [loadError, setLoadError] = useState<string>();
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const saveTimer = useRef<number | undefined>(undefined);
  const canEdit = multi ? (accounts?.canEdit ?? false) : (profile.data?.profile?.canEdit ?? false);
  const current = multi ? 'multi' : (snapshotId ?? snaps.data?.snapshots[0]?.id);
  const layoutUrl = multi
    ? `/api/multi/layout?profiles=${encodeURIComponent(multiKey ?? '')}`
    : `/api/profiles/${profileId}/layout`;
  const orgView = view === 'org' && orgGraph !== null;
  const graph = orgView ? orgGraph : infraGraph;
  const fitPending = useRef(false);

  useEffect(() => {
    if (!current) return;
    let alive = true;
    (async () => {
      const layout = await get<{ positions: Positions }>(layoutUrl);
      if (multi) {
        const q = expanded.length ? `&expand=${encodeURIComponent(expanded.join(','))}` : '';
        const r = await get<{
          graph: Graph;
          errors: { service: string; region: string; message: string }[];
          accounts: MultiAccount[];
          missing: string[];
          canEdit: boolean;
        }>(`/api/multi/graph?profiles=${encodeURIComponent(multiKey ?? '')}${q}`);
        if (!alive) return;
        setGraph(r.graph);
        setErrors(r.errors);
        setMarks(undefined);
        setAccounts({ list: r.accounts, missing: r.missing, canEdit: r.canEdit });
      } else if (compareId) {
        const d = await get<{ before: Graph; after: Graph; diff: GraphDiff }>(
          `/api/snapshots/${compareId}/diff/${current}`,
        );
        const merged = mergeDiff(d.before, d.after, d.diff);
        if (!alive) return;
        setGraph(merged.graph);
        setMarks(merged.marks);
      } else {
        const q = expanded.length ? `?expand=${encodeURIComponent(expanded.join(','))}` : '';
        const r = await get<{ graph: Graph; errors: { service: string; region: string; message: string }[] }>(
          `/api/snapshots/${current}/graph${q}`,
        );
        if (!alive) return;
        setGraph(r.graph);
        setErrors(r.errors);
        setMarks(undefined);
      }
      setPositions(layout.positions);
      setLoadError(undefined);
    })().catch((err: Error) => alive && setLoadError(err.message));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- multiKey et layoutUrl résument `multi`
  }, [current, compareId, expanded, profileId, multiKey]);

  // Vue « Organisation » : proposée seulement si le snapshot contient Organizations ou Identity Center.
  useEffect(() => {
    if (!current || multi) return;
    let alive = true;
    get<{ graph: Graph | null }>(`/api/snapshots/${current}/org-graph`)
      .then((r) => alive && setOrgGraph(r.graph))
      .catch(() => alive && setOrgGraph(null));
    return () => {
      alive = false;
    };
  }, [current, multi]);

  useEffect(() => {
    if (!graph) return;
    let alive = true;
    fitPending.current = true;
    layoutGraph(graph)
      .then((b) => alive && setBoxes(b))
      .catch((err: Error) => alive && setLoadError(err.message));
    return () => {
      alive = false;
    };
  }, [graph]);

  const categories = useMemo(() => [...new Set(graph?.nodes.map((n) => n.category) ?? [])].sort(), [graph]);

  const visibility = useMemo(() => {
    const visibleNodes = new Set<string>();
    if (!graph) return { visibleNodes, visibleEdges: new Set<string>(), matches: new Set<string>() };
    const [tagKey, tagValue] = filters.tag.split('=').map((s) => s.trim());
    for (const n of graph.nodes) {
      const tags = (n.details.tags ?? {}) as Record<string, string>;
      const ok =
        filters.statuses.includes(n.status) &&
        (!filters.categories || filters.categories.includes(n.category)) &&
        !(filters.hideStandby && n.status === 'en-veille') &&
        (!tagKey || (tagValue ? tags[tagKey] === tagValue : tagKey in tags) || n.category === 'external');
      if (ok) visibleNodes.add(n.id);
    }
    const containerIds = new Set(graph.containers.map((c) => c.id));
    const visibleEdges = new Set(
      graph.edges
        .filter(
          (e) =>
            filters.kinds.includes(e.kind) &&
            filters.states.includes(e.state) &&
            !(filters.hideUnused && e.state === 'inutilise') &&
            (visibleNodes.has(e.source) || containerIds.has(e.source)) &&
            (visibleNodes.has(e.target) || containerIds.has(e.target)),
        )
        .map((e) => e.id),
    );
    const q = search.trim().toLowerCase();
    const matches = new Set(
      q
        ? graph.nodes
            .filter((n) =>
              [
                n.label,
                n.sublabel,
                n.id,
                n.details.resourceId,
                ...((n.details.ips as string[] | undefined) ?? []),
              ].some((v) =>
                String(v ?? '')
                  .toLowerCase()
                  .includes(q),
              ),
            )
            .map((n) => n.id)
        : [],
    );
    return { visibleNodes, visibleEdges, matches };
  }, [graph, filters, search]);

  const focus = useMemo(() => {
    if (!selected || !graph) return undefined;
    const edges = new Set(
      graph.edges.filter((e) => e.source === selected || e.target === selected).map((e) => e.id),
    );
    const nodesSet = new Set([
      selected,
      ...graph.edges.filter((e) => edges.has(e.id)).flatMap((e) => [e.source, e.target]),
    ]);
    return { edges, nodes: nodesSet };
  }, [selected, graph]);

  useEffect(() => {
    if (!graph || !boxes) return;
    const out: Node[] = [];
    const containers = [...graph.containers].sort((a, b) => depth(a.id, graph) - depth(b.id, graph));
    for (const c of containers) {
      const box = boxes.get(c.id);
      if (!box) continue;
      out.push({
        id: c.id,
        type: 'container',
        position: positions[c.id] ?? { x: box.x, y: box.y },
        ...(c.parentId ? { parentId: c.parentId } : {}),
        data: { container: c, theme, diff: orgView ? undefined : marks?.nodes.get(c.id) },
        style: { width: box.width, height: box.height },
        selectable: false,
        zIndex: 0,
      });
    }
    for (const n of graph.nodes) {
      const box = boxes.get(n.id);
      if (!box) continue;
      out.push({
        id: n.id,
        type: 'resource',
        position: positions[n.id] ?? { x: box.x, y: box.y },
        ...(n.containerId && boxes.has(n.containerId)
          ? { parentId: n.containerId, extent: 'parent' as const }
          : {}),
        hidden: !visibility.visibleNodes.has(n.id),
        data: {
          node: n,
          theme,
          dim: !!focus && !focus.nodes.has(n.id),
          match: visibility.matches.has(n.id),
          diff: orgView ? undefined : marks?.nodes.get(n.id),
        },
        zIndex: 2,
      });
    }
    setNodes(out);
  }, [graph, boxes, positions, theme, visibility, focus, marks, orgView, setNodes]);

  // Nouvelle mise en page (changement de vue ou de snapshot) : recadrage une fois les nœuds posés.
  useEffect(() => {
    if (!fitPending.current || nodes.length === 0) return;
    fitPending.current = false;
    window.requestAnimationFrame(() => void rf.fitView({ duration: 300 }));
  }, [nodes, rf]);

  const edges: FlowEdgeType[] = useMemo(
    () =>
      (graph?.edges ?? []).map((e) => {
        const diff = orgView ? undefined : marks?.edges.get(e.id);
        return {
          id: e.id,
          source: e.source,
          target: e.target,
          type: 'flow' as const,
          hidden: !visibility.visibleEdges.has(e.id),
          zIndex: 1,
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: edgeStyle(e, theme, diff).color,
            width: 16,
            height: 16,
          },
          data: {
            edge: e,
            theme,
            dim: !!focus && !focus.edges.has(e.id),
            focused: !!focus?.edges.has(e.id),
            diff,
          },
        };
      }),
    [graph, theme, visibility, focus, marks, orgView],
  );

  const savePositions = useCallback(
    (next: Positions) => {
      setPositions(next);
      if (!canEdit) return;
      window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => {
        void put(layoutUrl, { positions: next }).then(() =>
          useApp.getState().showToast(t('diag.miseEnPageEnregistree')),
        );
      }, 600);
    },
    [canEdit, layoutUrl],
  );

  const exportAs = async (format: ExportFormat) => {
    setPanel(undefined);
    const visible = rf.getNodes().filter((n) => !n.hidden);
    if (!graph) return;
    await runExport(format, {
      bounds: rf.getNodesBounds(visible),
      nodes: rf.getNodes(),
      graph: { ...graph, edges: graph.edges.filter((e) => visibility.visibleEdges.has(e.id)) },
      theme,
      profileId: multi?.[0] ?? profileId,
      name: multi
        ? 'multi-comptes'
        : `${profile.data?.profile?.name ?? 'diagramme'}${orgView ? '-organisation' : ''}`,
    });
  };

  const selectedNode = graph?.nodes.find((n) => n.id === selected);
  const snapshots = snaps.data?.snapshots ?? [];
  const toggle = (list: string[], v: string, on: boolean) =>
    on ? [...list, v] : list.filter((x) => x !== v);

  if (!multi && snaps.data && snapshots.length === 0)
    return (
      <div className="empty">
        <p>{t('diag.aucunSnapshot')}</p>
        {canEdit && (
          <Link to={`/profils/${profileId}/demarrage`} className="btn primary">
            {t('diag.miseEnRoute')}
          </Link>
        )}
      </div>
    );

  return (
    <>
      <div className="diagram" data-testid="diagramme">
        <div className="toolbar">
          {multi ? (
            <Link to={`/multi-comptes?profils=${multiKey ?? ''}`} className="btn">
              {t('multi.comptes', { n: accounts?.list.length ?? multi.length })}
            </Link>
          ) : (
            <select
              aria-label={t('diag.snapshot')}
              value={current ?? ''}
              onChange={(e) => setSnapshotId(e.target.value)}
            >
              {snapshots.map((s) => (
                <option key={s.id} value={s.id}>
                  {new Date(s.created_at).toLocaleString('fr-FR')} · {s.resource_count}
                </option>
              ))}
            </select>
          )}
          {orgGraph && !multi && (
            <div className="segmented" role="group" aria-label={t('diag.vue')}>
              {(['infra', 'org'] as const).map((v) => (
                <button
                  key={v}
                  aria-pressed={view === v}
                  className={view === v ? 'active' : ''}
                  onClick={() => {
                    setView(v);
                    setSelected(undefined);
                    setCompareId('');
                  }}
                >
                  {t(v === 'org' ? 'diag.vueOrg' : 'diag.vueInfra')}
                </button>
              ))}
            </div>
          )}
          {!orgView && !multi && (
            <select
              aria-label={t('diag.comparer')}
              value={compareId}
              onChange={(e) => setCompareId(e.target.value)}
            >
              <option value="">{t('diag.comparer')}</option>
              {snapshots
                .filter((s) => s.id !== current)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {new Date(s.created_at).toLocaleString('fr-FR')}
                  </option>
                ))}
            </select>
          )}
          <input
            aria-label={t('diag.recherche')}
            placeholder={t('diag.recherche')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && visibility.matches.size)
                void rf.fitView({
                  nodes: [...visibility.matches].map((id) => ({ id })),
                  duration: 400,
                  maxZoom: 1.2,
                });
            }}
          />
          <div className="rel">
            <button onClick={() => setPanel(panel === 'filtres' ? undefined : 'filtres')}>
              {t('diag.filtres')}
            </button>
            {panel === 'filtres' && (
              <div className="popover" data-testid="filtres">
                <h3>{t('diag.typesFlux')}</h3>
                {EDGE_KINDS.map((k) => (
                  <Check
                    key={k}
                    label={tOr(`kind.${k}`, k)}
                    checked={filters.kinds.includes(k)}
                    onChange={(v) => setFilters({ ...filters, kinds: toggle(filters.kinds, k, v) })}
                  />
                ))}
                <h3>{t('diag.etatsFlux')}</h3>
                {EDGE_STATES.map((k) => (
                  <Check
                    key={k}
                    label={tOr(`etat.${k}`, k)}
                    checked={filters.states.includes(k)}
                    onChange={(v) => setFilters({ ...filters, states: toggle(filters.states, k, v) })}
                  />
                ))}
                <h3>{t('diag.statuts')}</h3>
                {STATUSES.map((k) => (
                  <Check
                    key={k}
                    label={tOr(`statut.${k}`, k)}
                    checked={filters.statuses.includes(k)}
                    onChange={(v) => setFilters({ ...filters, statuses: toggle(filters.statuses, k, v) })}
                  />
                ))}
                <h3>{t('diag.categories')}</h3>
                {categories.map((k) => (
                  <Check
                    key={k}
                    label={tOr(`cat.${k}`, k)}
                    checked={!filters.categories || filters.categories.includes(k)}
                    onChange={(v) =>
                      setFilters({ ...filters, categories: toggle(filters.categories ?? categories, k, v) })
                    }
                  />
                ))}
                <h3>{t('diag.tag')}</h3>
                <input
                  value={filters.tag}
                  onChange={(e) => setFilters({ ...filters, tag: e.target.value })}
                  placeholder="Environnement=prod"
                />
                <div style={{ marginTop: 10 }}>
                  <Check
                    label={t('diag.masquerVeille')}
                    checked={filters.hideStandby}
                    onChange={(v) => setFilters({ ...filters, hideStandby: v })}
                  />
                  <Check
                    label={t('diag.masquerInutilises')}
                    checked={filters.hideUnused}
                    onChange={(v) => setFilters({ ...filters, hideUnused: v })}
                  />
                </div>
              </div>
            )}
          </div>
          <button
            onClick={() => {
              savePositions({});
              void rf.fitView({ duration: 400 });
            }}
          >
            {t('diag.reorganiser')}
          </button>
          <div className="rel">
            <button onClick={() => setPanel(panel === 'export' ? undefined : 'export')}>
              {t('diag.exporter')}
            </button>
            {panel === 'export' && (
              <div className="popover" style={{ minWidth: 160 }}>
                {(['svg', 'png', 'pdf', 'drawio', 'json'] as const).map((f) => (
                  <div key={f} style={{ marginBottom: 6 }}>
                    <button onClick={() => void exportAs(f)} style={{ width: '100%' }}>
                      {t(`export.${f}`)}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
          {(graph?.warnings.length ?? 0) + errors.length > 0 && (
            <div className="rel">
              <button onClick={() => setPanel(panel === 'avert' ? undefined : 'avert')}>
                ⚠ {t('diag.avertissements')} ({graph?.warnings.length ?? 0})
              </button>
              {panel === 'avert' && (
                <div className="popover" style={{ width: 460 }}>
                  <ul className="small">
                    {graph?.warnings.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
        {(loadError || (accounts?.missing.length ?? 0) > 0) && (
          <div style={{ position: 'absolute', top: 56, left: 10, zIndex: 6 }}>
            {loadError && <Alert kind="error">{loadError}</Alert>}
            {accounts && accounts.missing.length > 0 && (
              <Alert kind="warn">{t('multi.sansSnapshot', { profils: accounts.missing.join(', ') })}</Alert>
            )}
          </div>
        )}
        <ReactFlow
          nodes={nodes}
          edges={edges as Edge[]}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          onNodeClick={(_e, n) => n.type === 'resource' && setSelected(n.id)}
          onNodeDoubleClick={(_e, n) => {
            if (n.id.startsWith('group:')) setExpanded((x) => [...x, n.id]);
          }}
          onPaneClick={() => {
            setSelected(undefined);
            setPanel(undefined);
          }}
          onNodeDragStop={(_e, _n, dragged) => {
            const next = { ...positions };
            for (const d of dragged)
              next[d.id] = { x: Math.round(d.position.x), y: Math.round(d.position.y) };
            savePositions(next);
          }}
          onEdgeMouseEnter={(e, edge) => {
            const g = graph?.edges.find((x) => x.id === edge.id);
            if (g) setHover({ edge: g, x: e.clientX, y: e.clientY });
          }}
          onEdgeMouseMove={(e) => setHover((h) => (h ? { ...h, x: e.clientX, y: e.clientY } : h))}
          onEdgeMouseLeave={() => setHover(undefined)}
          fitView
          minZoom={0.05}
          maxZoom={2.5}
          nodesConnectable={false}
          proOptions={{ hideAttribution: true }}
          colorMode={theme.bg.toLowerCase() > '#888888' ? 'light' : 'dark'}
        >
          <Background color={theme.panelBorder} gap={24} />
          <MiniMap
            pannable
            zoomable
            style={{ background: theme.panel }}
            nodeColor={(n) =>
              n.type === 'container'
                ? 'transparent'
                : (theme.category[(n.data as { node: GraphNode }).node.category] ?? '#666')
            }
            nodeStrokeColor={(n) => (n.type === 'container' ? theme.panelBorder : 'transparent')}
          />
          <Controls showInteractive={false} />
        </ReactFlow>
        {marks && !orgView && (
          <div className="legend">
            <span style={{ color: theme.status.actif }}>■ {t('diag.legendeAjoute')}</span>
            <span style={{ color: theme.status.erreur }}>■ {t('diag.legendeSupprime')}</span>
            <span style={{ color: theme.edge.unexplained.color }}>■ {t('diag.legendeModifie')}</span>
          </div>
        )}
        {hover && (
          <div className="tooltip" style={{ left: hover.x + 14, top: hover.y + 14 }} data-testid="info-arete">
            <div>
              <strong>{tOr(`kind.${hover.edge.kind}`, hover.edge.kind)}</strong>
            </div>
            {hover.edge.label && (
              <div>
                {t('edge.protocole')} : {hover.edge.label}
              </div>
            )}
            <div>
              {t('edge.etat')} : {tOr(`etat.${hover.edge.state}`, hover.edge.state)}
            </div>
            {hover.edge.evidence.length > 0 && (
              <>
                <div className="muted">{t('edge.preuves')} :</div>
                <ul style={{ margin: 0, paddingLeft: 16 }}>
                  {hover.edge.evidence.map((ev) => (
                    <li key={ev}>{ev}</li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
      </div>
      {selectedNode && graph && (
        <SidePanel
          node={selectedNode}
          graph={graph}
          onClose={() => setSelected(undefined)}
          onExpand={(id) => {
            setSelected(undefined);
            setExpanded((x) => [...x, id]);
          }}
        />
      )}
    </>
  );
}

export function Diagram({ profileId, multi }: { profileId: string; multi?: string[] }) {
  return (
    <ReactFlowProvider>
      <DiagramInner profileId={profileId} multi={multi} />
    </ReactFlowProvider>
  );
}
