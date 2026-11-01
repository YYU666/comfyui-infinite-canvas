export const PROJECT_SESSION_KEY = 'h3-current-project-v1';

// Only this tab's explicitly opened project is eligible for restoration.
export function createProjectSession(getStorage = () => globalThis.sessionStorage) {
  let cached = null;
  const identity = ({ id, readOnly }) => JSON.stringify([id, readOnly === true]);
  function read() {
    try {
      const value = JSON.parse(getStorage()?.getItem(PROJECT_SESSION_KEY) || 'null');
      if (value?.version !== 1 || typeof value.id !== 'string' || !value.id.trim()
        || typeof value.readOnly !== 'boolean') return null;
      return { id: value.id, readOnly: value.readOnly };
    } catch { return null; }
  }
  function remember(document) {
    const entry = { id: document.id, readOnly: document.readOnly === true };
    try { getStorage()?.setItem(PROJECT_SESSION_KEY, JSON.stringify({ version: 1, ...entry })); }
    catch { /* Disabled/full preference storage must not block opening a project. */ }
    cached = { key: identity(entry), promise: Promise.resolve(document) };
    return document;
  }
  function clear() {
    cached = null;
    try { getStorage()?.removeItem(PROJECT_SESSION_KEY); }
    catch { /* The launcher still works when session storage is unavailable. */ }
  }
  function restore(openProject) {
    const entry = read();
    if (!entry) return Promise.resolve(null);
    const key = identity(entry);
    if (cached?.key === key) return cached.promise;
    const promise = Promise.resolve().then(() => openProject(entry.id, { readOnly: entry.readOnly }))
      .then(remember, (error) => { clear(); throw error; });
    // Retain the result across React effect replay and App remounts.
    cached = { key, promise };
    return promise;
  }
  return { read, remember, clear, restore };
}

export const projectSession = createProjectSession();
