// Unified stamp, selection, fill and flatten engine.
// Operates on typed-array buffers so Node tests do not need a DOM canvas.
// History callers store one dirty rectangle, never a clone of every layer.

import { LAYER_BLEND_MODES, normalizePaintData } from './paint-document.js';

export const PAPER_COLORS = {
  transparent: [0, 0, 0, 0],
  white: [255, 255, 255, 255],
  warm: [0xf3, 0xea, 0xd8, 255],
  dark: [0x1b, 0x1e, 0x1d, 255],
};

export const BASIC_ROUND_BRUSH = {
  id: 'round', name: '圆笔', kind: 'round', size: 16, hardness: 80, spacing: 12,
  opacity: 100, flow: 100, pressureSize: true, pressureOpacity: false, minDiameter: 20,
  angle: 0, followDirection: false, sizeJitter: 0, angleJitter: 0, scatter: 0, smoothing: 10, seed: 1,
};

export class PaintBuffer {
  constructor(width, height, fill = null) {
    this.width = Math.max(1, width | 0);
    this.height = Math.max(1, height | 0);
    this.data = new Uint8ClampedArray(this.width * this.height * 4);
    if (fill) this.clear(fill);
  }

  clone() {
    const next = new PaintBuffer(this.width, this.height);
    next.data.set(this.data);
    return next;
  }

  clear(color) {
    const [r, g, b, a] = parseColor(color);
    for (let index = 0; index < this.data.length; index += 4) {
      this.data[index] = r; this.data[index + 1] = g; this.data[index + 2] = b; this.data[index + 3] = a;
    }
  }
}

export function parseColor(input) {
  if (Array.isArray(input)) {
    const [r = 0, g = 0, b = 0, a = 255] = input;
    return [clampByte(r), clampByte(g), clampByte(b), clampByte(a)];
  }
  const text = String(input || '').trim();
  const hex = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(text);
  if (hex) {
    const value = Number.parseInt(hex[1], 16);
    const alpha = hex[2] ? Number.parseInt(hex[2], 16) : 255;
    return [(value >> 16) & 255, (value >> 8) & 255, value & 255, alpha];
  }
  const rgb = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i.exec(text);
  if (rgb) {
    const alpha = rgb[4] === undefined ? 255 : clampByte(Number(rgb[4]) <= 1 ? Number(rgb[4]) * 255 : Number(rgb[4]));
    return [clampByte(rgb[1]), clampByte(rgb[2]), clampByte(rgb[3]), alpha];
  }
  return [0, 0, 0, 255];
}

export function colorToHex([r, g, b]) {
  return `#${[r, g, b].map((channel) => clampByte(channel).toString(16).padStart(2, '0')).join('')}`;
}

export function rgbToHsv(r, g, b) {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const delta = max - min;
  let h = 0;
  if (delta) {
    if (max === rn) h = ((gn - bn) / delta) % 6;
    else if (max === gn) h = (bn - rn) / delta + 2;
    else h = (rn - gn) / delta + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max ? delta / max : 0, v: max };
}

export function hsvToRgb(h, s, v) {
  const hue = ((h % 360) + 360) % 360;
  const c = v * s;
  const x = c * (1 - Math.abs((hue / 60) % 2 - 1));
  const m = v - c;
  const sector = Math.floor(hue / 60);
  const map = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][sector];
  return [clampByte((map[0] + m) * 255), clampByte((map[1] + m) * 255), clampByte((map[2] + m) * 255), 255];
}

function clampByte(value) {
  return Math.max(0, Math.min(255, Math.round(Number(value) || 0)));
}

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

export function createBuffers(doc) {
  const normalized = normalizePaintData(doc);
  const buffers = new Map();
  for (const layer of normalized.layers) buffers.set(layer.id, new PaintBuffer(normalized.paper.width, normalized.paper.height));
  return buffers;
}

export function resizeBuffers(buffers, doc, width, height) {
  const next = new Map();
  for (const layer of doc.layers) {
    const source = buffers.get(layer.id);
    const buffer = new PaintBuffer(width, height);
    if (source) blit(buffer, source, 0, 0);
    next.set(layer.id, buffer);
  }
  return next;
}

function blit(target, source, dx, dy) {
  for (let y = 0; y < source.height; y += 1) {
    const ty = y + dy;
    if (ty < 0 || ty >= target.height) continue;
    for (let x = 0; x < source.width; x += 1) {
      const tx = x + dx;
      if (tx < 0 || tx >= target.width) continue;
      const from = (y * source.width + x) * 4;
      const to = (ty * target.width + tx) * 4;
      target.data[to] = source.data[from];
      target.data[to + 1] = source.data[from + 1];
      target.data[to + 2] = source.data[from + 2];
      target.data[to + 3] = source.data[from + 3];
    }
  }
}

export function captureRect(buffer, rect) {
  const bounds = clipRect(buffer, rect);
  const pixels = new Uint8ClampedArray(bounds.width * bounds.height * 4);
  for (let y = 0; y < bounds.height; y += 1) {
    const from = ((bounds.y + y) * buffer.width + bounds.x) * 4;
    pixels.set(buffer.data.subarray(from, from + bounds.width * 4), y * bounds.width * 4);
  }
  return { ...bounds, pixels };
}

export function restoreRect(buffer, snapshot) {
  if (!snapshot) return;
  for (let y = 0; y < snapshot.height; y += 1) {
    const to = ((snapshot.y + y) * buffer.width + snapshot.x) * 4;
    buffer.data.set(snapshot.pixels.subarray(y * snapshot.width * 4, (y + 1) * snapshot.width * 4), to);
  }
}

function clipRect(buffer, rect) {
  const x = Math.max(0, Math.min(buffer.width, Math.floor(rect.x)));
  const y = Math.max(0, Math.min(buffer.height, Math.floor(rect.y)));
  const right = Math.max(x, Math.min(buffer.width, Math.ceil(rect.x + rect.width)));
  const bottom = Math.max(y, Math.min(buffer.height, Math.ceil(rect.y + rect.height)));
  return { x, y, width: right - x, height: bottom - y };
}

export function countInk(buffer) {
  let count = 0;
  for (let index = 3; index < buffer.data.length; index += 4) if (buffer.data[index] > 0) count += 1;
  return count;
}

