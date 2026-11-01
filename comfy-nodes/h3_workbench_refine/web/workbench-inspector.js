import { app } from '/scripts/app.js';

const CHANNEL = 'h3-workflow-inspector';
const VERSION = 1;
const nonce = new URLSearchParams(location.hash.slice(1)).get('h3-inspector');
const allowedOrigin = (origin) => /^http:\/\/(127\.0\.0\.1|localhost):879[0-9]$/.test(origin);

// Ordinary ComfyUI pages are unaffected. This bridge exists only in a dedicated
// inspector iframe and exposes native import, never execution or H3 mutation.
if (window.parent !== window && /^[A-Za-z0-9_-]{16,128}$/.test(nonce || '')) {
  app.registerExtension({
    name: 'Refmuse.WorkflowInspector',
    setup() {
      let parentOrigin = null;
      let pending = null;
      let loading = false;
      const started = Date.now();
      const send = (data) => parentOrigin && window.parent.postMessage({ channel: CHANNEL, version: VERSION, nonce, ...data }, parentOrigin);
      // setup precedes workflow/tab restoration in the installed frontend.
      // Never await readiness inside setup: app.setup itself awaits extensions.
      const ready = () => app.isGraphReady && app.canvas && app.extensionManager?.spinner === false;
      const process = async () => {
        if (loading || !pending || !ready()) return;
        const message = pending; pending = null; loading = true;
        try {
          const graph = message.graph;
          if (!graph || typeof graph !== 'object' || Array.isArray(graph) || !Object.keys(graph).length || Object.keys(graph).length > 2048 || JSON.stringify(graph).length > 8 * 1024 * 1024) throw new Error('工作流格式无效或超过查看上限。');
          if (Object.values(graph).some((node) => !node || typeof node.class_type !== 'string' || !node.inputs || typeof node.inputs !== 'object')) throw new Error('工作流节点格式无效。');
          if (typeof app.loadApiJson !== 'function') throw new Error('当前 ComfyUI 前端不支持 API 图导入。');
          const name = `${String(message.name || '工作流查看').slice(0, 140)} · inspect-${nonce}-${String(message.requestId).slice(0, 36)}`;
          await app.loadApiJson(graph, name);
          const imported = app.rootGraph || app.graph;
          const nodes = imported?._nodes || [];
          if (nodes.length !== Object.keys(graph).length) throw new Error('导入节点数量不匹配，请检查 ComfyUI 节点是否已注册。');
          // Mirror native loadApiJson's ID mapping (including flattened
          // subgraph IDs). Do not depend on graph order or translated titles.
          const ids = Object.keys(graph);
          const taken = new Set(ids.filter((id) => !id.includes(':')));
          const nativeIds = new Map();
          for (const id of ids) {
            if (!id.includes(':')) { nativeIds.set(id, String(isNaN(+id) ? id : +id)); continue; }
            let candidate = id.replaceAll(':', '_');
            while (taken.has(candidate)) candidate += '_';
            taken.add(candidate); nativeIds.set(id, candidate);
          }
          for (const [id, definition] of Object.entries(graph)) {
            const node = nodes.find((item) => String(item.id) === nativeIds.get(id));
            // has_errors also flags missing media/models and past execution
            // errors. A real registered Comfy constructor has these static
            // definitions; native missing-node placeholders are LGraphNode
            // instances without them. Keep resource warnings visible.
            if (!node || node.type !== definition.class_type || node.constructor?.comfyClass !== definition.class_type
              || node.constructor?.nodeData?.name !== definition.class_type) throw new Error(`节点 ${id} 未正确加载，可能缺少 ${definition.class_type}。`);
            for (const [name, value] of Object.entries(definition.inputs)) {
              if (!Array.isArray(value) || value.length !== 2 || !graph[value[0]] || !Number.isInteger(value[1])) continue;
              const slot = node.inputs?.findIndex((input) => input.name === name) ?? -1;
              const link = slot >= 0 ? node.getInputLink?.(slot) : null;
              if (!link || String(link.origin_id) !== nativeIds.get(String(value[0])) || link.origin_slot !== value[1]) throw new Error(`节点 ${id} 的 ${name} 连线未正确还原。`);
            }
          }
          const links = imported.links;
          const linkCount = typeof links?.values === 'function' ? [...links.values()].length : Object.keys(links || {}).length;
          const expectedLinks = Object.values(graph).reduce((count, node) => count + Object.values(node.inputs).filter((value) => Array.isArray(value) && value.length === 2 && graph[value[0]] && Number.isInteger(value[1])).length, 0);
          if (linkCount !== expectedLinks) throw new Error('导入连线数量不匹配，未确认打开完整工作流。');
          app.canvas.selectItems?.([]);
          if (app.extensionManager.command?.execute) await app.extensionManager.command.execute('Comfy.Canvas.FitView');
          else app.canvas.fitViewToSelectionAnimated?.();
          send({ type: 'loaded', requestId: message.requestId, name, nodeCount: nodes.length, linkCount, warningCount: nodes.filter((node) => node.has_errors).length });
        } catch (error) { send({ type: 'error', requestId: message.requestId, error: String(error.message || error).slice(0, 1000) }); }
        finally { loading = false; void process(); }
      };
      window.addEventListener('message', (event) => {
        const message = event.data;
        if (event.source !== window.parent || !allowedOrigin(event.origin) || (parentOrigin && parentOrigin !== event.origin)
          || message?.channel !== CHANNEL || message.version !== VERSION || message.nonce !== nonce) return;
        parentOrigin = event.origin;
        if (message.type === 'hello') {
          if (ready()) send({ type: 'ready' });
          else if (Date.now() - started > 30000) send({ type: 'error', error: 'ComfyUI 初始化未完成，未载入工作流。' });
        } else if (message.type === 'load' && typeof message.requestId === 'string' && ready()) { pending = message; void process(); }
      });
      window.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); send({ type: 'close' }); }
      }, true);
    },
  });
}
