import type { GraphContainer, GraphNode } from '@carto/core';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { memo } from 'react';
import { tOr } from '../i18n/index.ts';
import type { Theme } from '../theme.ts';

export type DiffMark = 'added' | 'removed' | 'modified' | undefined;

export type ResourceNodeData = {
  node: GraphNode;
  theme: Theme;
  dim: boolean;
  match: boolean;
  diff: DiffMark;
};
export type ContainerNodeData = { container: GraphContainer; theme: Theme; diff: DiffMark };
export type ResourceFlowNode = Node<ResourceNodeData, 'resource'>;
export type ContainerFlowNode = Node<ContainerNodeData, 'container'>;

export function statusColor(theme: Theme, status: string): string {
  return status === 'actif'
    ? theme.status.actif
    : status === 'erreur'
      ? theme.status.erreur
      : theme.status.autre;
}

const hidden = 'handle-hidden';

export const ResourceNode = memo(function ResourceNode({ data }: NodeProps<ResourceFlowNode>) {
  const { node, theme, dim, match, diff } = data;
  const tile = theme.node.tile;
  const color = theme.category[node.category] ?? theme.category.generic ?? '#4b5563';
  const pill = statusColor(theme, node.status);
  const external = node.category === 'external';
  return (
    <div
      className={`rn${diff ? ` diff-${diff}` : ''}${match ? ' match' : ''}`}
      style={{ opacity: dim ? 0.22 : 1 }}
      data-testid="noeud"
      data-label={node.label}
      data-status={node.status}
      title={`${node.label}${node.sublabel ? ` — ${node.sublabel}` : ''} (${tOr(`statut.${node.status}`, node.status)})`}
    >
      <Handle type="target" position={Position.Top} className={hidden} isConnectable={false} />
      <div
        className="tile"
        style={{
          width: tile.size,
          height: tile.size,
          borderRadius: tile.radius,
          borderWidth: tile.border,
          background: color,
          borderColor: node.status === 'actif' ? pill : tile.borderColor,
        }}
      >
        <img
          src={`/icons/${encodeURIComponent(node.icon)}?category=${encodeURIComponent(node.category)}`}
          alt=""
          draggable={false}
        />
        {!external && <span className="pill" style={{ background: pill }} />}
        {node.groupCount ? <span className="count">{node.groupCount}</span> : null}
      </div>
      <div
        className="lbl"
        style={{
          color: theme.node.label.color,
          fontSize: theme.node.label.size,
          fontWeight: theme.node.label.weight,
        }}
      >
        {node.label}
      </div>
      {node.sublabel && (
        <div className="sub" style={{ color: theme.node.sublabel.color, fontSize: theme.node.sublabel.size }}>
          {node.sublabel}
        </div>
      )}
      <Handle type="source" position={Position.Bottom} className={hidden} isConnectable={false} />
    </div>
  );
});

const Lock = ({ color }: { color: string }) => (
  <svg width="11" height="12" viewBox="0 0 11 12" aria-hidden="true">
    <rect x="1" y="5" width="9" height="6.5" rx="1.5" fill="none" stroke={color} strokeWidth="1.3" />
    <path d="M3 5V3.5a2.5 2.5 0 0 1 5 0V5" fill="none" stroke={color} strokeWidth="1.3" />
  </svg>
);
const Flag = ({ color }: { color: string }) => (
  <svg width="13" height="14" viewBox="0 0 13 14" aria-hidden="true">
    <path
      d="M2 13V1.5M2 2h8l-2 3 2 3H2"
      fill="none"
      stroke={color}
      strokeWidth="1.4"
      strokeLinejoin="round"
    />
  </svg>
);
const Cloud = ({ color }: { color: string }) => (
  <svg width="16" height="12" viewBox="0 0 16 12" aria-hidden="true">
    <path
      d="M4.5 10.5h7.5a3 3 0 0 0 .4-6A4.2 4.2 0 0 0 4.3 4 3.3 3.3 0 0 0 4.5 10.5z"
      fill="none"
      stroke={color}
      strokeWidth="1.3"
    />
  </svg>
);

export const ContainerNode = memo(function ContainerNode({
  data,
  width,
  height,
}: NodeProps<ContainerFlowNode>) {
  const { container: c, theme, diff } = data;
  const key =
    c.kind === 'subnet-public' ? 'subnetPublic' : c.kind === 'subnet-private' ? 'subnetPrivate' : c.kind;
  const tok = theme.container[key];
  const w = width ?? 200;
  const h = height ?? 110;
  const stroke = diff === 'added' ? theme.status.actif : diff === 'removed' ? theme.status.erreur : tok.color;
  return (
    <div className="cn" data-testid="conteneur" data-kind={c.kind}>
      <Handle type="target" position={Position.Top} className={hidden} isConnectable={false} />
      <svg className="frame" width={w} height={h}>
        <rect
          x={tok.width / 2}
          y={tok.width / 2}
          width={Math.max(0, w - tok.width)}
          height={Math.max(0, h - tok.width)}
          rx={tok.radius}
          fill={c.kind === 'subnet-public' || c.kind === 'subnet-private' ? `${tok.color}0d` : 'none'}
          stroke={stroke}
          strokeWidth={tok.width}
          strokeDasharray={tok.dash || undefined}
        />
      </svg>
      <div className={`cn-label${c.kind === 'subnet-public' ? ' bottom' : ''}`} style={{ color: tok.color }}>
        {c.kind === 'vpc' && <Cloud color={tok.color} />}
        {(c.kind === 'subnet-public' || c.kind === 'subnet-private') && <Lock color={tok.color} />}
        <span>{c.label}</span>
        {c.sublabel && <span className="sublabel">{c.sublabel}</span>}
      </div>
      {c.kind === 'region' && (
        <span className="cn-corner">
          <Flag color={tok.color} />
        </span>
      )}
      <Handle type="source" position={Position.Bottom} className={hidden} isConnectable={false} />
    </div>
  );
});

export const nodeTypes = { resource: ResourceNode, container: ContainerNode };