function pressureCurve(pressure, curve = 'linear') {
  const value = clamp01(pressure);
  if (curve === 'soft') return Math.sqrt(value);
  if (curve === 'hard') return value * value;
  return value;
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createRoundStamp(size, hardness, pixel = false) {
  const diameter = Math.max(1, Math.round(size));
  const alpha = new Uint8Array(diameter * diameter);
  const radius = (diameter - 1) / 2;
  const hard = clamp01(hardness / 100);
  for (let y = 0; y < diameter; y += 1) {
    for (let x = 0; x < diameter; x += 1) {
      if (pixel) {
        alpha[y * diameter + x] = 255;
        continue;
      }
      const distance = Math.hypot(x - radius, y - radius) / Math.max(radius, 0.5);
      if (distance <= hard) alpha[y * diameter + x] = 255;
      else if (distance < 1) alpha[y * diameter + x] = clampByte(255 * (1 - (distance - hard) / Math.max(0.0001, 1 - hard)));
    }
  }
  return { width: diameter, height: diameter, alpha };
}

function bilinearStamp(stamp, width, height) {
  const alpha = new Uint8Array(width * height);
  const xScale = stamp.width / width;
  const yScale = stamp.height / height;
  for (let y = 0; y < height; y += 1) {
    const sy = (y + 0.5) * yScale - 0.5;
    const y0 = Math.floor(sy);
    const y1 = Math.min(stamp.height - 1, Math.max(0, y0 + 1));
    const yBase = Math.max(0, y0);
    const fy = Math.min(1, Math.max(0, sy - y0));
    for (let x = 0; x < width; x += 1) {
      const sx = (x + 0.5) * xScale - 0.5;
      const x0 = Math.floor(sx);
      const x1 = Math.min(stamp.width - 1, Math.max(0, x0 + 1));
      const xBase = Math.max(0, x0);
      const fx = Math.min(1, Math.max(0, sx - x0));
      const top = stamp.alpha[yBase * stamp.width + xBase] * (1 - fx) + stamp.alpha[yBase * stamp.width + x1] * fx;
      const bottom = stamp.alpha[y1 * stamp.width + xBase] * (1 - fx) + stamp.alpha[y1 * stamp.width + x1] * fx;
      alpha[y * width + x] = clampByte(top * (1 - fy) + bottom * fy);
    }
  }
  return { width, height, alpha };
}

function resizeStampToEdge(stamp, edge, shrinkOnly) {
  if (!stamp?.alpha || !stamp.width || !stamp.height) return stamp;
  const longest = Math.max(stamp.width, stamp.height);
  const target = Math.max(1, Math.round(Number(edge) || 1));
  if (!Number.isFinite(longest) || longest === target || (shrinkOnly && longest <= target)) return stamp;
  const scale = target / longest;
  return bilinearStamp(stamp, Math.max(1, Math.round(stamp.width * scale)), Math.max(1, Math.round(stamp.height * scale)));
}

export function clampStampMaxEdge(stamp, maxEdge = 512) {
  return resizeStampToEdge(stamp, maxEdge, true);
}

export function resizeStamp(stamp, targetDiameter) {
  return resizeStampToEdge(stamp, targetDiameter, false);
}

export function scaleStamp(stamp, maxEdge = 512) {
  return clampStampMaxEdge(stamp, maxEdge);
}

const STAMP_CACHE_LIMIT = 64;
const brushStampCache = new Map();
const stampIdentity = new WeakMap();
let stampSerial = 0;

function brushCacheKey(brush, diameter) {
  const size = Math.max(1, Math.round(diameter));
  const pixel = brush.kind === 'pixel' ? 1 : 0;
  const hardness = pixel ? 100 : Math.round(Number(brush.hardness ?? 100));
  let stampToken = 'round';
  if (pixel) stampToken = 'pixel';
  else if (brush.stamp?.alpha) {
    let token = stampIdentity.get(brush.stamp);
    if (!token) {
      stampSerial += 1;
      token = stampSerial;
      stampIdentity.set(brush.stamp, token);
    }
    stampToken = `stamp${token}`;
  }
  return `${brush.id || 'brush'}|${stampToken}|${size}|${hardness}|${pixel}`;
}

export function clearBrushStampCache() {
  brushStampCache.clear();
}

export function brushStampCacheSize() {
  return brushStampCache.size;
}

export function brushStamp(brush, diameter) {
  const key = brushCacheKey(brush, diameter);
  const cached = brushStampCache.get(key);
  if (cached) {
    brushStampCache.delete(key);
    brushStampCache.set(key, cached);
    return cached;
  }
  const size = Math.max(1, Math.round(diameter));
  const stamp = brush.kind === 'pixel'
    ? createRoundStamp(size, 100, true)
    : brush.stamp?.alpha
      ? resizeStamp(brush.stamp, size)
      : createRoundStamp(size, brush.hardness ?? 100, false);
  brushStampCache.set(key, stamp);
  while (brushStampCache.size > STAMP_CACHE_LIMIT) brushStampCache.delete(brushStampCache.keys().next().value);
  return stamp;
}

function smoothPoints(points, amount) {
  if (!points.length || !amount) return points.map((point) => ({ ...point }));
  const keep = 1 - clamp01(amount / 100) * 0.9;
  let x = points[0].x, y = points[0].y;
  return points.map((point) => {
    x += (point.x - x) * keep;
    y += (point.y - y) * keep;
    return { ...point, x, y };
  });
}

function resample(points, spacing) {
  if (points.length <= 1) return points;
  const step = Math.max(0.4, spacing);
  const output = [{ ...points[0] }];
  let carry = 0;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    const length = Math.hypot(current.x - previous.x, current.y - previous.y);
    if (!length) continue;
    let walked = step - carry;
    while (walked <= length) {
      const t = walked / length;
      output.push({
        ...current,
        x: previous.x + (current.x - previous.x) * t,
        y: previous.y + (current.y - previous.y) * t,
        pressure: previous.pressure + (current.pressure - previous.pressure) * t,
      });
      walked += step;
    }
    carry = length - (walked - step);
  }
  output.push({ ...points[points.length - 1] });
  return output;
}

function blendChannel(mode, source, dest) {
  if (mode === 'multiply') return source * dest;
  if (mode === 'screen') return 1 - (1 - source) * (1 - dest);
  if (mode === 'add') return Math.min(1, source + dest);
  if (mode === 'overlay') return dest <= 0.5 ? 2 * source * dest : 1 - 2 * (1 - source) * (1 - dest);
  if (mode === 'soft-light') {
    if (source <= 0.5) return dest - (1 - 2 * source) * dest * (1 - dest);
    const lifted = dest <= 0.25 ? ((16 * dest - 12) * dest + 4) * dest : Math.sqrt(dest);
    return dest + (2 * source - 1) * (lifted - dest);
  }
  return source;
}

function compositePixel(mode, source, dest, coverage) {
  const srcA = (source[3] / 255) * coverage;
  const dstA = dest[3] / 255;
  if (srcA <= 0) return dest;
  const blended = dest[3] === 0 || mode === 'normal'
    ? source.slice(0, 3).map((channel) => channel / 255)
    : [0, 1, 2].map((channel) => blendChannel(mode, source[channel] / 255, dest[channel] / 255));
  const outA = srcA + dstA * (1 - srcA);
  return [0, 1, 2].map((channel) => clampByte(((blended[channel] * srcA + (dest[channel] / 255) * dstA * (1 - srcA)) / outA) * 255)).concat(clampByte(outA * 255));
}

function stampAt(buffer, stamp, cx, cy, color, coverage, options) {
  const [r, g, b, a] = parseColor(color);
  const angle = (options.angle || 0) * Math.PI / 180;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const halfW = (stamp.width - 1) / 2, halfH = (stamp.height - 1) / 2;
  const selection = options.selection;
  for (let sy = 0; sy < stamp.height; sy += 1) {
    for (let sx = 0; sx < stamp.width; sx += 1) {
      let tip = stamp.alpha[sy * stamp.width + sx] / 255;
      if (tip <= 0) continue;
      const dx = sx - halfW, dy = sy - halfH;
      const x = Math.round(cx + dx * cos - dy * sin);
      const y = Math.round(cy + dx * sin + dy * cos);
      if (x < 0 || y < 0 || x >= buffer.width || y >= buffer.height) continue;
      const offset = (y * buffer.width + x) * 4;
      if (selection) {
        const gate = selection.data[y * selection.width + x] / 255;
        if (gate <= 0) continue;
        tip *= gate;
      }
      const dest = [buffer.data[offset], buffer.data[offset + 1], buffer.data[offset + 2], buffer.data[offset + 3]];
      if (options.alphaLock && dest[3] === 0) continue;
      if (options.eraser) {
        const keep = 1 - tip * coverage * (a / 255);
        buffer.data[offset + 3] = clampByte(dest[3] * keep);
        continue;
      }
      let local = coverage * tip;
      if (options.alphaLock) local *= dest[3] / 255;
      const next = compositePixel(options.blendMode || 'normal', [r, g, b, a], dest, local);
      if (options.alphaLock) next[3] = dest[3];
      buffer.data[offset] = next[0];
      buffer.data[offset + 1] = next[1];
      buffer.data[offset + 2] = next[2];
      buffer.data[offset + 3] = next[3];
    }
  }
}

