const key = (id) => `h3-canvas-viewport-v1:${id}`;
const valid = (value) => value && ['x', 'y', 'zoom'].every((field) => Number.isFinite(value[field])) && value.zoom > 0;
export function readViewport(id, fallback, storage = localStorage) {
  try { const value = JSON.parse(storage.getItem(key(id))); return valid(value) ? value : fallback; }
  catch { return fallback; }
}
export function saveViewport(id, value, storage = localStorage) {
  try { if (valid(value)) storage.setItem(key(id), JSON.stringify(value)); }
  catch { /* A full/disabled preference store must not block project content. */ }
}
