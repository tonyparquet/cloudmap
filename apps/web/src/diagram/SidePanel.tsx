import type { Graph, GraphNode } from '@carto/core';
import { t, tOr } from '../i18n/index.ts';
import { Icon } from '../icons.tsx';

interface SgSummary {
  id: string;
  name?: string;
  inbound: string[];
  outbound: string[];
}

const SHOWN = new Set([
  'typeLabel',
  'resourceId',
  'arn',
  'region',
  'tags',
  'statusSource',
  'securityGroups',
  'ips',
  'consoleUrl',
  'members',
  'generic',
  'groupKey',
  'probe',
]);

function value(v: unknown): string {
  if (v === undefined || v === null || v === '') return '—';
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v.join(', ') || '—';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

/** Panneau latéral d'un nœud (section 9.4). */
export function SidePanel({
  node,
  graph,
  onClose,
  onExpand,
}: {
  node: GraphNode;
  graph: Graph;
  onClose: () => void;
  onExpand: (id: string) => void;
}) {
  const d = node.details;
  const tags = (d.tags ?? {}) as Record<string, string>;
  // Marqueurs internes de l'inférence des flux (« schéma:… », Google Cloud) : non affichés.
  const sgs = ((d.securityGroups ?? []) as SgSummary[]).filter((sg) => !sg.id.startsWith('schéma:'));
  const sgTitle = node.type.includes('.googleapis.com/')
    ? t('panel.sg.gcp')
    : node.type.startsWith('microsoft.')
      ? t('panel.sg.azure')
      : t('panel.sg');
  const ips = (d.ips ?? []) as string[];
  const label = (id: string) =>
    graph.nodes.find((n) => n.id === id)?.label ?? graph.containers.find((c) => c.id === id)?.label ?? id;
  const linked = graph.edges.filter((e) => e.source === node.id || e.target === node.id);
  const members = (d.members ?? []) as { id: string; label: string; status: string }[];
  const extra = Object.entries(d).filter(([k, v]) => !SHOWN.has(k) && v !== undefined && v !== null);
  return (
    <aside className="side" data-testid="panneau">
      <div className="row">
        <h2 style={{ margin: 0 }}>{node.label}</h2>
        <span className="spacer" />
        <button onClick={onClose} aria-label={t('commun.fermer')} className="icon-btn">
          <Icon name="x" />
        </button>
      </div>
      {node.sublabel && <p className="muted">{node.sublabel}</p>}
      <dl>
        <dt>{t('panel.type')}</dt>
        <dd>
          {value(d.typeLabel)} <span className="muted small">({node.type})</span>
        </dd>
        {d.resourceId !== undefined && (
          <>
            <dt>{t('panel.id')}</dt>
            <dd className="mono">{value(d.resourceId)}</dd>
          </>
        )}
        {typeof d.arn === 'string' && (
          <>
            <dt>{t('panel.arn')}</dt>
            <dd className="mono">{d.arn}</dd>
          </>
        )}
        {d.region !== undefined && (
          <>
            <dt>{t('panel.region')}</dt>
            <dd>{value(d.region)}</dd>
          </>
        )}
        <dt>{t('panel.statut')}</dt>
        <dd>{tOr(`statut.${node.status}`, node.status)}</dd>
        <dt>{t('panel.source')}</dt>
        <dd className="small">{value(d.statusSource)}</dd>
        {ips.length > 0 && (
          <>
            <dt>{t('panel.ips')}</dt>
            <dd className="mono">{ips.join(', ')}</dd>
          </>
        )}
      </dl>
      {typeof d.consoleUrl === 'string' &&
        /^https:\/\/[\w.-]*console\.aws\.amazon\.com\//.test(d.consoleUrl) && (
          <p>
            <a href={d.consoleUrl} target="_blank" rel="noopener noreferrer">
              {t('panel.console')} ↗
            </a>
          </p>
        )}
      {members.length > 0 && (
        <>
          <h3>{t('panel.membres')}</h3>
          <button onClick={() => onExpand(node.id)}>{t('panel.deplier')}</button>
          <ul>
            {members.map((m) => (
              <li key={m.id}>
                {m.label} <span className="muted">({tOr(`statut.${m.status}`, m.status)})</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {Object.keys(tags).length > 0 && (
        <>
          <h3>{t('panel.tags')}</h3>
          <div>
            {Object.entries(tags).map(([k, v]) => (
              <span key={k} className="badge">
                {k}={v}
              </span>
            ))}
          </div>
        </>
      )}
      {sgs.length > 0 && (
        <>
          <h3>{sgTitle}</h3>
          {sgs.map((sg) => (
            <div key={sg.id} style={{ marginBottom: 8 }}>
              <div className="mono">
                {sg.id} {sg.name && <span className="muted">({sg.name})</span>}
              </div>
              <div className="small muted">{t('panel.entrantes')}</div>
              <ul className="mono">
                {sg.inbound.length ? sg.inbound.map((l) => <li key={l}>{l}</li>) : <li>—</li>}
              </ul>
              <div className="small muted">{t('panel.sortantes')}</div>
              <ul className="mono">
                {sg.outbound.length ? sg.outbound.map((l) => <li key={l}>{l}</li>) : <li>—</li>}
              </ul>
            </div>
          ))}
        </>
      )}
      {linked.length > 0 && (
        <>
          <h3>{t('panel.liees')}</h3>
          <ul>
            {linked.map((e) => (
              <li key={e.id}>
                {e.source === node.id ? `→ ${label(e.target)}` : `← ${label(e.source)}`}{' '}
                <span className="muted">
                  ({tOr(`kind.${e.kind}`, e.kind)}
                  {e.label ? ` · ${e.label}` : ''} · {tOr(`etat.${e.state}`, e.state)})
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      {extra.length > 0 && (
        <>
          <h3>{t('panel.details')}</h3>
          <dl>
            {extra.map(([k, v]) => (
              <div key={k} style={{ display: 'contents' }}>
                <dt>{tOr(`detail.${k}`, k)}</dt>
                <dd className="mono">{value(v)}</dd>
              </div>
            ))}
          </dl>
        </>
      )}
    </aside>
  );
}