function strokeBounds(buffer, points, diameter) {
  if (!points.length) return { x: 0, y: 0, width: 0, height: 0 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const pad = diameter / 2 + 2;
  for (const point of points) {
    minX = Math.min(minX, point.x - pad);
    minY = Math.min(minY, point.y - pad);
    maxX = Math.max(maxX, point.x + pad);
    maxY = Math.max(maxY, point.y + pad);
  }
  return clipRect(buffer, { x: minX, y: minY, width: maxX - minX, height: maxY - minY });
}

export function applyStroke(buffer, points, brush = BASIC_ROUND_BRUSH, color = '#000000', options = {}) {
  const input = (points || []).map((point) => ({
    x: point.x, y: point.y,
    pressure: point.pointerType === 'mouse' || point.pressure === undefined ? (point.pressure > 0 && point.pressure !== 0.5 ? point.pressure : 1) : clamp01(point.pressure),
  }));
  if (!input.length) return null;
  const smoothed = smoothPoints(input, options.smoothing ?? brush.smoothing ?? 0);
  const curve = options.pressureCurve || 'linear';
  const random = mulberry32(options.seed ?? brush.seed ?? 1);
  const baseSize = Math.max(1, Math.min(500, brush.size || 16));
  const spacingRatio = Math.max(0.01, Math.min(2, (brush.spacing || 10) / 100));
  const samples = resample(smoothed, Math.max(0.75, baseSize * spacingRatio));
  const bounds = strokeBounds(buffer, samples, baseSize * 1.8 + (brush.scatter || 0));
  if (!bounds.width || !bounds.height) return null;
  const before = captureRect(buffer, bounds);
  let previous = samples[0];
  samples.forEach((point, index) => {
    const pressure = pressureCurve(point.pressure ?? 1, curve);
    const sizePressure = brush.pressureSize ? Math.max((brush.minDiameter || 1) / 100, pressure) : 1;
    const jitter = brush.sizeJitter ? 1 + (random() * 2 - 1) * (brush.sizeJitter / 100) : 1;
    const diameter = Math.max(1, Math.min(500, baseSize * sizePressure * jitter));
    const opacityPressure = brush.pressureOpacity ? pressure : 1;
    const flow = clamp01((brush.flow ?? 100) / 100) * clamp01((brush.opacity ?? 100) / 100) * opacityPressure * (options.flowScale ?? 1);
    let angle = brush.angle || 0;
    if (brush.followDirection && index > 0) angle = Math.atan2(point.y - previous.y, point.x - previous.x) * 180 / Math.PI;
    if (brush.angleJitter) angle += (random() * 2 - 1) * brush.angleJitter;
    let x = point.x, y = point.y;
    if (brush.scatter) {
      const distance = (random() * 2 - 1) * brush.scatter * diameter;
      const heading = (angle + 90) * Math.PI / 180;
      x += Math.cos(heading) * distance;
      y += Math.sin(heading) * distance;
    }
    stampAt(buffer, brushStamp(brush, diameter), x, y, color, flow, { ...options, angle });
    previous = point;
  });
  const after = captureRect(buffer, bounds);
  return { type: 'pixels', layerId: options.layerId || '', ...bounds, before: before.pixels, after: after.pixels };
}

export function eraseStroke(buffer, points, brush, options = {}) {
  return applyStroke(buffer, points, brush, '#000000', { ...options, eraser: true, eraserTip: options.eraserTip !== false });
}

function normalizeStrokePoint(point) {
  const mouse = point.pointerType === 'mouse' || point.pressure === undefined;
  const pressure = mouse ? (point.pressure > 0 && point.pressure !== 0.5 ? point.pressure : 1) : clamp01(point.pressure);
  return { x: point.x, y: point.y, pressure };
}

function unionRect(a, b) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.width, b.x + b.width);
  const bottom = Math.max(a.y + a.height, b.y + b.height);
  return { x, y, width: right - x, height: bottom - y };
}

function accumulateStrokeDirty(session, rect) {
  const bounds = clipRect(session.buffer, rect);
  if (!bounds.width || !bounds.height) return null;
  session.dirty = session.dirty ? unionRect(session.dirty, bounds) : bounds;
  return bounds;
}

function cropSnapshot(data, sourceWidth, bounds) {
  const pixels = new Uint8ClampedArray(bounds.width * bounds.height * 4);
  for (let y = 0; y < bounds.height; y += 1) {
    const from = ((bounds.y + y) * sourceWidth + bounds.x) * 4;
    pixels.set(data.subarray(from, from + bounds.width * 4), y * bounds.width * 4);
  }
  return pixels;
}

function placeStrokeSample(session, point, index, previous) {
  const brush = session.brush;
  const pressure = pressureCurve(point.pressure ?? 1, session.options.pressureCurve || 'linear');
  const sizePressure = brush.pressureSize ? Math.max((brush.minDiameter || 1) / 100, pressure) : 1;
  const jitter = brush.sizeJitter ? 1 + (session.random() * 2 - 1) * (brush.sizeJitter / 100) : 1;
  const diameter = Math.max(1, Math.min(500, (brush.size || 16) * sizePressure * jitter));
  const opacityPressure = brush.pressureOpacity ? pressure : 1;
  const flow = clamp01((brush.flow ?? 100) / 100) * clamp01((brush.opacity ?? 100) / 100) * opacityPressure * (session.options.flowScale ?? 1);
  let angle = brush.angle || 0;
  if (brush.followDirection && previous && index > 0) angle = Math.atan2(point.y - previous.y, point.x - previous.x) * 180 / Math.PI;
  if (brush.angleJitter) angle += (session.random() * 2 - 1) * brush.angleJitter;
  let x = point.x;
  let y = point.y;
  if (brush.scatter) {
    const distance = (session.random() * 2 - 1) * brush.scatter * diameter;
    const heading = (angle + 90) * Math.PI / 180;
    x += Math.cos(heading) * distance;
    y += Math.sin(heading) * distance;
  }
  const stamp = session.options.eraser && session.options.eraserTip === false
    ? brushStamp({ ...brush, stamp: null, kind: 'round' }, diameter)
    : brushStamp(brush, diameter);
  const pad = Math.hypot(stamp.width, stamp.height) / 2 + 3;
  const rect = { x: x - pad, y: y - pad, width: pad * 2, height: pad * 2 };
  accumulateStrokeDirty(session, rect);
  stampAt(session.buffer, stamp, x, y, session.color, flow, { ...session.options, angle, eraser: Boolean(session.options.eraser) });
  return clipRect(session.buffer, rect);
}

export function createStrokeSession(buffer, brush, color, options = {}) {
  return {
    buffer, brush, color, options,
    smoothed: null,
    carry: 0,
    previousSample: null,
    placed: null,
    sampleIndex: 0,
    random: mulberry32(options.seed ?? brush.seed ?? 1),
    dirty: null,
    beforeSnapshot: buffer?.data ? new Uint8ClampedArray(buffer.data) : null,
    lastDirty: null,
  };
}

export function strokeTo(session, point) {
  const input = normalizeStrokePoint(point);
  const amount = session.options.smoothing ?? session.brush.smoothing ?? 0;
  const keep = 1 - clamp01(amount / 100) * 0.9;
  const current = session.smoothed ? {
    ...input,
    x: session.smoothed.x + (input.x - session.smoothed.x) * keep,
    y: session.smoothed.y + (input.y - session.smoothed.y) * keep,
  } : input;
  session.smoothed = current;
  if (!session.previousSample) {
    session.previousSample = current;
    session.placed = current;
    session.lastDirty = placeStrokeSample(session, current, 0, current);
    session.sampleIndex = 1;
    return session.lastDirty;
  }
  const previous = session.previousSample;
  const length = Math.hypot(current.x - previous.x, current.y - previous.y);
  const spacingRatio = Math.max(0.01, Math.min(2, (session.brush.spacing || 10) / 100));
  const step = Math.max(0.75, Math.max(1, Math.min(500, session.brush.size || 16)) * spacingRatio);
  if (length) {
    let walked = step - session.carry;
    while (walked <= length) {
      const t = walked / length;
      const sample = {
        x: previous.x + (current.x - previous.x) * t,
        y: previous.y + (current.y - previous.y) * t,
        pressure: previous.pressure + (current.pressure - previous.pressure) * t,
      };
      session.lastDirty = placeStrokeSample(session, sample, session.sampleIndex, session.placed || previous);
      session.placed = sample;
      session.sampleIndex += 1;
      walked += step;
    }
    session.carry = length - (walked - step);
  }
  session.previousSample = current;
  return session.lastDirty;
}

