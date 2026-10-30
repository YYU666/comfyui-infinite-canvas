import { normalizeMediaUrl } from './workbench-api';

const API_ROOT = '/api/projects';

function normalizeLegacyMedia(document) {
  if (!document || typeof document !== 'object') return document;
  for (const project of [document, ...(document.projects || [])]) {
    if (project?.thumbnail) project.thumbnail = normalizeMediaUrl(project.thumbnail);
    for (const node of project?.canvas?.nodes || []) {
      for (const field of ['url', 'resultUrl', 'thumbnail']) {
        if (node?.data?.[field]) node.data[field] = normalizeMediaUrl(node.data[field]);
      }
    }
  }
  return document;
}

async function request(path, options = {}) {
  const response = await fetch(`${API_ROOT}${path}`, options);
  const type = response.headers.get('content-type') || '';
  const body = type.includes('application/json') ? await response.json() : await response.blob();
  if (!response.ok) {
    const error = new Error(body?.message || `项目服务请求失败（${response.status}）。`);
    error.status = response.status;
    error.code = body?.code;
    error.details = body?.details;
    throw error;
  }
  return normalizeLegacyMedia(body);
}

function json(method, payload, headers = {}) {
  return { method, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(payload) };
}

function editable(document, readOnly = false) {
  Object.defineProperty(document, 'readOnly', { value: readOnly, enumerable: false, configurable: true });
  return document;
}

function assetUrl(projectId, assetPath) {
  return `${API_ROOT}/${projectId}/${assetPath.split('/').map(encodeURIComponent).join('/')}`;
}

export async function listProjects({ trash = false } = {}) {
  const result = await request(trash ? '/trash' : '');
  return result.projects.filter((project) => project.id).map(projectSummary);
}

export async function initializeProjects(fallback) {
  const rows = await listProjects();
  if (rows.length) return openProject(rows[0].id);
  const created = await createProject('我的本地创作', fallback());
  return openProject(created.id);
}

export async function createProject(name, canvas, template = 'blank', directory) {
  return request('', json('POST', { name, canvas, template, directory }));
}

export async function openProject(id, { readOnly = false, fallbackToReadOnly = true } = {}) {
  try {
    return editable(await request('/open', json('POST', { id, readOnly })), readOnly);
  } catch (error) {
    if (error.status === 423 && !readOnly && fallbackToReadOnly) return openProject(id, { readOnly: true, fallbackToReadOnly: false });
    throw error;
  }
}

export async function openProjectPath(path, { readOnly = false } = {}) {
  try {
    return editable(await request('/open', json('POST', { path, readOnly })), readOnly);
  } catch (error) {
    if (error.status === 423 && !readOnly) return openProjectPath(path, { readOnly: true });
    throw error;
  }
}

export async function closeProject(id) {
  return request(`/${id}/close`, json('POST', {}));
}

export async function saveProject(id, revision, name, canvas) {
  const current = await request(`/${id}`);
  const document = { ...current, name: name.trim() || '未命名项目', canvas };
  return editable(await request(`/${id}`, json('PUT', document, { 'If-Match': String(revision) })));
}

export function projectSummary(project) {
  const cover = project.thumbnail || project.canvas?.nodes?.find((node) => node.type === 'media'
    && node.data?.kind === 'image' && node.data.assetPath)?.data.assetPath;
  return {
    id: project.id, name: project.name, path: project.path,
    createdAt: project.createdAt, updatedAt: project.updatedAt, revision: project.revision,
    nodeCount: project.nodeCount ?? project.canvas?.nodes?.length ?? 0,
    edgeCount: project.edgeCount ?? project.canvas?.edges?.length ?? 0,
    shotCount: project.shotCount ?? project.shots?.length ?? 0,
    bytes: project.bytes || 0, trashName: project.trashName, deletedAt: project.deletedAt,
    thumbnail: cover && !cover.startsWith('/api/') ? assetUrl(project.id, cover) : cover,
  };
}

export async function saveProjectFile(projectId, nodeId, file) {
  const result = await request(`/${projectId}/assets/${encodeURIComponent(file.name || nodeId)}`, {
    method: 'PUT', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file,
  });
  return result;
}

export async function readProjectFile(project, nodeId, assetPath) {
  if (!assetPath) return null;
  const response = await fetch(assetUrl(project.id, assetPath));
  if (!response.ok) throw new Error('项目素材读取失败，请检查 assets 文件夹。');
  const blob = await response.blob();
  const name = assetPath.split('/').pop();
  return new File([blob], name, { type: blob.type || 'application/octet-stream', lastModified: Date.now() });
}

// Assets are content-addressed and immutable. Orphan collection belongs to M2.
export async function deleteProjectFile() {}

export async function deleteProject(id) {
  return request(`/${id}`, { method: 'DELETE' });
}

export async function restoreProject(trashName) {
  return request('/restore', json('POST', { name: trashName }));
}

export async function duplicateProject(id) {
  return request(`/${id}/duplicate`, json('POST', {}));
}

export async function exportProject(id) {
  return request(`/${id}/export`, json('POST', {}));
}

export async function revealProject(id) {
  return request(`/${id}/reveal`, json('POST', {}));
}

export async function renameProject(project, name) {
  const current = await request(`/${project.id}`);
  return saveProject(project.id, current.revision, name, current.canvas);
}

export async function importProject(fileOrPath) {
  if (typeof fileOrPath === 'string') return request('/import', json('POST', { path: fileOrPath }));
  return request('/import', { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: fileOrPath });
}

export async function backupLegacyProject(packageBlob) {
  return request('/migration-backup', { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: packageBlob });
}

export async function createDomainEntity(project, collection, data) {
  return request(`/${project.id}/${collection}`, json('POST', { ...data, revision: project.revision }));
}

export async function updateDomainEntity(project, collection, entityId, data) {
  return request(`/${project.id}/${collection}/${entityId}`, json('PUT', { ...data, revision: project.revision }));
}

export async function deleteDomainEntity(project, collection, entityId) {
  return request(`/${project.id}/${collection}/${entityId}`, { method: 'DELETE', headers: { 'If-Match': String(project.revision) } });
}

export async function createTake(project, shotId, data) {
  return request(`/${project.id}/shots/${shotId}/takes`, json('POST', { ...data, revision: project.revision }));
}

export async function updateTake(project, shotId, takeId, data) {
  return request(`/${project.id}/shots/${shotId}/takes/${takeId}`, json('PUT', { ...data, revision: project.revision }));
}

export async function updateProjectMetadata(project, data) {
  return request(`/${project.id}/metadata`, json('PUT', { ...data, revision: project.revision }));
}

export async function updateProjectHandoff(project, data) {
  return editable(await request(`/${project.id}/handoff`, json('PUT', { ...data, revision: project.revision })), project.readOnly);
}

export async function searchProject(projectId, query, kind) {
  const params = new URLSearchParams({ q: query });
  if (kind) params.set('kind', kind);
  return request(`/${projectId}/search?${params}`);
}

export async function exportDelivery(projectId, takeIds) {
  return request(`/${projectId}/delivery-export`, json('POST', { takeIds }));
}

export { assetUrl };
