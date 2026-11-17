import { useEffect, useRef, useState } from 'react';
import { createPcgRuntime } from './pcg-runtime.js';
import { isPcgNode } from './pcg-registry.js';

export function usePcgCanvas({ project, revisionRef, switchingRef, nodes, nodesRef, persistProject }) {
  const latest = useRef(null), restored = useRef(new Set());
  const [, refresh] = useState(0);
  latest.current = { project, persistProject };
  const runtime = useRef(null);
  if (!runtime.current) runtime.current = createPcgRuntime({
    getContext: () => ({ projectId: latest.current.project.id, revision: revisionRef.current, readOnly: latest.current.project.readOnly, switching: switchingRef.current }),
    getNode: id => nodesRef.current.find(node => node.id === id),
    persistProject: () => latest.current.persistProject(),
    onChange: () => refresh(value => value + 1),
  });
  useEffect(() => {
    if (project.readOnly) return;
    for (const node of nodes.filter(isPcgNode)) {
      const key = `${project.id}:${node.id}`;
      if (restored.current.has(key)) continue;
      restored.current.add(key);
      void runtime.current.listTasks({ projectId: project.id, nodeId: node.id }).catch(() => { restored.current.delete(key); });
    }
  }, [project.id, project.readOnly, nodes]);
  return { pcg: runtime.current, getPcgState: id => runtime.current.getState(id), getPcgContext: () => ({ projectId: project.id, revision: revisionRef.current, readOnly: project.readOnly, switching: switchingRef.current }) };
}