export function finishStroke(session) {
  if (session.previousSample && session.placed) {
    const gap = Math.hypot(session.previousSample.x - session.placed.x, session.previousSample.y - session.placed.y);
    if (gap > 0.5) session.lastDirty = placeStrokeSample(session, session.previousSample, session.sampleIndex, session.placed);
  }
  const snapshot = session.beforeSnapshot;
  session.beforeSnapshot = null;
  if (!session.dirty || !snapshot) return null;
  const bounds = clipRect(session.buffer, session.dirty);
  if (!bounds.width || !bounds.height) return null;
  const after = captureRect(session.buffer, bounds);
  return {
    type: 'pixels', layerId: session.options.layerId || '', ...bounds,
    before: cropSnapshot(snapshot, session.buffer.width, bounds), after: after.pixels,
  };
}

export function selectionContains(selection, x, y) {
  if (!selection?.data) return false;
  const px = Math.round(x);
  const py = Math.round(y);
  if (px < 0 || py < 0 || px >= selection.width || py >= selection.height) return false;
  return selection.data[py * selection.width + px] >= 128;
}

export function opaqueBounds(buffer) {
  let minX = buffer.width;
  let minY = buffer.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < buffer.height; y += 1) {
    for (let x = 0; x < buffer.width; x += 1) {
      if (buffer.data[(y * buffer.width + x) * 4 + 3] < 8) continue;
      minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

export function clearBuffer(buffer) {
  const before = captureRect(buffer, { x: 0, y: 0, width: buffer.width, height: buffer.height });
  buffer.clear([0, 0, 0, 0]);
  const after = captureRect(buffer, before);
  return { type: 'pixels', ...before, before: before.pixels, after: after.pixels };
}

export function floodFill(buffer, x, y, color, { tolerance = 0, expand = 0, selection = null, reference = null, alphaLock = false } = {}) {
  const sample = reference || buffer;
  const sx = Math.round(x), sy = Math.round(y);
  if (sx < 0 || sy < 0 || sx >= sample.width || sy >= sample.height) return null;
  const origin = (sy * sample.width + sx) * 4;
  const target = [sample.data[origin], sample.data[origin + 1], sample.data[origin + 2], sample.data[origin + 3]];
  const maxDelta = Math.round(clamp01(tolerance / 100) * 255);
  const seen = new Uint8Array(sample.width * sample.height);
  const mask = new Uint8Array(sample.width * sample.height);
  const stack = [[sx, sy]];
  const matches = (px, py) => {
    const offset = (py * sample.width + px) * 4;
    return Math.max(
      Math.abs(sample.data[offset] - target[0]),
      Math.abs(sample.data[offset + 1] - target[1]),
      Math.abs(sample.data[offset + 2] - target[2]),
      Math.abs(sample.data[offset + 3] - target[3]),
    ) <= maxDelta;
  };
  while (stack.length) {
    let [px, py] = stack.pop();
    let left = px;
    while (left >= 0 && !seen[py * sample.width + left] && matches(left, py)) left -= 1;
    left += 1;
    let right = px + 1;
    while (right < sample.width && !seen[py * sample.width + right] && matches(right, py)) right += 1;
    let spanUp = false, spanDown = false;
    for (let fillX = left; fillX < right; fillX += 1) {
      const index = py * sample.width + fillX;
      seen[index] = 1;
      mask[index] = 1;
      if (py > 0) {
        const above = index - sample.width;
        if (!seen[above] && matches(fillX, py - 1)) { if (!spanUp) { stack.push([fillX, py - 1]); spanUp = true; } }
        else spanUp = false;
      }
      if (py + 1 < sample.height) {
        const below = index + sample.width;
        if (!seen[below] && matches(fillX, py + 1)) { if (!spanDown) { stack.push([fillX, py + 1]); spanDown = true; } }
        else spanDown = false;
      }
    }
  }
  const grow = Math.max(0, Math.min(3, Math.round(expand)));
  if (grow) dilateMask(mask, sample.width, sample.height, grow);
  const bounds = maskBounds(mask, buffer.width, buffer.height);
  if (!bounds) return null;
  const before = captureRect(buffer, bounds);
  const paint = parseColor(color);
  for (let py = bounds.y; py < bounds.y + bounds.height; py += 1) {
    for (let px = bounds.x; px < bounds.x + bounds.width; px += 1) {
      if (!mask[py * buffer.width + px]) continue;
      if (selection && selection.data[py * selection.width + px] < 128) continue;
      const offset = (py * buffer.width + px) * 4;
      if (alphaLock && buffer.data[offset + 3] === 0) continue;
      buffer.data[offset] = paint[0];
      buffer.data[offset + 1] = paint[1];
      buffer.data[offset + 2] = paint[2];
      buffer.data[offset + 3] = alphaLock ? buffer.data[offset + 3] : paint[3];
    }
  }
  const after = captureRect(buffer, bounds);
  return { type: 'pixels', ...bounds, before: before.pixels, after: after.pixels };
}

function dilateMask(mask, width, height, radius) {
  const source = mask.slice();
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!source[y * width + x]) continue;
      for (let dy = -radius; dy <= radius; dy += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          if (dx * dx + dy * dy > radius * radius) continue;
          const nx = x + dx, ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < width && ny < height) mask[ny * width + nx] = 1;
        }
      }
    }
  }
}

function maskBounds(mask, width, height) {
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!mask[y * width + x]) continue;
      minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

export function smudgeStroke(buffer, points, radius = 8, strength = 50, selection = null) {
  if (!points?.length) return null;
  const bounds = strokeBounds(buffer, points, radius * 2);
  const before = captureRect(buffer, bounds);
  let carry = null;
  const mix = clamp01(strength / 100);
  for (const point of points) {
    const sample = sampleDisc(buffer, point.x, point.y, radius);
    carry = carry ? carry.map((channel, index) => channel * (1 - mix) + sample[index] * mix) : sample;
    stampAt(buffer, createRoundStamp(Math.max(2, radius * 2), 40), point.x, point.y, carry, mix, { selection, alphaLock: false });
  }
  const after = captureRect(buffer, bounds);
  return { type: 'pixels', ...bounds, before: before.pixels, after: after.pixels };
}

function sampleDisc(buffer, cx, cy, radius) {
  let r = 0, g = 0, b = 0, a = 0, count = 0;
  const left = Math.max(0, Math.floor(cx - radius));
  const top = Math.max(0, Math.floor(cy - radius));
  const right = Math.min(buffer.width - 1, Math.ceil(cx + radius));
  const bottom = Math.min(buffer.height - 1, Math.ceil(cy + radius));
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      if (Math.hypot(x - cx, y - cy) > radius) continue;
      const offset = (y * buffer.width + x) * 4;
      r += buffer.data[offset]; g += buffer.data[offset + 1]; b += buffer.data[offset + 2]; a += buffer.data[offset + 3];
      count += 1;
    }
  }
  if (!count) return [0, 0, 0, 0];
  return [r / count, g / count, b / count, a / count];
}

export function sampleColor(buffer, x, y) {
  const px = Math.round(x), py = Math.round(y);
  if (px < 0 || py < 0 || px >= buffer.width || py >= buffer.height) return [0, 0, 0, 0];
  const offset = (py * buffer.width + px) * 4;
  return [buffer.data[offset], buffer.data[offset + 1], buffer.data[offset + 2], buffer.data[offset + 3]];
}

function finishSelection(width, height, data) {
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[y * width + x] < 8) continue;
      minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
  }
  const bounds = maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
  return { width, height, data, bounds };
}

export function rectSelection(width, height, x0, y0, x1, y1) {
  const data = new Uint8Array(width * height);
  const left = Math.max(0, Math.min(x0, x1));
  const right = Math.min(width - 1, Math.max(x0, x1));
  const top = Math.max(0, Math.min(y0, y1));
  const bottom = Math.min(height - 1, Math.max(y0, y1));
  for (let y = Math.ceil(top); y <= Math.floor(bottom); y += 1) {
    for (let x = Math.ceil(left); x <= Math.floor(right); x += 1) data[y * width + x] = 255;
  }
  return finishSelection(width, height, data);
}

