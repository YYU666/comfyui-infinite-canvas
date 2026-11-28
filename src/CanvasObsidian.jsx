import React, { useId } from 'react';
import { BaseEdge, useStore } from '@xyflow/react';
import { canvasEdgeLook, canvasNodeModality, canvasNodeStatus, connectedGraphStamp } from './canvas-obsidian.js';

export function ObsidianStatus({ type, data }) {
  const status = canvasNodeStatus(type, data);
  return status.label && <span className="obsidian-status-text"><i />{status.label}</span>;
}

export function frameCanvasNodes(nodeTypes) {
  return Object.fromEntries(Object.entries(nodeTypes).map(([type, Node]) => {
    if (type === 'group') return [type, Node];
    const FramedNode = React.memo(function ObsidianNode(props) {
      const { data, selected } = props;
      const graphStamp = useStore((state) => connectedGraphStamp(props.id, state.edges, state.nodeLookup));
      const status = canvasNodeStatus(type, data);
      const hasOwnStatus = type === 'native3d'
        || (/^video/.test(type) && type !== 'video')
        || (type === 'media' && data.kind !== 'model')
        || (type === 'generator' && !['customWorkflow', 'mossPose', 'videoSuperResolution'].includes(data.mode))
        || type === 'spriteAtlas';
      return <div className="obsidian-node" data-modality={canvasNodeModality(type, data)} data-canvas-mode={data.mode}
        data-selected={selected || undefined} data-task-tone={status.tone}>
        <Node {...props} graphStamp={graphStamp} />
        {!hasOwnStatus && status.label && <div className="obsidian-node-status"><ObsidianStatus type={type} data={data} /></div>}
      </div>;
    });
    return [type, FramedNode];
  }));
}

function sameEdgeLook(a, b) {
  return a.from === b.from && a.to === b.to && a.linked === b.linked && a.activeEndpoint === b.activeEndpoint;
}

export function ObsidianEdge({ edge, path }) {
  const id = useId();
  const { sourceX, sourceY, targetX, targetY } = edge;
  const look = useStore((state) => canvasEdgeLook(
    state.nodeLookup.get(edge.source), edge.sourceHandleId,
    state.nodeLookup.get(edge.target), edge.targetHandleId,
  ), sameEdgeLook);
  const coincident = sourceX === targetX && sourceY === targetY;
  const paint = `url(#${id})`;
  return <g className="obsidian-edge" data-linked={look.linked || undefined}>
    <defs>
      <linearGradient id={id} gradientUnits="userSpaceOnUse" x1={sourceX} y1={sourceY} x2={targetX + (coincident ? 1 : 0)} y2={targetY}>
        <stop offset="0" stopColor={look.from} />
        <stop offset="1" stopColor={look.to} />
      </linearGradient>
    </defs>
    <BaseEdge id={edge.id} path={path} style={{ ...edge.style, '--obsidian-edge-paint': paint }}
      markerStart={edge.markerStart} markerEnd={edge.markerEnd} interactionWidth={26} />
    {look.activeEndpoint && !edge.data?.nonExecuting && <path className="obsidian-edge-active-endpoint" d={path} stroke={paint} fill="none" pointerEvents="none" aria-hidden="true" />}
  </g>;
}
