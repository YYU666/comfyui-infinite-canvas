// Publication identities contain only random IDs, never project names or local node IDs.
const AUTHOR_KEY = 'h3-workflow-share-author-v1';
const memory = new Map();
const PACKAGE_ID = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?\/[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const authorPattern = /^u-[a-f0-9]{32}$/;
const randomId = () => crypto.randomUUID().replaceAll('-', '');
const nodeKey = (projectId, nodeId) => `h3-workflow-share-package-v1:${JSON.stringify([projectId, nodeId])}`;
function read(key) {
  if (memory.has(key)) return memory.get(key);
  try { return localStorage.getItem(key); } catch { return undefined; }
}
function write(key, value) {
  memory.set(key, value);
  try { localStorage.setItem(key, value); } catch { /* Session fallback if browser storage is unavailable. */ }
}

export function sharePackageIdentity(projectId, nodeId, { fresh = false } = {}) {
  const key = nodeKey(projectId, nodeId);
  const saved = read(key);
  if (!fresh && PACKAGE_ID.test(saved || '') && saved !== 'community/my-workflow') return saved;
  let author = read(AUTHOR_KEY);
  if (fresh || !authorPattern.test(author || '')) {
    author = `u-${randomId()}`;
    write(AUTHOR_KEY, author);
  }
  const packageId = `${author}/workflow-${randomId()}`;
  write(key, packageId);
  return packageId;
}

export function rememberSharePackageIdentity(projectId, nodeId, packageId) {
  if (PACKAGE_ID.test(packageId) && packageId !== 'community/my-workflow') write(nodeKey(projectId, nodeId), packageId);
}