export function ellipseSelection(width, height, x0, y0, x1, y1) {
  const data = new Uint8Array(width * height);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const rx = Math.max(0.5, Math.abs(x1 - x0) / 2), ry = Math.max(0.5, Math.abs(y1 - y0) / 2);
  const left = Math.max(0, Math.floor(cx - rx)), right = Math.min(width - 1, Math.ceil(cx + rx));
  const top = Math.max(0, Math.floor(cy - ry)), bottom = Math.min(height - 1, Math.ceil(cy + ry));
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      const nx = (x + 0.5 - cx) / rx, ny = (y + 0.5 - cy) / ry;
      if (nx * nx + ny * ny <= 1) data[y * width + x] = 255;
    }
  }
  return finishSelection(width, height, data);
}

export function lassoSelection(width, height, points) {
  const data = new Uint8Array(width * height);
  if (!points || points.length < 3) return finishSelection(width, height, data);
  let minX = width, minY = height, maxX = 0, maxY = 0;
  for (const point of points) {
    minX = Math.min(minX, point.x); minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x); maxY = Math.max(maxY, point.y);
  }
  const left = Math.max(0, Math.floor(minX)), right = Math.min(width - 1, Math.ceil(maxX));
  const top = Math.max(0, Math.floor(minY)), bottom = Math.min(height - 1, Math.ceil(maxY));
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) if (pointInPolygon(x + 0.5, y + 0.5, points)) data[y * width + x] = 255;
  }
  return finishSelection(width, height, data);
}

function pointInPolygon(x, y, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const xi = points[i].x, yi = points[i].y, xj = points[j].x, yj = points[j].y;
    const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-9) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

export function magicWandSelection(buffer, x, y, tolerance = 0) {
  const filled = new PaintBuffer(buffer.width, buffer.height);
  floodFill(filled, x, y, [255, 255, 255, 255], { tolerance, reference: buffer });
  const data = new Uint8Array(buffer.width * buffer.height);
  for (let index = 0; index < data.length; index += 1) data[index] = filled.data[index * 4 + 3] ? 255 : 0;
  return finishSelection(buffer.width, buffer.height, data);
}

export function combineSelection(current, next, mode = 'new') {
  if (!next) return current;
  if (!current || mode === 'new') return next;
  const data = new Uint8Array(current.data);
  for (let index = 0; index < data.length; index += 1) {
    if (mode === 'add') data[index] = Math.max(data[index], next.data[index] || 0);
    else if (mode === 'subtract' && (next.data[index] || 0) >= 128) data[index] = 0;
  }
  return finishSelection(current.width, current.height, data);
}

export function invertSelection(selection) {
  const data = new Uint8Array(selection.data.length);
  for (let index = 0; index < data.length; index += 1) data[index] = 255 - selection.data[index];
  return finishSelection(selection.width, selection.height, data);
}

export function offsetSelection(selection, dx, dy) {
  const data = new Uint8Array(selection.data.length);
  const shiftX = Math.round(dx), shiftY = Math.round(dy);
  for (let y = 0; y < selection.height; y += 1) {
    for (let x = 0; x < selection.width; x += 1) {
      const value = selection.data[y * selection.width + x];
      const nx = x + shiftX, ny = y + shiftY;
      if (value && nx >= 0 && ny >= 0 && nx < selection.width && ny < selection.height) data[ny * selection.width + nx] = value;
    }
  }
  return finishSelection(selection.width, selection.height, data);
}

export function featherSelection(selection, radius) {
  const amount = Math.max(0, Math.min(20, Math.round(radius)));
  if (!amount) return selection;
  let data = selection.data;
  for (let pass = 0; pass < 3; pass += 1) data = boxBlur(data, selection.width, selection.height, Math.max(1, Math.round(amount / 2)));
  return finishSelection(selection.width, selection.height, data);
}

function boxBlur(source, width, height, radius) {
  const horizontal = new Uint8Array(source.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let total = 0, count = 0;
      for (let dx = -radius; dx <= radius; dx += 1) {
        const nx = x + dx;
        if (nx < 0 || nx >= width) continue;
        total += source[y * width + nx]; count += 1;
      }
      horizontal[y * width + x] = clampByte(total / count);
    }
  }
  const vertical = new Uint8Array(source.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let total = 0, count = 0;
      for (let dy = -radius; dy <= radius; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        total += horizontal[ny * width + x]; count += 1;
      }
      vertical[y * width + x] = clampByte(total / count);
    }
  }
  return vertical;
}

export function growSelection(selection, radius) {
  const amount = Math.max(-10, Math.min(10, Math.round(radius)));
  if (!amount) return selection;
  const { width, height, data } = selection;
  const next = new Uint8Array(data.length);
  const rad = Math.abs(amount);
  if (amount > 0) {
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (data[y * width + x] < 128) continue;
        for (let dy = -rad; dy <= rad; dy += 1) {
          for (let dx = -rad; dx <= rad; dx += 1) {
            if (dx * dx + dy * dy > rad * rad) continue;
            const nx = x + dx, ny = y + dy;
            if (nx >= 0 && ny >= 0 && nx < width && ny < height) next[ny * width + nx] = 255;
          }
        }
      }
    }
  } else {
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        let keep = true;
        for (let dy = -rad; dy <= rad && keep; dy += 1) {
          for (let dx = -rad; dx <= rad; dx += 1) {
            if (dx * dx + dy * dy > rad * rad) continue;
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height || data[ny * width + nx] < 128) { keep = false; break; }
          }
        }
        if (keep) next[y * width + x] = 255;
      }
    }
  }
  return finishSelection(width, height, next);
}

export function moveSelectionPixels(buffer, selection, dx, dy) {
  if (!selection?.bounds) return { selection, entry: null };
  const shiftX = Math.round(dx), shiftY = Math.round(dy);
  const bounds = {
    x: Math.max(0, Math.min(selection.bounds.x, selection.bounds.x + shiftX) - 1),
    y: Math.max(0, Math.min(selection.bounds.y, selection.bounds.y + shiftY) - 1),
    width: selection.bounds.width + Math.abs(shiftX) + 2,
    height: selection.bounds.height + Math.abs(shiftY) + 2,
  };
  const clipped = clipRect(buffer, bounds);
  const before = captureRect(buffer, clipped);
  const moving = [];
  for (let y = 0; y < buffer.height; y += 1) {
    for (let x = 0; x < buffer.width; x += 1) {
      if (selection.data[y * buffer.width + x] < 128) continue;
      const offset = (y * buffer.width + x) * 4;
      moving.push([x, y, buffer.data[offset], buffer.data[offset + 1], buffer.data[offset + 2], buffer.data[offset + 3]]);
      buffer.data[offset + 3] = 0;
    }
  }
  for (const [x, y, r, g, b, a] of moving) {
    const nx = x + shiftX, ny = y + shiftY;
    if (nx < 0 || ny < 0 || nx >= buffer.width || ny >= buffer.height) continue;
    const offset = (ny * buffer.width + nx) * 4;
    buffer.data[offset] = r; buffer.data[offset + 1] = g; buffer.data[offset + 2] = b; buffer.data[offset + 3] = a;
  }
  const after = captureRect(buffer, clipped);
  return { selection: offsetSelection(selection, shiftX, shiftY), entry: { type: 'pixels', ...clipped, before: before.pixels, after: after.pixels } };
}

export function translateBuffer(buffer, dx, dy) {
  const next = new PaintBuffer(buffer.width, buffer.height);
  blit(next, buffer, Math.round(dx), Math.round(dy));
  buffer.data.set(next.data);
  return { type: 'pixels', x: 0, y: 0, width: buffer.width, height: buffer.height, before: null, after: null };
}

export function copySelection(buffer, selection) {
  if (!selection?.bounds) return null;
  const { x, y, width, height } = selection.bounds;
  const pixels = new Uint8ClampedArray(width * height * 4);
  const mask = new Uint8Array(width * height);
  for (let py = 0; py < height; py += 1) {
    for (let px = 0; px < width; px += 1) {
      const gate = selection.data[(y + py) * selection.width + (x + px)];
      if (gate < 128) continue;
      const from = ((y + py) * buffer.width + (x + px)) * 4;
      const to = (py * width + px) * 4;
      pixels.set(buffer.data.subarray(from, from + 4), to);
      mask[py * width + px] = 255;
    }
  }
  return { width, height, pixels, mask, originX: x, originY: y };
}

