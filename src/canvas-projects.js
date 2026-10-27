export const PROJECT_DB_NAME = 'h3-canvas-projects';
export const LEGACY_CANVAS_KEY = 'h3-infinite-canvas-v2';
const ACTIVE_KEY = 'h3-active-canvas-project-v1';

function openProjects() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(PROJECT_DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('projects', { keyPath: 'id' });
      request.result.createObjectStore('settings');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('项目存储正被其他窗口占用，请关闭旧窗口后重试。'));
  });
}

function result(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function complete(tx) {
  const promise = new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error || new Error('项目保存失败。'));
    tx.onabort = () => reject(tx.error || new Error('项目保存已中止。'));
  });
  // Requests and transaction errors can reject together. Mark this rejection
  // handled immediately while retaining it for the caller's awaited result.
  promise.catch(() => {});
  return promise;
}

function projectRecord(name, canvas, legacyMedia = false) {
  const now = Date.now();
  return { id: `project-${crypto.randomUUID()}`, name: name.trim() || '未命名项目', canvas,
    createdAt: now, updatedAt: now, revision: 0, legacyMedia };
}

function legacyCanvas(fallback) {
  for (const key of [LEGACY_CANVAS_KEY, 'h3-infinite-canvas-v1']) {
    const raw = localStorage.getItem(key);
    if (!raw) continue;
    let canvas;
    try { canvas = JSON.parse(raw); }
    catch { throw new Error('原画布数据无法读取，已保留原记录。请先恢复备份，再打开项目列表。'); }
    if (!Array.isArray(canvas?.nodes) || (canvas.edges !== undefined && !Array.isArray(canvas.edges))) {
      throw new Error('原画布格式不完整，已保留原记录。请先恢复备份。');
    }
    return { canvas: { ...canvas, edges: canvas.edges || [] }, legacyMedia: true };
  }
  return { canvas: fallback(), legacyMedia: false };
}

export async function initializeProjects(fallback) {
  const db = await openProjects();
  try {
    const tx = db.transaction(['projects', 'settings'], 'readwrite');
    const finished = complete(tx);
    const projects = tx.objectStore('projects');
    const settings = tx.objectStore('settings');
    const all = await result(projects.getAll());
    let recovery;
    try { recovery = JSON.parse(localStorage.getItem('h3-canvas-recovery-receipt-v1') || 'null'); }
    catch { /* An unrelated invalid recovery receipt cannot replace a project. */ }
    const recoveryToken = recovery?.source === 'Kimi Work' && Number.isInteger(recovery.sourceSequence)
      ? `${recovery.source}/${recovery.sourceSequence}` : null;
    const importedToken = await result(settings.get('recoveryToken'));
    let active;
    if (!all.length || (recoveryToken && recoveryToken !== importedToken)) {
      const imported = legacyCanvas(fallback);
      if (all.length && (imported.canvas.nodes.length !== recovery.nodes || imported.canvas.edges.length !== recovery.edges)) {
        await finished;
        throw new Error('恢复记录与画布内容不一致，已有项目已保留。请重新打开恢复页面。');
      }
      active = projectRecord(localStorage.getItem('h3-canvas-name-v1') || '我的本地创作', imported.canvas, imported.legacyMedia);
      projects.add(active);
      settings.put(active.id, 'activeId');
      if (recoveryToken) settings.put(recoveryToken, 'recoveryToken');
    } else {
      const activeId = await result(settings.get('activeId'));
      active = all.find((project) => project.id === activeId) || all[0];
    }
    await finished;
    try { localStorage.setItem(ACTIVE_KEY, active.id); }
    catch { /* IndexedDB retains the selected project when this cache is full. */ }
    return active;
  } finally { db.close(); }
}

export async function listProjects() {
  const db = await openProjects();
  try {
    const tx = db.transaction('projects', 'readonly');
    const finished = complete(tx);
    const rows = await result(tx.objectStore('projects').getAll());
    await finished;
    return rows.sort((a, b) => b.updatedAt - a.updatedAt).map(projectSummary);
  } finally { db.close(); }
}

