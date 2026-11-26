import { restoreRect } from './paint-engine.js';

export function palmBlocksStroke(palm, event, pointerCount = 1) {
  return Boolean(palm && event?.pointerType === 'touch' && pointerCount < 2);
}

export function createLocalHistory() {
  return { undo: [], redo: [] };
}

export function pushLocalHistory(history, entry) {
  if (!entry) return history;
  history.undo.push(entry);
  history.redo = [];
  return history;
}

export function undoLocalHistory(history, buffers) {
  const entry = history.undo.pop();
  if (!entry) return null;
  const buffer = buffers.get(entry.layerId);
  if (buffer) restoreRect(buffer, { x: entry.x, y: entry.y, width: entry.width, height: entry.height, pixels: entry.before });
  history.redo.push(entry);
  return entry;
}

export function redoLocalHistory(history, buffers) {
  const entry = history.redo.pop();
  if (!entry) return null;
  const buffer = buffers.get(entry.layerId);
  if (buffer) restoreRect(buffer, { x: entry.x, y: entry.y, width: entry.width, height: entry.height, pixels: entry.after });
  history.undo.push(entry);
  return entry;
}