export function clearSelection(buffer, selection) {
  if (!selection?.bounds) return null;
  const before = captureRect(buffer, selection.bounds);
  for (let y = 0; y < buffer.height; y += 1) {
    for (let x = 0; x < buffer.width; x += 1) {
      if (selection.data[y * buffer.width + x] < 128) continue;
      buffer.data[(y * buffer.width + x) * 4 + 3] = 0;
    }
  }
  const after = captureRect(buffer, selection.bounds);
  return { type: 'pixels', ...selection.bounds, before: before.pixels, after: after.pixels };
}

export function fillColor(buffer, color, selection = null, alphaLock = false) {
  const bounds = selection?.bounds || { x: 0, y: 0, width: buffer.width, height: buffer.height };
  const before = captureRect(buffer, bounds);
  const paint = parseColor(color);
  let wrote = false;
  for (let y = bounds.y; y < bounds.y + bounds.height; y += 1) {
    for (let x = bounds.x; x < bounds.x + bounds.width; x += 1) {
      if (selection && selection.data[y * buffer.width + x] < 128) continue;
      const offset = (y * buffer.width + x) * 4;
      if (alphaLock && buffer.data[offset + 3] === 0) continue;
      buffer.data[offset] = paint[0];
      buffer.data[offset + 1] = paint[1];
      buffer.data[offset + 2] = paint[2];
      buffer.data[offset + 3] = alphaLock ? buffer.data[offset + 3] : paint[3];
      wrote = true;
    }
  }
  if (!wrote) return null;
  const after = captureRect(buffer, bounds);
  return { type: 'pixels', ...bounds, before: before.pixels, after: after.pixels };
}

export function constrainPoint(start, end, shape, shift) {
  if (!shift) return end;
  if (shape === 'line' || shape === 'arrow') {
    const dx = end.x - start.x, dy = end.y - start.y;
    const angle = Math.atan2(dy, dx);
    const snapped = Math.round(angle / (Math.PI / 4)) * (Math.PI / 4);
    const length = Math.hypot(dx, dy);
    return { x: start.x + Math.cos(snapped) * length, y: start.y + Math.sin(snapped) * length };
  }
  const size = Math.max(Math.abs(end.x - start.x), Math.abs(end.y - start.y));
  return { x: start.x + Math.sign(end.x - start.x || 1) * size, y: start.y + Math.sign(end.y - start.y || 1) * size };
}

export function rasterShape(buffer, shape, start, end, brush, color, options = {}) {
  const finish = constrainPoint(start, end, shape, options.shift);
  if (shape === 'line' || shape === 'arrow') {
    const points = sampleLine(start, finish, 1);
    if (shape === 'arrow') points.push(...arrowHead(start, finish));
    return applyStroke(buffer, points, { ...brush, spacing: 8, pressureSize: false }, color, options);
  }
  const filled = shape.endsWith('-fill');
  const ellipse = shape.startsWith('ellipse');
  const bounds = strokeBounds(buffer, [start, finish], brush.size || 8);
  const before = captureRect(buffer, bounds.width ? bounds : { x: 0, y: 0, width: 1, height: 1 });
  if (filled) fillShape(buffer, shape, start, finish, color, options);
  else strokeShape(buffer, ellipse ? 'ellipse' : 'rect', start, finish, brush, color, options);
  const after = captureRect(buffer, before);
  return { type: 'pixels', x: before.x, y: before.y, width: before.width, height: before.height, before: before.pixels, after: after.pixels, layerId: options.layerId || '' };
}

function sampleLine(start, end, step) {
  const length = Math.max(1, Math.hypot(end.x - start.x, end.y - start.y));
  const count = Math.ceil(length / step);
  const points = [];
  for (let index = 0; index <= count; index += 1) {
    const t = index / count;
    points.push({ x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t, pressure: 1 });
  }
  return points;
}

function arrowHead(start, end) {
  const angle = Math.atan2(end.y - start.y, end.x - start.x);
  const length = 14;
  return [1, -1].flatMap((side) => sampleLine(end, {
    x: end.x - Math.cos(angle + side * 0.45) * length,
    y: end.y - Math.sin(angle + side * 0.45) * length,
  }, 1));
}

function fillShape(buffer, shape, start, end, color, options) {
  const left = Math.min(start.x, end.x), right = Math.max(start.x, end.x);
  const top = Math.min(start.y, end.y), bottom = Math.max(start.y, end.y);
  const cx = (left + right) / 2, cy = (top + bottom) / 2;
  const rx = Math.max(0.5, (right - left) / 2), ry = Math.max(0.5, (bottom - top) / 2);
  const paint = parseColor(color);
  for (let y = Math.max(0, Math.floor(top)); y <= Math.min(buffer.height - 1, Math.ceil(bottom)); y += 1) {
    for (let x = Math.max(0, Math.floor(left)); x <= Math.min(buffer.width - 1, Math.ceil(right)); x += 1) {
      if (shape.startsWith('ellipse')) {
        const nx = (x + 0.5 - cx) / rx, ny = (y + 0.5 - cy) / ry;
        if (nx * nx + ny * ny > 1) continue;
      }
      if (options.selection && options.selection.data[y * buffer.width + x] < 128) continue;
      const offset = (y * buffer.width + x) * 4;
      if (options.alphaLock && buffer.data[offset + 3] === 0) continue;
      buffer.data[offset] = paint[0]; buffer.data[offset + 1] = paint[1]; buffer.data[offset + 2] = paint[2];
      buffer.data[offset + 3] = options.alphaLock ? buffer.data[offset + 3] : paint[3];
    }
  }
}

function strokeShape(buffer, shape, start, end, brush, color, options) {
  const left = Math.min(start.x, end.x), right = Math.max(start.x, end.x);
  const top = Math.min(start.y, end.y), bottom = Math.max(start.y, end.y);
  const corners = shape === 'rect'
    ? [[{ x: left, y: top }, { x: right, y: top }], [{ x: right, y: top }, { x: right, y: bottom }], [{ x: right, y: bottom }, { x: left, y: bottom }], [{ x: left, y: bottom }, { x: left, y: top }]]
    : [];
  if (shape === 'rect') {
    for (const [a, b] of corners) applyStroke(buffer, sampleLine(a, b, 1), { ...brush, spacing: 8, pressureSize: false }, color, options);
    return;
  }
  const cx = (left + right) / 2, cy = (top + bottom) / 2;
  const rx = Math.max(1, (right - left) / 2), ry = Math.max(1, (bottom - top) / 2);
  const points = [];
  const steps = Math.max(12, Math.round((rx + ry) / 2));
  for (let index = 0; index <= steps; index += 1) {
    const t = index / steps * Math.PI * 2;
    points.push({ x: cx + Math.cos(t) * rx, y: cy + Math.sin(t) * ry, pressure: 1 });
  }
  applyStroke(buffer, points, { ...brush, spacing: 8, pressureSize: false }, color, options);
}

export function transformBuffer(buffer, selection, { dx = 0, dy = 0, scaleX = 1, scaleY = 1, rotation = 0, flipH = false, flipV = false } = {}) {
  const region = selection?.bounds || { x: 0, y: 0, width: buffer.width, height: buffer.height };
  const source = buffer.clone();
  const before = captureRect(buffer, { x: 0, y: 0, width: buffer.width, height: buffer.height });
  if (selection) clearSelection(buffer, selection);
  else buffer.clear([0, 0, 0, 0]);
  const cx = region.x + region.width / 2 + dx;
  const cy = region.y + region.height / 2 + dy;
  const theta = rotation * Math.PI / 180;
  const cos = Math.cos(theta), sin = Math.sin(theta);
  const sx = (flipH ? -1 : 1) * (scaleX || 1);
  const sy = (flipV ? -1 : 1) * (scaleY || 1);
  for (let y = 0; y < buffer.height; y += 1) {
    for (let x = 0; x < buffer.width; x += 1) {
      const dxp = x + 0.5 - cx, dyp = y + 0.5 - cy;
      const rx = dxp * cos + dyp * sin;
      const ry = -dxp * sin + dyp * cos;
      const srcX = rx / sx + region.x + region.width / 2;
      const srcY = ry / sy + region.y + region.height / 2;
      const px = Math.round(srcX - 0.5), py = Math.round(srcY - 0.5);
      if (px < region.x || py < region.y || px >= region.x + region.width || py >= region.y + region.height) continue;
      if (selection && selection.data[py * selection.width + px] < 128) continue;
      const from = (py * source.width + px) * 4;
      const to = (y * buffer.width + x) * 4;
      if (source.data[from + 3] === 0) continue;
      buffer.data[to] = source.data[from];
      buffer.data[to + 1] = source.data[from + 1];
      buffer.data[to + 2] = source.data[from + 2];
      buffer.data[to + 3] = source.data[from + 3];
    }
  }
  const after = captureRect(buffer, { x: 0, y: 0, width: buffer.width, height: buffer.height });
  return { type: 'pixels', x: 0, y: 0, width: buffer.width, height: buffer.height, before: before.pixels, after: after.pixels };
}

