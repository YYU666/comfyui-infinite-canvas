import { allocateReferenceTag } from './reference-tags.js';

export const PUREREF_FILE_LIMIT = 64 * 1024 * 1024;
const fail = (message) => { throw new Error(message); };
const aborted = () => new DOMException('PureRef 导入已取消。', 'AbortError');

export async function inspectPureRef(file, signal) {
  const response = await fetch('/api/pureref/inspect', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file, signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || 'PureRef 解析失败。');
  if (!Array.isArray(result.images) || result.images.length < 1 || result.images.length > 128) fail('PureRef 返回的图片数量无效。');
  return result;
}

export function pureRefImageFile(image) {
  if (!/^PureRef-\d{3}\.(png|jpg|webp)$/.test(image.name) || !['image/png', 'image/jpeg', 'image/webp'].includes(image.mime)
    || !Number.isInteger(image.bytes) || image.bytes < 1 || image.bytes > 16 * 1024 * 1024
    || typeof image.base64 !== 'string' || image.base64.length > Math.ceil(image.bytes / 3) * 4) fail('PureRef 图片描述无效。');
  const binary = atob(image.base64);
  if (binary.length !== image.bytes) fail('PureRef 图片字节数无效。');
  return new File([Uint8Array.from(binary, value => value.charCodeAt(0))], image.name, { type: image.mime });
}

/** Ordinary image nodes, deliberately a grid rather than PureRef layout recovery. */
export function pureRefImageNodes(images, { existing, origin, uid, assetUrl }) {
  const right = existing.reduce((x, node) => Math.max(x, node.position.x + (node.measured?.width || 440) + 80), origin.x);
  const columns = Math.min(6, Math.ceil(Math.sqrt(images.length)));
  const used = new Set(existing.map(node => node.data?.refTag).filter(Boolean));
  return images.map((image, index) => ({
    id: uid('pur-image'), type: 'media', position: { x: right + (index % columns) * 360, y: origin.y + Math.floor(index / columns) * 310 },
    data: { kind: 'image', title: image.name.replace(/\.[^.]+$/, ''), name: image.name, assetPath: image.assetPath, mediaStorageId: image.mediaStorageId,
      url: assetUrl(image.assetPath), metadata: { width: image.width, height: image.height }, localFile: true, output: false,
      refTag: allocateReferenceTag(used, 'image'), importedFrom: { format: 'PureRef', envelope: '2.1', schema: 200101 } },
  }));
}

/** Uploads may leave unreferenced immutable assets; canvas publication is one batch. */
export function createPureRefImporter({ getContext, inspect = inspectPureRef, upload, beginBatch, publish, persist, onState = () => {} }) {
  let operation = null, state = { phase: 'idle' };
  const emit = next => { state = next; onState(next); };
  const check = op => {
    if (op.controller.signal.aborted || operation !== op) throw aborted();
    const now = getContext();
    if (now.projectId !== op.context.projectId || now.owner !== op.context.owner || now.readOnly || now.switching || now.conflict || !now.owner) fail('当前项目已切换或不可写，未继续导入。');
  };
  return {
    getState: () => state,
    async inspect(file) {
      if (operation) fail('另一个 PureRef 导入尚未结束。');
      if (!/\.pur$/i.test(file.name || '') || !file.size || file.size > PUREREF_FILE_LIMIT) fail('请选择不超过 64 MiB 的 .pur 文件。');
      const op = { controller: new AbortController(), context: getContext(), result: null };
      operation = op;
      try {
        check(op); emit({ phase: 'inspecting' });
        op.result = await inspect(file, op.controller.signal); check(op);
        emit({ phase: 'preview', result: op.result });
      } catch (error) {
        operation = null; emit({ phase: error.name === 'AbortError' ? 'cancelled' : 'error', message: error.message });
      }
    },
    async commit() {
      const op = operation;
      if (!op?.result || state.phase !== 'preview') fail('请先解析并预览 PureRef 文件。');
      let release, published = false;
      try {
        check(op); release = beginBatch();
        const images = [];
        for (const image of op.result.images) {
          check(op); emit({ phase: 'uploading', completed: images.length, total: op.result.images.length });
          const saved = await upload(pureRefImageFile(image)); check(op);
          if (!saved?.ok || !saved.assetPath) fail(saved?.error?.message || 'PureRef 图片上传失败，未添加画布节点。');
          images.push({ name: image.name, mime: image.mime, width: image.width, height: image.height, assetPath: saved.assetPath, mediaStorageId: saved.mediaStorageId });
        }
        check(op);
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
        release?.(); operation = null;
      }
    },
    cancel() {
      if (!operation || state.phase === 'saving') return;
      operation.controller.abort();
      if (state.phase === 'preview') { operation = null; emit({ phase: 'cancelled', message: 'PureRef 导入已取消。' }); }
      else emit({ phase: 'cancelling' });
    },
  };
}
