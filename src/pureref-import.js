export const PUREREF_FILE_LIMIT = 8 * 1024 ** 3;
const fail = message => { throw new Error(message); };
const aborted = () => new DOMException('PureRef 导入已取消。', 'AbortError');
const sessionPath = session => `/api/pureref/sessions/${session.id}`;
const headers = session => ({ 'X-PureRef-Session': session.capability });
async function request(url, options = {}) {
  const response = await fetch(url, options);
  let value;
  try { value = await response.json(); } catch { throw new TypeError('PureRef 响应中断，正在核对本地提交状态。'); }
  if (!response.ok) { const error = new Error(value.message || 'PureRef 本地请求失败。'); error.status = response.status; throw error; }
  return value;
}
export async function disposePureRef(session) {
  if (session) await fetch(sessionPath(session), { method: 'DELETE', headers: headers(session), keepalive: true, signal: AbortSignal.timeout(15000) }).catch(() => {});
}
const pause = (signal, delay = 400) => new Promise((resolve, reject) => {
  const done = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); resolve(); };
  const cancel = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); reject(aborted()); };
  const timer = setTimeout(done, delay);
  if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel, { once: true });
});
const transportFailure = error => error instanceof TypeError || error?.name === 'TimeoutError';
async function reliableRequest(url, options, signal) {
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw aborted();
    try { return await request(url, { ...options, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000) }); }
    catch (error) {
      if (signal?.aborted || !transportFailure(error) || attempt >= 2) throw error;
      await pause(signal || new AbortController().signal, 150 * (attempt + 1));
    }
  }
}
export async function inspectPureRef(file, signal, projectId, onProgress = () => {}) {
  let session;
  try {
    session = await request('/api/pureref/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId, size: file.size }), signal });
    let offset = 0;
    while (offset < file.size) {
      const end = Math.min(offset + session.chunkBytes, file.size);
      for (let attempt = 0; ; attempt++) {
        try {
          const status = await request(`${sessionPath(session)}/upload`, { method: 'PUT', headers: { ...headers(session), 'Content-Type': 'application/octet-stream', 'X-Upload-Offset': String(offset) }, body: file.slice(offset, end), signal: AbortSignal.any([signal, AbortSignal.timeout(90000)]) });
          if (status.bytes !== end) fail('PureRef 上传进度无效。');
          offset = end; break;
        } catch (error) {
          if (signal.aborted || !transportFailure(error)) throw error;
          const status = await reliableRequest(`${sessionPath(session)}/status`, { headers: headers(session) }, signal);
          if (status.phase === 'uploading' && status.bytes === end) { offset = end; break; }
          if (status.phase !== 'uploading' || status.bytes !== offset || attempt >= 2) throw error;
          await pause(signal, 150 * (attempt + 1)); // Only a confirmed uncommitted range is retried.
        }
      }
      onProgress({ phase: 'uploading', bytes: offset, total: file.size });
    }
    await reliableRequest(`${sessionPath(session)}/finish`, { method: 'POST', headers: { ...headers(session), 'Content-Type': 'application/json' }, body: '{}' }, signal);
    let status;
    do {
      await pause(signal);
      status = await reliableRequest(`${sessionPath(session)}/status`, { headers: headers(session) }, signal);
      onProgress(status);
      if (status.phase === 'error') fail(status.message || 'PureRef 解析失败。');
    } while (status.phase !== 'ready');
    if (!Number.isInteger(status.count) || status.count < 1 || status.count > 2048) fail('PureRef 图片数量无效。');
    const images = [];
    while (images.length < status.count) {
      const page = await reliableRequest(`${sessionPath(session)}/resources?offset=${images.length}&limit=64`, { headers: headers(session) }, signal);
      if (!Array.isArray(page.images) || !page.images.length || page.images.length > 64) fail('PureRef 图片分页无效。');
      images.push(...page.images);
    }
    return { ...status, images, session };
  } catch (error) { await disposePureRef(session); throw error; }
}
export async function copyPureRefResource(session, image, projectId, revision, signal) {
  if (signal.aborted) throw aborted();
  // Once sent, finish this single write (or recover its receipt with the exact
  // same If-Match) so the page learns its revision even when Cancel is pressed.
  // The coordinator checks cancellation immediately afterwards, before another
  // resource or any canvas publication. Never refresh an unknown revision.
  return reliableRequest(`${sessionPath(session)}/resources/${image.handle}/copy`, { method: 'POST', headers: { ...headers(session), 'Content-Type': 'application/json', 'If-Match': String(revision) }, body: JSON.stringify({ projectId }) });
}
export async function pureRefPreview(session, image, signal) {
  const response = await fetch(`${sessionPath(session)}/resources/${image.handle}/preview`, { headers: headers(session), signal });
  if (!response.ok) fail('PureRef 预览读取失败。');
  const blob = await response.blob();
  if (blob.size > 128 * 1024) fail('PureRef 预览过大。');
  return URL.createObjectURL(blob);
}

/** Ordinary image nodes, deliberately a grid rather than PureRef layout recovery. */
export function pureRefImageNodes(images, { existing, origin, uid, assetUrl }) {
  const right = existing.reduce((x, node) => Math.max(x, node.position.x + (node.measured?.width || 440) + 80), origin.x);
  const columns = Math.min(6, Math.ceil(Math.sqrt(images.length)));
  const used = new Set(existing.map(node => node.data?.refTag).filter(Boolean));
  let nextTag = 1;
  const tag = () => { while (used.has(`<Picture ${nextTag}>`)) nextTag++; const value = `<Picture ${nextTag++}>`; used.add(value); return value; };
  return images.map((image, index) => ({
    id: uid('pur-image'), type: 'media', position: { x: right + (index % columns) * 360, y: origin.y + Math.floor(index / columns) * 310 },
    data: { kind: 'image', title: image.name.replace(/\.[^.]+$/, ''), name: image.name, assetPath: image.assetPath, mediaStorageId: image.mediaStorageId,
      url: assetUrl(image.assetPath), metadata: { width: image.width, height: image.height }, localFile: true, output: false,
      refTag: tag(), importedFrom: { format: 'PureRef', envelope: '2.1', schema: 200101 } },
  }));
}

/** Uploads may leave unreferenced immutable assets; canvas publication is one batch. */
export function createPureRefImporter({ getContext, inspect = inspectPureRef, upload, beginBatch, publish, persist, onState = () => {} }) {
  let operation = null, state = { phase: 'idle' };
  const emit = next => { state = next; onState(next); };
  const capacity = count => { if ((getContext().nodeCount || 0) + count > 4096) fail('导入后画布节点不能超过 4096 个，请先拆分画板。'); };
  const check = op => {
    if (op.controller.signal.aborted || operation !== op) throw aborted();
    const now = getContext();
    if (now.projectId !== op.context.projectId || now.owner !== op.context.owner || now.readOnly || now.switching || now.conflict || !now.owner) fail('当前项目已切换或不可写，未继续导入。');
  };
  return {
    getState: () => state,
    async inspect(file) {
      if (operation) fail('另一个 PureRef 导入尚未结束。');
      if (!/\.pur$/i.test(file.name || '') || !file.size || file.size > PUREREF_FILE_LIMIT) fail('请选择不超过 8 GiB 的 .pur 文件。');
      const op = { controller: new AbortController(), context: getContext(), result: null };
      operation = op;
      try {
        check(op); emit({ phase: 'inspecting' });
        op.result = await inspect(file, op.controller.signal, op.context.projectId, progress => { check(op); emit({ phase: 'inspecting', progress }); }); check(op);
        capacity(op.result.images.length);
        emit({ phase: 'preview', result: op.result });
      } catch (error) {
        if (op.result?.session) await disposePureRef(op.result.session);
        operation = null; emit({ phase: error.name === 'AbortError' ? 'cancelled' : 'error', message: error.message });
      }
    },
    async commit() {
      const op = operation;
      if (!op?.result || state.phase !== 'preview') fail('请先解析并预览 PureRef 文件。');
      let release, published = false;
      try {
        check(op); capacity(op.result.images.length); release = beginBatch();
        const images = [];
        for (const image of op.result.images) {
          check(op); emit({ phase: 'uploading', completed: images.length, total: op.result.images.length });
          const saved = await upload(image, op.result.session, op.controller.signal); check(op);
          if (!saved?.ok || !saved.assetPath) fail(saved?.error?.message || 'PureRef 图片上传失败，未添加画布节点。');
          images.push({ name: image.name, mime: image.mime, width: image.width, height: image.height, assetPath: saved.assetPath, mediaStorageId: saved.mediaStorageId });
        }
        check(op); capacity(images.length);
        // Release the media barrier immediately before synchronous publication.
        release(); release = null;
        const ids = publish(images); published = true;
        emit({ phase: 'saving', total: images.length });
        check(op); await persist(); check(op);
        emit({ phase: 'done', total: images.length, ids, duplicates: op.result.duplicates, skippedExternal: op.result.skippedExternal });
      } catch (error) {
        emit({ phase: published ? 'unconfirmed' : error.name === 'AbortError' ? 'cancelled' : 'error', message: published
          ? '全部图片节点已加入，但画布保存尚未确认。请保留本页，通过项目菜单重试保存；不要重复导入。' : error.message });
      } finally {
        release?.(); await disposePureRef(op.result.session); operation = null;
      }
    },
    cancel() {
      if (!operation || state.phase === 'saving') return;
      operation.controller.abort();
      if (state.phase === 'preview') { disposePureRef(operation.result?.session); operation = null; emit({ phase: 'cancelled', message: 'PureRef 导入已取消。' }); }
      else emit({ phase: 'cancelling' });
    },
  };
}