export function projectSummary({ canvas, ...project }) {
  const thumbnail = canvas.nodes.find((node) => node.type === 'media' && node.data?.kind === 'image'
    && (node.data.remoteName || node.data.output) && /^http:\/\/(127\.0\.0\.1|localhost):8188\/view\?/.test(node.data.url || ''))?.data.url;
  return { ...project, nodeCount: canvas.nodes.length, edgeCount: canvas.edges.length, thumbnail };
}

export async function createProject(name, canvas) {
  const project = projectRecord(name, canvas);
  const db = await openProjects();
  try {
    const tx = db.transaction('projects', 'readwrite');
    const finished = complete(tx);
    tx.objectStore('projects').add(project);
    await finished;
    return project;
  } finally { db.close(); }
}

export async function openProject(id) {
  const db = await openProjects();
  try {
    const tx = db.transaction(['projects', 'settings'], 'readwrite');
    const finished = complete(tx);
    const project = await result(tx.objectStore('projects').get(id));
    if (!project) { await finished; throw new Error('项目不存在，请刷新项目列表。'); }
    tx.objectStore('settings').put(id, 'activeId');
    await finished;
    try { localStorage.setItem(ACTIVE_KEY, id); }
    catch { /* The durable activeId was committed above. */ }
    return project;
  } finally { db.close(); }
}

export async function saveProject(id, revision, name, canvas) {
  const db = await openProjects();
  try {
    const tx = db.transaction('projects', 'readwrite');
    const finished = complete(tx);
    const store = tx.objectStore('projects');
    const previous = await result(store.get(id));
    if (!previous || previous.revision !== revision) {
      await finished;
      throw new Error('另一个窗口已更新此项目。当前修改尚未保存，请保留本页内容，刷新后再继续。');
    }
    const project = { ...previous, name: name.trim() || '未命名项目', canvas,
      revision: revision + 1, updatedAt: Date.now() };
    store.put(project);
    await finished;
    // Compatibility cache is not the project database. A full localStorage must
    // never turn a successful IndexedDB commit into an apparent failed save.
    try {
      if (localStorage.getItem(ACTIVE_KEY) === id) {
        localStorage.setItem(LEGACY_CANVAS_KEY, JSON.stringify(canvas));
        localStorage.setItem('h3-canvas-name-v1', project.name);
      }
    } catch { /* The durable project remains available in IndexedDB. */ }
    return project;
  } finally { db.close(); }
}

export function projectMediaKey(projectId, nodeId) {
  return `${projectId}/${nodeId}`;
}

function openMedia() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('h3-workbench-media', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('files');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('素材存储正被其他窗口占用。'));
  });
}

export async function saveProjectFile(projectId, nodeId, file) {
  const db = await openMedia();
  try {
    const tx = db.transaction('files', 'readwrite');
    const finished = complete(tx);
    tx.objectStore('files').put(file, projectMediaKey(projectId, nodeId));
    await finished;
  } finally { db.close(); }
}

export async function readProjectFile(project, nodeId) {
  const db = await openMedia();
  try {
    const tx = db.transaction('files', 'readonly');
    const finished = complete(tx);
    const store = tx.objectStore('files');
    let file = await result(store.get(projectMediaKey(project.id, nodeId)));
    // Only the migrated project may read pre-project media. Never delete or
    // replace those original records while operating on project-scoped files.
    if (!file && project.legacyMedia) file = await result(store.get(nodeId));
    await finished;
    return file;
  } finally { db.close(); }
}

export async function deleteProjectFile(projectId, nodeId) {
  const db = await openMedia();
  try {
    const tx = db.transaction('files', 'readwrite');
    const finished = complete(tx);
    tx.objectStore('files').delete(projectMediaKey(projectId, nodeId));
    await finished;
  } finally { db.close(); }
}
