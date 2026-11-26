// Inverse of the stage transform. CSS origin is the frame's top-left.

export function invertPaintViewport(clientX, clientY, {
  layoutLeft = 0, layoutTop = 0, panX = 0, panY = 0, zoom = 1, rotation = 0, flip = false,
} = {}) {
  const scale = zoom || 1;
  const radians = rotation * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const mirror = flip ? -1 : 1;
  const a = scale * cosine * mirror;
  const b = -scale * sine;
  const c = scale * sine * mirror;
  const d = scale * cosine;
  const determinant = a * d - b * c;
  const vx = clientX - layoutLeft - panX;
  const vy = clientY - layoutTop - panY;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-8) return { x: vx, y: vy };
  return { x: (d * vx - b * vy) / determinant, y: (-c * vx + a * vy) / determinant };
}

export function forwardPaintViewport(x, y, view = {}) {
  const scale = view.zoom || 1;
  const radians = (view.rotation || 0) * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const mirror = view.flip ? -1 : 1;
  return {
    x: (view.layoutLeft || 0) + (view.panX || 0) + scale * (cosine * mirror * x - sine * y),
    y: (view.layoutTop || 0) + (view.panY || 0) + scale * (sine * mirror * x + cosine * y),
  };
}

export function clientToCanvasPoint(clientX, clientY, frame) {
  const parent = frame?.offsetParent || frame?.parentElement;
  if (!frame || !parent || typeof DOMMatrix === 'undefined') {
    const rect = frame?.getBoundingClientRect?.() || { left: 0, top: 0, width: 1, height: 1 };
    const width = frame?.querySelector?.('canvas')?.width || rect.width || 1;
    const height = frame?.querySelector?.('canvas')?.height || rect.height || 1;
    return { x: (clientX - rect.left) * width / (rect.width || 1), y: (clientY - rect.top) * height / (rect.height || 1) };
  }
  const parentRect = parent.getBoundingClientRect();
  const layoutLeft = parentRect.left + frame.offsetLeft - parent.scrollLeft;
  const layoutTop = parentRect.top + frame.offsetTop - parent.scrollTop;
  const raw = getComputedStyle(frame).transform;
  const matrix = new DOMMatrix(raw && raw !== 'none' ? raw : 'matrix(1, 0, 0, 1, 0, 0)');
  const local = matrix.inverse().transformPoint(new DOMPoint(clientX - layoutLeft, clientY - layoutTop));
  return { x: local.x, y: local.y };
}
