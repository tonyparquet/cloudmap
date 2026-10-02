import type { GraphEdge } from '@carto/core';
import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, type Edge, type EdgeProps } from '@xyflow/react';
import { memo, type CSSProperties } from 'react';
import type { Theme } from '../theme.ts';
import type { DiffMark } from './nodes.tsx';

export type FlowEdgeData = { edge: GraphEdge; theme: Theme; dim: boolean; diff: DiffMark };
export type FlowEdgeType = Edge<FlowEdgeData, 'flow'>;

/** Style d'une arête selon son type et son état (section 9.2). */
export function edgeStyle(
  e: GraphEdge,
  theme: Theme,
  diff?: DiffMark,
): { color: string; style: CSSProperties } {
  const base = theme.edge[e.kind];
  let color = base.color;
  let dash = base.dash;
  let width = base.width ?? 1.5;
  let opacity = 1;
  if (e.state === 'bloque') {
    color = theme.edge.blocked.color;
    dash = theme.edge.blocked.dash ?? '5 4';
  } else if (e.state === 'non-explique') color = theme.edge.unexplained.color;
  else if (e.state === 'inutilise') opacity = 0.35;
  else if (e.state === 'observe') {
    dash = undefined;
    width = Math.min(6, width + Math.log10(Math.max(1, e.bytes ?? 1)) / 2);
  }
  if (diff === 'added') color = theme.status.actif;
  if (diff === 'removed') color = theme.status.erreur;
  if (diff === 'modified') color = theme.edge.unexplained.color;
  return { color, style: { stroke: color, strokeWidth: width, strokeDasharray: dash, opacity } };
}

export const FlowEdge = memo(function FlowEdge(props: EdgeProps<FlowEdgeType>) {
  const { data } = props;
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    targetX: props.targetX,
    targetY: props.targetY,
    sourcePosition: props.sourcePosition,
    targetPosition: props.targetPosition,
    borderRadius: 6,
    offset: 16,
  });
  if (!data) return null;
  const { style } = edgeStyle(data.edge, data.theme, data.diff);
  const animated = data.edge.kind === 'cicd' && data.theme.edge.cicd.animated !== false;
  const label = data.theme.edge.label;
  return (
    <>
      <BaseEdge
        id={props.id}
        path={path}
        markerEnd={props.markerEnd}
        interactionWidth={14}
        className={animated ? 'edge-cicd' : undefined}
        style={{ ...style, opacity: Number(style.opacity ?? 1) * (data.dim ? 0.15 : 1) }}
      />
      {data.edge.label && !data.dim && (
        <EdgeLabelRenderer>
          <div
            className="elabel nodrag nopan"
            data-testid="etiquette-arete"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              color: label.color,
              background: label.background,
              fontSize: label.size,
              fontWeight: label.weight,
            }}
          >
            {data.edge.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
});

export const edgeTypes = { flow: FlowEdge };
