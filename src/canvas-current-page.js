// Transport only: tools still execute in the mounted user page and use its save queue.
export function validateCanvasArgs(value, schema, path = 'args') {
  const type = schema.type;
  const valid = type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
    : type === 'integer' ? Number.isInteger(value)
      : type === 'number' ? Number.isFinite(value) : typeof value === type;
  if (type && !valid) throw new Error(`${path}: expected ${type}`);
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`${path}: unsupported value`);
  if (schema.minimum !== undefined && value < schema.minimum) throw new Error(`${path}: below minimum`);
  if (schema.maximum !== undefined && value > schema.maximum) throw new Error(`${path}: above maximum`);
  if (type === 'object') {
    for (const key of schema.required || []) if (!(key in value)) throw new Error(`${path}.${key}: required`);
    for (const [key, item] of Object.entries(value)) {
      if (schema.properties?.[key]) validateCanvasArgs(item, schema.properties[key], `${path}.${key}`);
      else if (schema.additionalProperties === false) throw new Error(`${path}.${key}: unsupported argument`);
    }
  }
}

export function startCurrentCanvasPage({ tools, getPage, fetchImpl = fetch, intervalMs = 1500 }) {
  const sessionId = globalThis.crypto?.randomUUID?.() || `page-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const toolMap = new Map(tools.map((tool) => [tool.name, tool]));
  const initial = getPage();
  if (initial.readOnly || !initial.projectId) return () => {};
  const abort = new AbortController();
  let stopped = false;
  let polling = false;
  let executing = false;
  let delivery = null;
  const seen = new Set();
  const request = async (action, payload, options = {}) => {
    const response = await fetchImpl(`/api/agent/canvas/${action}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      ...options,
    });
    if (!response.ok) {
      const error = new Error(`Current canvas channel: ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return response.json();
  };
  const deliver = async () => {
    if (!delivery || stopped) return;
    const sent = delivery;
    await request('result', sent, { signal: abort.signal });
    if (delivery === sent) delivery = null;
  };
  const execute = async (command, epoch) => {
    executing = true;
    let result;
    try {
      const page = getPage();
      if (page.readOnly || !page.visible || page.projectId !== command.projectId
        || command.sessionId !== sessionId || command.epoch !== epoch) throw new Error('当前可见页面已改变，命令未执行。');
      const tool = toolMap.get(command.tool);
      if (!tool) throw new Error('Unsupported current-page tool.');
      validateCanvasArgs(command.args, tool.inputSchema);
      if (command.tool === 'canvas_generate_node' && command.args.wait) throw new Error('Use wait:false and read canvas_get_state.');
      result = JSON.parse(await tool.execute(command.args));
    } catch (error) {
      result = { ok: false, error: error.message || String(error) };
    }
    delivery = { epoch, sessionId, projectId: command.projectId, opId: command.opId, result };
    executing = false;
    try { await deliver(); } catch { /* Retry delivery, never execution, on the next heartbeat. */ }
  };
  const poll = async () => {
    if (stopped || polling) return;
    polling = true;
    try {
      const page = getPage();
      const reply = await request('heartbeat', { sessionId, projectId: initial.projectId,
        visible: !page.readOnly && page.visible && page.projectId === initial.projectId,
        busy: executing || Boolean(delivery),
      }, { signal: abort.signal });
      if (stopped) return;
      if (delivery && delivery.epoch !== reply.epoch) delivery = null; // New backend cannot accept old receipts.
      if (delivery) await deliver();
      if (reply.command && !executing && !seen.has(reply.command.opId)) {
        seen.add(reply.command.opId);
        void execute(reply.command, reply.epoch);
      }
    } catch (error) {
      // Old backend: keep the canvas usable without opening any substitute page.
      if (error.status === 404) { stopped = true; clearInterval(timer); }
    } finally { polling = false; }
  };
  const timer = setInterval(poll, intervalMs);
  void poll();
  return () => {
    stopped = true;
    clearInterval(timer);
    abort.abort();
    void request('release', { sessionId }, { keepalive: true }).catch(() => {});
  };
}
