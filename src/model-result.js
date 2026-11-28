import { checkGLBLayout } from './native3d-glb-layout.js';
import { isWhiteMeshStep } from './white-mesh-step.js';

export const PROJECT_GLB = /^assets\/[a-f0-9]{64}\.glb$/i;
const MAX_GLB_BYTES = 512 * 1024 ** 2;

export function persistedModelFields(assetPath, bytes) {
  if (!PROJECT_GLB.test(assetPath || '')) throw new Error('模型尚未写入项目素材。');
  const fields = { assetPath, localFile: true };
  if (Number.isFinite(bytes) && bytes >= 0) fields.bytes = bytes;
  return fields;
}

export async function readGeneratedModelFile(url, filename, fetchImpl = fetch) {
  const response = await fetchImpl(url, { redirect: 'error' });
  if (!response?.ok) throw new Error('无法读取生成的 GLB。');
  const blob = await response.blob();
  if (blob.size > MAX_GLB_BYTES) throw new Error('生成的 GLB 超过 512 MiB。');
  if (await blob.slice(0, 4).text() !== 'glTF') throw new Error('生成结果不是受支持的 GLB。');
  const file = new File([blob], filename || 'model.glb', { type: 'model/gltf-binary' });
  await checkGLBLayout(file);
  return file;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KiB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}

export function modelResultSummary(data = {}) {
  const name = data.name || data.filename || 'model.glb';
  const triangles = [data.metadata?.triangles, data.metadata?.faces, data.quality?.triangles, data.metadata?.geometryTriangles]
    .find((value) => Number.isInteger(value) && value > 0);
  const vertices = [data.metadata?.vertices, data.quality?.vertices].find((value) => Number.isInteger(value) && value > 0);
  const bytes = Number.isFinite(data.bytes) && data.bytes >= 0 ? data.bytes : null;
  const whiteMesh = data.whiteMesh === true || isWhiteMeshStep(data);
  const materials = data.metadata?.materials;
  const status = whiteMesh
    ? '白模 · 未展UV · 无材质'
    : Number.isInteger(materials) && materials > 0 ? `含 ${materials} 个材质` : '几何模型';
  const stats = [
    triangles != null ? `${triangles.toLocaleString('zh-CN')} 面` : null,
    vertices != null ? `${vertices.toLocaleString('zh-CN')} 顶点` : null,
    bytes != null ? formatBytes(bytes) : null,
  ].filter(Boolean);
  return {
    name, status, stats: stats.join(' · '), whiteMesh,
    persisted: PROJECT_GLB.test(data.assetPath || ''),
  };
}

export function modelPreviewActions(data = {}) {
  const summary = modelResultSummary(data);
  if (summary.persisted) return { ...summary, view: true, persist: false, viewLabel: '查看 3D 模型' };
  if (data.url) return { ...summary, view: false, persist: true, viewLabel: '写入项目并预览' };
  return { ...summary, view: false, persist: false, viewLabel: '查看 3D 模型' };
}

export async function persistGeneratedModelFiles(files, persist) {
  if (!Array.isArray(files)) return files;
  const saved = [];
  for (const file of files) {
    if (file?.kind !== 'model') { saved.push(file); continue; }
    saved.push({ ...file, ...(await persist(file)) });
  }
  return saved;
}