export function tintBuffer(buffer, color) {
  const [r, g, b] = parseColor(color);
  const before = captureRect(buffer, { x: 0, y: 0, width: buffer.width, height: buffer.height });
  for (let index = 0; index < buffer.data.length; index += 4) {
    if (!buffer.data[index + 3]) continue;
    buffer.data[index] = r; buffer.data[index + 1] = g; buffer.data[index + 2] = b;
  }
  const after = captureRect(buffer, before);
  return { type: 'pixels', ...before, before: before.pixels, after: after.pixels, pixels: buffer };
}

function clipBaseIndex(layers, index) {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) if (!layers[cursor].clippingMask) return cursor;
  return -1;
}

export function compositeLayers(width, height, layers, buffers, { includeHidden = false } = {}) {
  const output = new PaintBuffer(width, height);
  layers.forEach((layer, index) => {
    if (!includeHidden && layer.visible === false) return;
    if ((layer.opacity ?? 100) <= 0) return;
    const source = buffers.get(layer.id);
    if (!source) return;
    let pixels = source;
    if (layer.clippingMask) {
      const baseIndex = clipBaseIndex(layers, index);
      const base = baseIndex >= 0 ? buffers.get(layers[baseIndex].id) : null;
      if (!base) return;
      pixels = maskByAlpha(source, base);
    }
    blendBuffer(output, pixels, normalizeBlend(layer.blendMode), (layer.opacity ?? 100) / 100);
  });
  return output;
}

function normalizeBlend(mode) {
  return LAYER_BLEND_MODES.includes(mode) ? mode : 'normal';
}

function maskByAlpha(source, base) {
  const next = source.clone();
  const length = Math.min(source.data.length, base.data.length);
  for (let index = 0; index < length; index += 4) next.data[index + 3] = clampByte(source.data[index + 3] * (base.data[index + 3] / 255));
  return next;
}

function blendBuffer(dest, source, mode, opacity) {
  const width = Math.min(dest.width, source.width);
  const height = Math.min(dest.height, source.height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const to = (y * dest.width + x) * 4;
      const from = (y * source.width + x) * 4;
      const next = compositePixel(mode, source.data.subarray(from, from + 4), dest.data.subarray(to, to + 4), opacity);
      dest.data[to] = next[0]; dest.data[to + 1] = next[1]; dest.data[to + 2] = next[2]; dest.data[to + 3] = next[3];
    }
  }
}

export function paperBuffer(paper) {
  const buffer = new PaintBuffer(paper.width, paper.height, PAPER_COLORS[paper.background] || PAPER_COLORS.transparent);
  if (paper.texture && paper.texture !== 'none' && paper.textureInOutput) applyTexture(buffer, paper.texture, paper.textureOpacity);
  return buffer;
}

export function applyTexture(buffer, texture, opacity = 20) {
  const amount = clamp01(opacity / 100);
  for (let y = 0; y < buffer.height; y += 1) {
    for (let x = 0; x < buffer.width; x += 1) {
      const grain = texture === 'watercolor'
        ? hash2(Math.floor(x / 6), Math.floor(y / 6))
        : (hash2(x, y) * 0.65 + hash2(x * 0.25, y) * 0.35);
      const offset = (y * buffer.width + x) * 4;
      const shade = 1 - amount * (0.35 + grain * 0.4);
      buffer.data[offset] = clampByte(buffer.data[offset] * shade);
      buffer.data[offset + 1] = clampByte(buffer.data[offset + 1] * shade);
      buffer.data[offset + 2] = clampByte(buffer.data[offset + 2] * shade);
    }
  }
}

function hash2(x, y) {
  const value = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return value - Math.floor(value);
}

export function toMask(buffer) {
  const mask = new PaintBuffer(buffer.width, buffer.height, [0, 0, 0, 255]);
  for (let index = 0; index < buffer.data.length; index += 4) {
    const on = buffer.data[index + 3] > 8;
    const value = on ? 255 : 0;
    mask.data[index] = value; mask.data[index + 1] = value; mask.data[index + 2] = value; mask.data[index + 3] = 255;
  }
  return mask;
}

export function exportPaint(data, buffers, { base = null } = {}) {
  const doc = normalizePaintData(data);
  const paint = compositeLayers(doc.paper.width, doc.paper.height, doc.layers, buffers);
  if (doc.outputMode === 'mask') return toMask(paint);
  if (doc.outputMode === 'transparent') return paint;
  const output = paperBuffer(doc.paper);
  if (base && doc.baseOverlay.visible) blendBuffer(output, fitBuffer(base, doc.paper.width, doc.paper.height), 'normal', doc.baseOverlay.opacity / 100);
  blendBuffer(output, paint, 'normal', 1);
  return output;
}

let fittedBaseCache = new WeakMap();
let fitCacheHits = 0;
let fitCacheMisses = 0;

export function previewFitCacheStats() {
  return { hits: fitCacheHits, misses: fitCacheMisses };
}

export function resetPreviewFitCache() {
  fittedBaseCache = new WeakMap();
  fitCacheHits = 0;
  fitCacheMisses = 0;
}

function fittedBase(base, width, height) {
  if (!base) return null;
  const cached = fittedBaseCache.get(base);
  if (cached && cached.width === width && cached.height === height) {
    fitCacheHits += 1;
    return cached.buffer;
  }
  fitCacheMisses += 1;
  const buffer = fitBuffer(base, width, height);
  fittedBaseCache.set(base, { width, height, buffer });
  return buffer;
}

function fitBuffer(source, width, height) {
  if (source.width === width && source.height === height) return source;
  const next = new PaintBuffer(width, height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sx = Math.min(source.width - 1, Math.floor(x * source.width / width));
      const sy = Math.min(source.height - 1, Math.floor(y * source.height / height));
      const from = (sy * source.width + sx) * 4;
      const to = (y * width + x) * 4;
      next.data.set(source.data.subarray(from, from + 4), to);
    }
  }
  return next;
}

export function mergeDown(doc, buffers) {
  const index = doc.layers.findIndex((layer) => layer.id === doc.activeLayerId);
  if (index <= 0) return { doc, buffers, error: '没有可合并的下方图层。' };
  const upper = doc.layers[index];
  const lower = doc.layers[index - 1];
  const baked = new PaintBuffer(doc.paper.width, doc.paper.height);
  blendBuffer(baked, buffers.get(lower.id) || baked, 'normal', (lower.opacity ?? 100) / 100);
  let upperBuffer = buffers.get(upper.id) || new PaintBuffer(doc.paper.width, doc.paper.height);
  if (upper.clippingMask) upperBuffer = maskByAlpha(upperBuffer, baked);
  blendBuffer(baked, upperBuffer, normalizeBlend(upper.blendMode), (upper.opacity ?? 100) / 100);
  const nextBuffers = new Map(buffers);
  nextBuffers.set(lower.id, baked);
  nextBuffers.delete(upper.id);
  const layers = doc.layers.filter((layer) => layer.id !== upper.id).map((layer) => layer.id === lower.id ? { ...layer, opacity: 100, blendMode: 'normal', clippingMask: false } : layer);
  return { doc: { ...doc, layers, activeLayerId: lower.id }, buffers: nextBuffers };
}

