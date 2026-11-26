import { createRoundStamp } from './paint-engine.js';

function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function grainStamp(size, hardness, seed, amount) {
  const stamp = createRoundStamp(size, hardness);
  const next = random(seed);
  for (let index = 0; index < stamp.alpha.length; index += 1) {
    if (!stamp.alpha[index]) continue;
    stamp.alpha[index] = Math.max(0, Math.min(255, stamp.alpha[index] - Math.floor(next() * amount)));
  }
  return stamp;
}

function ellipseStamp(width, height) {
  const alpha = new Uint8Array(width * height);
  const rx = (width - 1) / 2;
  const ry = (height - 1) / 2;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const nx = (x - rx) / Math.max(rx, 0.5);
      const ny = (y - ry) / Math.max(ry, 0.5);
      const distance = nx * nx + ny * ny;
      alpha[y * width + x] = distance <= 1 ? 255 : 0;
    }
  }
  return { width, height, alpha };
}

function watercolorStamp(size) {
  const stamp = createRoundStamp(size, 0);
  const radius = (size - 1) / 2;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const distance = Math.hypot(x - radius, y - radius) / Math.max(radius, 0.5);
      const edge = distance > 0.55 && distance < 1 ? 40 : 0;
      const index = y * size + x;
      stamp.alpha[index] = Math.max(0, Math.min(255, stamp.alpha[index] + edge));
    }
  }
  return stamp;
}

function markerStamp(width, height, angle) {
  const box = Math.ceil(Math.hypot(width, height)) + 2;
  const alpha = new Uint8Array(box * box);
  const radians = angle * Math.PI / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const cx = (box - 1) / 2;
  const cy = (box - 1) / 2;
  for (let y = 0; y < box; y += 1) {
    for (let x = 0; x < box; x += 1) {
      const dx = x - cx;
      const dy = y - cy;
      const localX = Math.abs(dx * cos + dy * sin);
      const localY = Math.abs(-dx * sin + dy * cos);
      alpha[y * box + x] = localX <= width / 2 && localY <= height / 2 ? 230 : 0;
    }
  }
  return { width: box, height: box, alpha };
}

const base = {
  size: 16, hardness: 80, spacing: 12, opacity: 100, flow: 100,
  pressureSize: false, pressureOpacity: false, minDiameter: 20, smoothing: 20,
  angle: 0, followDirection: false, sizeJitter: 0, angleJitter: 0, scatter: 0, blendMode: 'normal',
};

export const BUILTIN_BRUSHES = [
  { id: 'builtin-hard-round', builtin: true, group: '内置', name: '硬圆勾线笔', kind: 'round', params: { ...base, size: 8, hardness: 95, spacing: 6, pressureSize: true, minDiameter: 12, smoothing: 18 } },
  { id: 'builtin-soft-air', builtin: true, group: '内置', name: '软边喷枪', kind: 'round', params: { ...base, size: 48, hardness: 0, spacing: 8, opacity: 35, flow: 28, pressureOpacity: true, pressureSize: true, minDiameter: 40, smoothing: 30 } },
  { id: 'builtin-pencil-2b', builtin: true, group: '内置', name: '2B 素描铅笔', kind: 'stamp', stamp: grainStamp(24, 55, 21, 110), params: { ...base, size: 10, spacing: 8, opacity: 80, pressureSize: true, pressureOpacity: true, minDiameter: 25, sizeJitter: 8, smoothing: 12 } },
  { id: 'builtin-charcoal', builtin: true, group: '内置', name: '炭笔肌理笔', kind: 'stamp', stamp: grainStamp(36, 35, 77, 180), params: { ...base, size: 28, spacing: 10, opacity: 70, followDirection: true, angleJitter: 18, scatter: 0.15, pressureSize: true, minDiameter: 30, smoothing: 8 } },
  { id: 'builtin-flat-paint', builtin: true, group: '内置', name: '扁平厚涂笔', kind: 'stamp', stamp: ellipseStamp(46, 14), params: { ...base, size: 36, spacing: 8, followDirection: true, pressureSize: true, minDiameter: 35, smoothing: 22 } },
  { id: 'builtin-watercolor', builtin: true, group: '内置', name: '水彩晕染笔', kind: 'stamp', stamp: watercolorStamp(40), params: { ...base, size: 40, spacing: 14, opacity: 30, flow: 45, pressureOpacity: true, smoothing: 35 } },
  { id: 'builtin-marker', builtin: true, group: '内置', name: '平头马克笔', kind: 'stamp', stamp: markerStamp(34, 10, -32), params: { ...base, size: 24, spacing: 7, opacity: 55, flow: 80, blendMode: 'overlay', smoothing: 10 } },
  { id: 'builtin-pixel', builtin: true, group: '内置', name: '像素硬笔', kind: 'pixel', params: { ...base, size: 8, hardness: 100, spacing: 100, smoothing: 0, pressureSize: false } },
];

export function builtinBrushes() {
  return BUILTIN_BRUSHES.map((brush) => ({ ...brush, params: { ...brush.params }, stamp: brush.stamp || null }));
}

export function brushState(entry) {
  return {
    id: entry.id,
    name: entry.name,
    kind: entry.kind || 'stamp',
    stamp: entry.stamp || null,
    ...entry.params,
  };
}

export const IMPORT_BRUSH_PARAMS = {
  ...base, size: 32, hardness: 100, spacing: 12, pressureSize: true, minDiameter: 20, smoothing: 15,
};
