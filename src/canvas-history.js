const RUNTIME_FIELDS = new Set(['status', 'progress', 'stage', 'runs', 'error', 'promptId', 'output', 'resultUrl']);

function cleanNodes(nodes, editing) {
  return (nodes || []).map((node) => {
    const { measured, selected, dragging, ...stableNode } = node;
    const data = editing
      ? Object.fromEntries(Object.entries(node.data || {}).filter(([key]) => !RUNTIME_FIELDS.has(key)))
      : node.data;
    return { ...stableNode, data };
  });
}

function snapshot(nodes, edges) {
  return { nodes: cleanNodes(nodes, false), edges: structuredClone(edges || []) };
}

function editingSignature(nodes, edges) {
  return JSON.stringify({ nodes: cleanNodes(nodes, true), edges: edges || [] });
}

export function restoreHistoryNodes(targetNodes, currentNodes) {
  const current = new Map((currentNodes || []).map((node) => [node.id, node]));
  return (targetNodes || []).map((node) => {
    const existing = current.get(node.id);
    if (!existing) return node;
    const runtime = Object.fromEntries(Object.entries(existing.data || {}).filter(([key]) => RUNTIME_FIELDS.has(key)));
    return { ...node, data: { ...node.data, ...runtime } };
  });
}

export class CanvasHistory {
  constructor(nodes, edges, { limit = 50, onChange = () => {} } = {}) {
    this.limit = limit;
    this.onChange = onChange;
    this.current = snapshot(nodes, edges);
    this.signature = editingSignature(nodes, edges);
    this.past = [];
    this.future = [];
    this.coalescing = false;
  }

  observe(nodes, edges, { coalesce = false } = {}) {
    const next = snapshot(nodes, edges);
    const nextSignature = editingSignature(nodes, edges);
    const previous = { snapshot: this.current, signature: this.signature };
    this.current = next;
    if (nextSignature === this.signature) {
      if (!coalesce) this.coalescing = false;
      return;
    }
    if (!this.coalescing) this._push(previous);
    this.coalescing = coalesce;
    this.signature = nextSignature;
    if (this.future.length) {
      this.future = [];
      this._notify();
    }
  }

  undo() {
    if (!this.past.length) return null;
    const target = this.past.pop();
    this.future.push({ snapshot: this.current, signature: this.signature });
    this._restore(target);
    return target.snapshot;
  }

  redo() {
    if (!this.future.length) return null;
    const target = this.future.pop();
    this.past.push({ snapshot: this.current, signature: this.signature });
    this._restore(target);
    return target.snapshot;
  }

  _push(entry) {
    this.past.push(entry);
    if (this.past.length > this.limit) this.past.splice(0, this.past.length - this.limit);
    this._notify();
  }

  _restore(target) {
    this.current = target.snapshot;
    this.signature = target.signature;
    this.coalescing = false;
    this._notify();
  }

  _notify() {
    this.onChange({ canUndo: this.past.length > 0, canRedo: this.future.length > 0 });
  }
}