export function stampVisible(doc, buffers) {
  if (doc.layers.length >= 12) return { doc, buffers, error: '已达单节点 12 层上限，请向下合并图层或新建下一个绘画节点继续' };
  const flat = compositeLayers(doc.paper.width, doc.paper.height, doc.layers, buffers);
  const id = `layer-stamp-${doc.layers.length + 1}`;
  const layer = { id, name: '盖印可见', visible: true, opacity: 100, blendMode: 'normal', alphaLock: false, clippingMask: false, assetPath: '', url: '' };
  const nextBuffers = new Map(buffers);
  nextBuffers.set(id, flat);
  return { doc: { ...doc, layers: [...doc.layers, layer], activeLayerId: id }, buffers: nextBuffers };
}

export function previewComposite(doc, buffers, { base = null, guides = false } = {}) {
  const output = new PaintBuffer(doc.paper.width, doc.paper.height, PAPER_COLORS[doc.paper.background] || PAPER_COLORS.transparent);
  if (doc.paper.texture && doc.paper.texture !== 'none') applyTexture(output, doc.paper.texture, doc.paper.textureOpacity);
  const paint = compositeLayers(doc.paper.width, doc.paper.height, doc.layers, buffers);
  const fitted = base && doc.baseOverlay.visible ? fittedBase(base, doc.paper.width, doc.paper.height) : null;
  if (fitted && doc.baseOverlay.position !== 'above') blendBuffer(output, fitted, 'normal', doc.baseOverlay.opacity / 100);
  if (doc.outputMode === 'mask') {
    const mask = toMask(paint);
    const tint = parseColor(doc.maskOverlayColor || 'rgba(255,48,56,0.5)');
    for (let index = 0; index < mask.data.length; index += 4) {
      if (mask.data[index] < 128) continue;
      const next = compositePixel('normal', tint, output.data.subarray(index, index + 4), tint[3] / 255);
      output.data.set(next, index);
    }
  } else blendBuffer(output, paint, 'normal', 1);
  if (fitted && doc.baseOverlay.position === 'above') blendBuffer(output, fitted, 'normal', doc.baseOverlay.opacity / 100);
  if (guides) drawGuides(output, doc.paper.guideGrid);
  return output;
}

function pixelAt(buffer, x, y) {
  const offset = (y * buffer.width + x) * 4;
  return [buffer.data[offset], buffer.data[offset + 1], buffer.data[offset + 2], buffer.data[offset + 3]];
}

function shadePixel(pixel, x, y, texture, opacity) {
  const amount = clamp01((opacity ?? 0) / 100);
  if (!amount || !texture || texture === 'none') return pixel;
  const grain = texture === 'watercolor'
    ? hash2(Math.floor(x / 6), Math.floor(y / 6))
    : (hash2(x, y) * 0.65 + hash2(x * 0.25, y) * 0.35);
  const shade = 1 - amount * (0.35 + grain * 0.4);
  return [clampByte(pixel[0] * shade), clampByte(pixel[1] * shade), clampByte(pixel[2] * shade), pixel[3]];
}

function guideLines(grid, width, height) {
  if (!grid || grid === 'none') return [];
  const vertical = grid === 'thirds' || grid === 'story-3x2' ? 3 : grid === 'story-2x2' ? 2 : 4;
  const horizontal = grid === 'thirds' ? 3 : grid === 'story-3x2' ? 2 : grid === 'story-2x2' ? 2 : 4;
  const lines = [];
  for (let index = 1; index < vertical; index += 1) lines.push(['v', Math.round(width * index / vertical)]);
  for (let index = 1; index < horizontal; index += 1) lines.push(['h', Math.round(height * index / horizontal)]);
  return lines;
}

export function previewRect(doc, buffers, rect, { base = null, guides = false } = {}) {
  const width = doc.paper.width;
  const height = doc.paper.height;
  if (doc.outputMode === 'mask') {
    const full = previewComposite(doc, buffers, { base, guides });
    const bounds = clipRect(full, rect || { x: 0, y: 0, width, height });
    return captureRect(full, bounds);
  }
  const bounds = clipRect({ width, height }, rect || { x: 0, y: 0, width, height });
  const pixels = new Uint8ClampedArray(Math.max(1, bounds.width) * Math.max(1, bounds.height) * 4);
  if (!bounds.width || !bounds.height) return { ...bounds, pixels };
  const paper = (PAPER_COLORS[doc.paper.background] || PAPER_COLORS.transparent).slice();
  const fitted = base ? fittedBase(base, width, height) : null;
  const lines = guides ? guideLines(doc.paper.guideGrid, width, height) : [];
  const layers = doc.layers || [];
  for (let y = 0; y < bounds.height; y += 1) {
    for (let x = 0; x < bounds.width; x += 1) {
      const px = bounds.x + x;
      const py = bounds.y + y;
      let dest = shadePixel(paper, px, py, doc.paper.texture, doc.paper.textureOpacity);
      if (fitted && doc.baseOverlay?.visible && doc.baseOverlay.position !== 'above') {
        dest = compositePixel('normal', pixelAt(fitted, px, py), dest, (doc.baseOverlay.opacity ?? 100) / 100);
      }
      layers.forEach((layer, index) => {
        if (layer.visible === false || (layer.opacity ?? 100) <= 0) return;
        const source = buffers.get(layer.id);
        if (!source) return;
        let sample = pixelAt(source, px, py);
        if (layer.clippingMask) {
          const baseIndex = clipBaseIndex(layers, index);
          const baseBuffer = baseIndex >= 0 ? buffers.get(layers[baseIndex].id) : null;
          if (!baseBuffer) return;
          sample = sample.slice();
          sample[3] = clampByte(sample[3] * (pixelAt(baseBuffer, px, py)[3] / 255));
        }
        dest = compositePixel(normalizeBlend(layer.blendMode), sample, dest, (layer.opacity ?? 100) / 100);
      });
      if (fitted && doc.baseOverlay?.visible && doc.baseOverlay.position === 'above') {
        dest = compositePixel('normal', pixelAt(fitted, px, py), dest, (doc.baseOverlay.opacity ?? 100) / 100);
      }
      if (lines.some(([axis, at]) => (axis === 'v' ? px === at : py === at))) dest = [230, 210, 140, 180];
      const offset = (y * bounds.width + x) * 4;
      pixels[offset] = dest[0]; pixels[offset + 1] = dest[1]; pixels[offset + 2] = dest[2]; pixels[offset + 3] = dest[3];
    }
  }
  return { ...bounds, pixels };
}

function drawGuides(buffer, grid) {
  if (!grid || grid === 'none') return;
  const vertical = grid === 'thirds' || grid === 'story-3x2' ? 3 : grid === 'story-2x2' ? 2 : 4;
  const horizontal = grid === 'thirds' ? 3 : grid === 'story-3x2' ? 2 : grid === 'story-2x2' ? 2 : 4;
  const paint = (x, y) => {
    if (x < 0 || y < 0 || x >= buffer.width || y >= buffer.height) return;
    const offset = (y * buffer.width + x) * 4;
    buffer.data[offset] = 230; buffer.data[offset + 1] = 210; buffer.data[offset + 2] = 140; buffer.data[offset + 3] = 180;
  };
  for (let index = 1; index < vertical; index += 1) {
    const x = Math.round(buffer.width * index / vertical);
    for (let y = 0; y < buffer.height; y += 1) paint(x, y);
  }
  for (let index = 1; index < horizontal; index += 1) {
    const y = Math.round(buffer.height * index / horizontal);
    for (let x = 0; x < buffer.width; x += 1) paint(x, y);
  }
}

export function selectionOutline(selection) {
  if (!selection?.bounds) return [];
  const points = [];
  const { width, height, data } = selection;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[y * width + x] < 128) continue;
      const edge = x === 0 || y === 0 || x === width - 1 || y === height - 1
        || data[y * width + x - 1] < 128 || data[y * width + x + 1] < 128
        || data[(y - 1) * width + x] < 128 || data[(y + 1) * width + x] < 128;
      if (edge) points.push([x, y]);
    }
  }
  return points;
}
