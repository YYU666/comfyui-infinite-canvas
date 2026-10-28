import { backupLegacyProject, importProject } from './project-store-http';

const RECEIPT_KEY = 'h3-indexeddb-migration-v1';
const encoder = new TextEncoder();

function openDatabase(name, stores) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => stores.forEach((store) => {
      if (!request.result.objectStoreNames.contains(store)) request.result.createObjectStore(store, store === 'projects' ? { keyPath: 'id' } : undefined);
    });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function receipts() {
  try { return JSON.parse(localStorage.getItem(RECEIPT_KEY) || '{}'); }
  catch { return {}; }
}

export async function listLegacyProjects() {
  const db = await openDatabase('h3-canvas-projects', ['projects', 'settings']);
  try {
    const rows = await requestResult(db.transaction('projects', 'readonly').objectStore('projects').getAll());
    const migrated = receipts();
    return rows.filter((row) => row?.id && Array.isArray(row?.canvas?.nodes) && !migrated[row.id]);
  } finally { db.close(); }
}

async function readLegacyMedia() {
  const db = await openDatabase('h3-workbench-media', ['files']);
  try {
    const transaction = db.transaction('files', 'readonly');
    const store = transaction.objectStore('files');
    const [keys, values] = await Promise.all([requestResult(store.getAllKeys()), requestResult(store.getAll())]);
    return new Map(keys.map((key, index) => [key, values[index]]));
  } finally { db.close(); }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let k = 0; k < 8; k += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[n] = value >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function headers(entries) {
  let offset = 0;
  const locals = [];
  const centrals = [];
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const crc = crc32(entry.data);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, 0, true); lv.setUint16(10, 0, true); lv.setUint16(12, 0x2821, true);
    lv.setUint32(14, crc, true); lv.setUint32(18, entry.data.length, true); lv.setUint32(22, entry.data.length, true);
    lv.setUint16(26, name.length, true); local.set(name, 30);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true);
    cv.setUint16(12, 0x2821, true); cv.setUint32(16, crc, true);
    cv.setUint32(20, entry.data.length, true); cv.setUint32(24, entry.data.length, true);
    cv.setUint16(28, name.length, true); cv.setUint32(42, offset, true); central.set(name, 46);
    locals.push(local, entry.data); centrals.push(central);
    offset += local.length + entry.data.length;
  }
  const centralSize = centrals.reduce((sum, item) => sum + item.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true); ev.setUint32(16, offset, true);
  return new Blob([...locals, ...centrals, end], { type: 'application/zip' });
}

export async function createLegacyPackage(project, media) {
  const document = JSON.parse(JSON.stringify({ ...project, schemaVersion: project.schemaVersion || 2, assets: [] }));
  const entries = [];
  for (const node of document.canvas.nodes) {
    if (!node.data?.localFile) continue;
    const storageId = node.data.mediaStorageId || node.id;
    const file = media.get(`${project.id}/${storageId}`) || (project.legacyMedia ? media.get(node.id) : null);
    if (!file) continue;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const sha256 = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    const extension = (file.name.match(/\.[A-Za-z0-9]+$/)?.[0] || '.bin').toLowerCase();
    const path = `assets/${sha256}${extension}`;
    node.data.assetPath = path;
    node.data.url = '';
    document.assets.push({ path, sha256, bytes: bytes.length, mime: file.type || 'application/octet-stream' });
    entries.push({ name: path, data: bytes });
  }
  entries.unshift({ name: 'project.json', data: encoder.encode(JSON.stringify(document)) });
  return headers(entries);
}

export async function migrateLegacyProjects(onProgress = () => {}) {
  const projects = await listLegacyProjects();
  const media = await readLegacyMedia();
  const migrated = [];
  const failed = [];
  for (let index = 0; index < projects.length; index += 1) {
    const project = projects[index];
    onProgress({ index, total: projects.length, name: project.name });
    try {
      const packageBlob = await createLegacyPackage(project, media);
      await backupLegacyProject(packageBlob);
      const imported = await importProject(packageBlob);
      if (imported.canvas.nodes.length !== project.canvas.nodes.length
        || imported.canvas.edges.length !== (project.canvas.edges || []).length
        || imported.assets.length !== project.canvas.nodes.filter((node) => node.data?.localFile && (media.get(`${project.id}/${node.data.mediaStorageId || node.id}`) || (project.legacyMedia && media.get(node.id)))).length) {
        throw new Error('迁移后的节点、连线或素材数量不一致。');
      }
      const next = { ...receipts(), [project.id]: imported.id };
      localStorage.setItem(RECEIPT_KEY, JSON.stringify(next));
      migrated.push(imported);
    } catch (error) {
      failed.push({ name: project.name, error: error.message });
    }
  }
  onProgress({ index: projects.length, total: projects.length });
  return { total: projects.length, migrated, failed };
}
