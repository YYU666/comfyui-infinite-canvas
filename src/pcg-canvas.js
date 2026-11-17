import React, { useEffect, useRef, useState } from 'react';
import PcgViewportPanel from './PcgViewportPanel.jsx';
import { createPcgViewportController } from './pcg-viewport-controller.js';
import { createPcgRuntime } from './pcg-runtime.js';
import { isPcgNode } from './pcg-registry.js';

export function usePcgCanvas({ project, revisionRef, switchingRef, nodes, nodesRef, edges, edgesRef, persistProject }) {
  const latest = useRef(null), restored = useRef(new Set());
  const [, refresh] = useState(0);
  latest.current = { project, persistProject };
  const viewport = useRef(null);
  const runtime = useRef(null);
  if (!runtime.current) runtime.current = createPcgRuntime({
    getContext: () => ({ projectId: latest.current.project.id, revision: revisionRef.current, readOnly: latest.current.project.readOnly, switching: switchingRef.current }),
    getNode: id => nodesRef.current.find(node => node.id === id),
    persistProject: () => latest.current.persistProject(),
    onChange: () => { viewport.current?.sync(); refresh(value => value + 1); },
  });
  if (!viewport.current) viewport.current = createPcgViewportController({
    getContext: () => ({ projectId: latest.current.project.id, revision: revisionRef.current, readOnly: latest.current.project.readOnly, switching: switchingRef.current }),
    getNode: id => nodesRef.current.find(node => node.id === id),
    getGraph: () => ({ nodes: nodesRef.current, edges: edgesRef.current }),
    runtime: runtime.current, persistProject: () => latest.current.persistProject(),
    onChange: () => refresh(value => value + 1),
  });
  useEffect(() => { viewport.current.observeGraph(); }, [nodes, edges]);
  useEffect(() => { void viewport.current.restore(); return () => viewport.current.dispose(); }, []);
  const panelState = viewport.current.snapshot();
  const pcgPreviewPanel = React.createElement(React.Fragment, null,
    !panelState.open && React.createElement('button', { className: 'pcg-preview-open nodrag nopan nowheel', type: 'button', onClick: () => viewport.current.open(), 'aria-label': '打开 PCG 3D 预览' }, 'PCG · 3D 预览'),
    React.createElement(PcgViewportPanel, { state: panelState, onLayout: layout => viewport.current.layout(layout), onClose: () => viewport.current.close(), onRendered: report => viewport.current.rendered(report) }));
  useEffect(() => {
    if (project.readOnly) return;
    for (const node of nodes.filter(isPcgNode)) {
      const key = `${project.id}:${node.id}`;
      if (restored.current.has(key)) continue;
      restored.current.add(key);
      void runtime.current.listTasks({ projectId: project.id, nodeId: node.id }).catch(() => { restored.current.delete(key); });
    }
  }, [project.id, project.readOnly, nodes]);
  return { pcgPreviewPanel, pcgViewport: viewport.current, pcg: runtime.current, getPcgState: id => runtime.current.getState(id), getPcgContext: () => ({ projectId: project.id, revision: revisionRef.current, readOnly: project.readOnly, switching: switchingRef.current }) };
}
