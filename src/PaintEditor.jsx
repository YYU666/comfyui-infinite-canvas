import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  LAYER_LIMIT_MESSAGE, OUTPUT_MODES, OUTPUT_MODE_LABELS, PAPER_PRESETS, BACKGROUNDS, TEXTURES, GUIDES,
  addLayer, deleteLayer, duplicateLayer, moveLayer, patchLayer, renameLayer, createHistory, pushHistory,
  undoHistory, redoHistory, initialPaperForBase, normalizePaintData,
} from './paint-document.js';
import {
  BASIC_ROUND_BRUSH, PaintBuffer, applyStroke, eraseStroke, floodFill, smudgeStroke, previewComposite,
  rectSelection, ellipseSelection, lassoSelection, magicWandSelection, combineSelection, invertSelection,
  fillColor, clearSelection, copySelection, moveSelectionPixels, translateBuffer, selectionOutline,
  captureRect, restoreRect, resizeBuffers, createBuffers, compositeLayers, exportPaint, toMask,
  mergeDown, stampVisible, tintBuffer, hsvToRgb, rgbToHsv, colorToHex, parseColor, constrainPoint, rasterShape,
  transformBuffer, sampleColor, featherSelection, growSelection,
} from './paint-engine.js';

const TOOLS = [
  ['brush', '画笔', 'B'], ['eraser', '橡皮', 'E'], ['picker', '吸管', 'I'], ['smudge', '涂抹', 'S'],
  ['bucket', '油漆桶', 'G'], ['geometry', '几何', 'U'], ['select-rect', '矩形选区', 'M'],
  ['select-ellipse', '椭圆选区', ''], ['select-lasso', '套索', 'L'], ['select-wand', '魔棒', 'W'], ['move', '移动', 'V'],
];

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('图片读取失败'));
    image.src = url;
  });
}

async function imageToBuffer(url) {
  const image = await loadImage(url);
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(image, 0, 0);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  const buffer = new PaintBuffer(canvas.width, canvas.height);
  buffer.data.set(pixels.data);
  return buffer;
}

export function bufferToPngBlob(buffer) {
  const canvas = document.createElement('canvas');
  canvas.width = buffer.width;
  canvas.height = buffer.height;
  canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(buffer.data), buffer.width, buffer.height), 0, 0);
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('PNG 编码失败')), 'image/png'));
}

function paintPoint(event, canvas, flip) {
  const rect = canvas.getBoundingClientRect();
  let x = (event.clientX - rect.left) * canvas.width / rect.width;
  const y = (event.clientY - rect.top) * canvas.height / rect.height;
  if (flip) x = canvas.width - x;
  const pressure = event.pointerType === 'pen' ? (event.pressure || 0) : (event.pressure > 0 && event.pressure < 1 ? event.pressure : 1);
  return { x, y, pressure: event.pointerType === 'mouse' ? 1 : pressure, pointerType: event.pointerType || 'mouse', tiltX: event.tiltX || 0, tiltY: event.tiltY || 0 };
}

export default function PaintEditor({ node, baseImage, swatches = [], onClose, onSave, onExtract, readOnly = false }) {
  const initial = normalizePaintData(node.data);
  const [doc, setDoc] = useState(initial);
  const [tool, setTool] = useState('brush');
  const [shape, setShape] = useState('line');
  const [brush, setBrush] = useState({ ...BASIC_ROUND_BRUSH });
  const [color, setColor] = useState('#111111');
  const [background, setBackground] = useState('#ffffff');
  const [selection, setSelection] = useState(null);
  const [selectionMode, setSelectionMode] = useState('new');
  const [message, setMessage] = useState('');
  const [palmReject, setPalmReject] = useState(false);
  const [pressureCurve, setPressureCurve] = useState('linear');
  const [sampleAll, setSampleAll] = useState(true);
  const [bucketAll, setBucketAll] = useState(false);
  const [tolerance, setTolerance] = useState(12);
  const [expand, setExpand] = useState(1);
  const [feather, setFeather] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 40, y: 40 });
  const [rotation, setRotation] = useState(0);
  const [flip, setFlip] = useState(false);
  const [saving, setSaving] = useState(false);
  const [ink, setInk] = useState(0);
  const canvasRef = useRef(null);
  const dialogRef = useRef(null);
  const buffersRef = useRef(createBuffers(initial));
  const historyRef = useRef(createHistory());
  const docRef = useRef(initial);
  const selectionRef = useRef(null);
  const drawRef = useRef(null);
  const spaceRef = useRef(false);
  const altRef = useRef(false);
  const clipRef = useRef(null);
  const baseRef = useRef(null);
  const pointersRef = useRef(new Map());
  const colorRef = useRef(color);
  const brushRef = useRef(brush);
  const toolRef = useRef(tool);
  const bootRef = useRef(initial);

  useEffect(() => { docRef.current = doc; }, [doc]);
  useEffect(() => { selectionRef.current = selection; }, [selection]);
  useEffect(() => { colorRef.current = color; }, [color]);
  useEffect(() => { brushRef.current = brush; }, [brush]);
  useEffect(() => { toolRef.current = tool; }, [tool]);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const current = docRef.current;
    if (!canvas) return;
    canvas.width = current.paper.width;
    canvas.height = current.paper.height;
    const preview = previewComposite(current, buffersRef.current, { base: baseRef.current, guides: true });
    const context = canvas.getContext('2d');
    context.putImageData(new ImageData(new Uint8ClampedArray(preview.data), preview.width, preview.height), 0, 0);
    const outline = selectionOutline(selectionRef.current);
    if (outline.length) {
      context.save();
      context.fillStyle = '#f4f1e8';
      for (const [x, y] of outline) if (((x + y) % 8) < 4) context.fillRect(x, y, 1, 1);
      context.restore();
    }
    const active = buffersRef.current.get(current.activeLayerId);
    if (active) {
      let count = 0;
      for (let index = 3; index < active.data.length; index += 16) if (active.data[index]) count += 1;
      setInk(count);
    }
  }, []);

  useEffect(() => {
    let cancel = false;
    (async () => {
      try {
        if (baseImage?.url) baseRef.current = await imageToBuffer(baseImage.url);
        const boot = bootRef.current;
        if (!cancel && !boot.touched && baseRef.current) {
          const paper = initialPaperForBase(boot, baseRef.current);
          if (paper.width !== boot.paper.width || paper.height !== boot.paper.height) {
            const next = { ...boot, paper };
            buffersRef.current = resizeBuffers(buffersRef.current, next, paper.width, paper.height);
            docRef.current = next;
            setDoc(next);
          }
        }
        for (const layer of boot.layers) {
          if (!layer.url) continue;
          const loaded = await imageToBuffer(layer.url);
          const target = buffersRef.current.get(layer.id);
          if (target) {
            target.clear([0, 0, 0, 0]);
            for (let y = 0; y < Math.min(target.height, loaded.height); y += 1) {
              target.data.set(loaded.data.subarray(y * loaded.width * 4, y * loaded.width * 4 + Math.min(target.width, loaded.width) * 4), y * target.width * 4);
            }
          }
        }
      } catch (error) {
        if (!cancel) setMessage(error.message);
      }
      if (!cancel) redraw();
    })();
    return () => { cancel = true; };
  }, [baseImage?.url, redraw]);

  useEffect(() => { redraw(); }, [doc, selection, redraw]);

  const commitPixels = (entry) => {
    if (!entry || !entry.width) return;
    pushHistory(historyRef.current, { ...entry, layerId: entry.layerId || docRef.current.activeLayerId });
    setDoc((current) => ({ ...current, touched: true }));
    redraw();
  };

  const replaceDoc = (next, bufferPatch) => {
    const beforeDoc = docRef.current;
    const beforeBuffers = new Map();
    if (bufferPatch) for (const [id, buffer] of bufferPatch) beforeBuffers.set(id, buffersRef.current.get(id)?.clone() || null);
    pushHistory(historyRef.current, { type: 'doc', beforeDoc, afterDoc: next, bufferPatch, beforeBuffers });
    if (bufferPatch) for (const [id, buffer] of bufferPatch) {
      if (buffer) buffersRef.current.set(id, buffer);
      else buffersRef.current.delete(id);
    }
    docRef.current = next;
    setDoc(next);
    redraw();
  };

  const undo = () => {
    const entry = undoHistory(historyRef.current);
    if (!entry) return;
    if (entry.type === 'doc') {
      if (entry.bufferPatch) {
        for (const id of entry.bufferPatch.keys()) buffersRef.current.delete(id);
        for (const [id, buffer] of entry.beforeBuffers) if (buffer) buffersRef.current.set(id, buffer);
      }
      docRef.current = entry.beforeDoc;
      setDoc(entry.beforeDoc);
    } else {
      const buffer = buffersRef.current.get(entry.layerId);
      if (buffer) restoreRect(buffer, { ...entry, pixels: entry.before });
    }
    redraw();
  };
  const redo = () => {
    const entry = redoHistory(historyRef.current);
    if (!entry) return;
    if (entry.type === 'doc') {
      if (entry.bufferPatch) for (const [id, buffer] of entry.bufferPatch) {
        if (buffer) buffersRef.current.set(id, buffer);
        else buffersRef.current.delete(id);
      }
      docRef.current = entry.afterDoc;
      setDoc(entry.afterDoc);
    } else {
      const buffer = buffersRef.current.get(entry.layerId);
      if (buffer) restoreRect(buffer, { ...entry, pixels: entry.after });
    }
    redraw();
  };

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const previousFocus = document.activeElement;
    document.body.style.overflow = 'hidden';
    dialogRef.current?.focus();
    const onKeyDown = (event) => {
      event.stopPropagation();
      const typing = event.target instanceof Element && event.target.closest('input, textarea, select');
      if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
      if (event.code === 'Space') { spaceRef.current = true; event.preventDefault(); }
      if (event.key === 'Alt') altRef.current = true;
      if (typing) return;
      const key = event.key.toLowerCase();
      const command = event.ctrlKey || event.metaKey;
      if (['delete', 'backspace'].includes(key) && !command) {
        event.preventDefault();
        if (key === 'delete' && selectionRef.current) commitPixels(clearSelection(activeBuffer(), selectionRef.current));
        return;
      }
      if (command && key === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo(); return; }
      if (command && (key === 'y' || (event.shiftKey && key === 'z'))) { event.preventDefault(); redo(); return; }
      if (command && ['c', 'x', 'v', 'd', 'a', 't'].includes(key)) event.preventDefault();
      if (command && event.shiftKey && key === 'i') { event.preventDefault(); if (selectionRef.current) setSelection(invertSelection(selectionRef.current)); return; }
      if (command && key === 'a') { setSelection(rectSelection(docRef.current.paper.width, docRef.current.paper.height, 0, 0, docRef.current.paper.width - 1, docRef.current.paper.height - 1)); return; }
      if (command && key === 'd') { setSelection(null); return; }
      if (command && key === 'c') { clipRef.current = copySelection(activeBuffer(), selectionRef.current); return; }
      if (command && key === 'x') {
        clipRef.current = copySelection(activeBuffer(), selectionRef.current);
        commitPixels(clearSelection(activeBuffer(), selectionRef.current));
        return;
      }
      if (command && key === 'v') { pasteClipboard(); return; }
      if (event.altKey && key === 'delete') { event.preventDefault(); commitPixels(fillColor(activeBuffer(), colorRef.current, selectionRef.current, activeLayer().alphaLock)); return; }
      if (command && key === 'delete') { event.preventDefault(); commitPixels(fillColor(activeBuffer(), background, selectionRef.current, activeLayer().alphaLock)); return; }
      if (key === 'x' && !command) { const next = colorRef.current; setColor(background); setBackground(next); return; }
      if (key === 'd' && !command) { setColor('#000000'); setBackground('#ffffff'); return; }
      if (key === 'h' && !command) { setFlip((value) => !value); return; }
      if (key === '[') setBrush((value) => ({ ...value, size: Math.max(1, value.size - 1) }));
      if (key === ']') setBrush((value) => ({ ...value, size: Math.min(500, value.size + 1) }));
      const shortcut = { b: 'brush', e: 'eraser', i: 'picker', s: 'smudge', g: 'bucket', u: 'geometry', m: 'select-rect', l: 'select-lasso', w: 'select-wand', v: 'move' }[key];
      if (shortcut && !command) setTool(shortcut);
      if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(event.key.toLowerCase())) {
        event.preventDefault();
        const step = event.shiftKey ? 10 : 1;
        const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
        const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
        nudge(dx, dy);
      }
    };
    const onKeyUp = (event) => {
      event.stopPropagation();
      if (event.code === 'Space') spaceRef.current = false;
      if (event.key === 'Alt') altRef.current = false;
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      previousFocus?.focus?.();
    };
  }, [background, onClose, redraw]);

  function activeBuffer() {
    return buffersRef.current.get(docRef.current.activeLayerId);
  }
  function activeLayer() {
    return docRef.current.layers.find((layer) => layer.id === docRef.current.activeLayerId) || docRef.current.layers[0];
  }
  function nudge(dx, dy) {
    const buffer = activeBuffer();
    if (selectionRef.current?.bounds) {
      const moved = moveSelectionPixels(buffer, selectionRef.current, dx, dy);
      setSelection(moved.selection);
      commitPixels({ ...moved.entry, layerId: docRef.current.activeLayerId });
    } else {
      const before = captureRect(buffer, { x: 0, y: 0, width: buffer.width, height: buffer.height });
      translateBuffer(buffer, dx, dy);
      const after = captureRect(buffer, before);
      commitPixels({ type: 'pixels', ...before, before: before.pixels, after: after.pixels, layerId: docRef.current.activeLayerId });
    }
  }
  function pasteClipboard() {
    const clip = clipRef.current;
    if (!clip) return;
    const added = addLayer(docRef.current);
    if (added.error) { setMessage(added.error); return; }
    const buffer = new PaintBuffer(docRef.current.paper.width, docRef.current.paper.height);
    for (let y = 0; y < clip.height; y += 1) {
      const destination = ((clip.originY + y) * buffer.width + clip.originX) * 4;
      if (clip.originY + y >= buffer.height) break;
      buffer.data.set(clip.pixels.subarray(y * clip.width * 4, y * clip.width * 4 + Math.min(clip.width, buffer.width - clip.originX) * 4), destination);
    }
    replaceDoc(added.doc, new Map([[added.doc.activeLayerId, buffer]]));
  }

  const strokeOptions = () => ({
    selection: selectionRef.current, alphaLock: activeLayer().alphaLock, pressureCurve,
    smoothing: brushRef.current.smoothing, layerId: docRef.current.activeLayerId,
  });

  const onPointerDown = (event) => {
    if (readOnly) return;
    const canvas = canvasRef.current;
    canvas.setPointerCapture?.(event.pointerId);
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointersRef.current.size >= 2 || spaceRef.current) {
      drawRef.current = { kind: 'pan', x: event.clientX, y: event.clientY, pan: { ...pan } };
      return;
    }
    if (palmReject && event.pointerType === 'touch') return;
    const point = paintPoint(event, canvas, flip);
    const currentTool = altRef.current ? 'picker' : toolRef.current;
    if (currentTool === 'picker') {
      const sample = sampleAll ? previewComposite(docRef.current, buffersRef.current, { base: baseRef.current }) : activeBuffer();
      setColor(colorToHex(sampleColor(sample, point.x, point.y)));
      return;
    }
    if (currentTool === 'bucket') {
      const reference = bucketAll ? compositeLayers(docRef.current.paper.width, docRef.current.paper.height, docRef.current.layers, buffersRef.current) : null;
      commitPixels(floodFill(activeBuffer(), point.x, point.y, colorRef.current, { tolerance, expand, selection: selectionRef.current, reference, alphaLock: activeLayer().alphaLock }));
      return;
    }
    if (currentTool.startsWith('select')) {
      drawRef.current = { kind: currentTool, start: point, points: [point], mode: event.shiftKey ? 'add' : event.altKey ? 'subtract' : selectionMode };
      return;
    }
    if (currentTool === 'move') {
      const before = captureRect(activeBuffer(), { x: 0, y: 0, width: activeBuffer().width, height: activeBuffer().height });
      drawRef.current = { kind: 'move', start: point, last: point, before, selection: selectionRef.current };
      return;
    }
    if (currentTool === 'geometry') {
      const before = captureRect(activeBuffer(), { x: 0, y: 0, width: activeBuffer().width, height: activeBuffer().height });
      drawRef.current = { kind: 'geometry', start: point, before };
      return;
    }
    drawRef.current = { kind: currentTool, points: [point] };
  };

  const onPointerMove = (event) => {
    const canvas = canvasRef.current;
    if (!drawRef.current || !canvas) return;
    if (drawRef.current.kind === 'pan') {
      setPan({ x: drawRef.current.pan.x + event.clientX - drawRef.current.x, y: drawRef.current.pan.y + event.clientY - drawRef.current.y });
      return;
    }
    const point = paintPoint(event, canvas, flip);
    const events = event.getCoalescedEvents?.() || [event];
    if (drawRef.current.kind === 'brush' || drawRef.current.kind === 'eraser' || drawRef.current.kind === 'smudge') {
      for (const sample of events) drawRef.current.points.push(paintPoint(sample, canvas, flip));
      const buffer = activeBuffer();
      if (drawRef.current.before) restoreRect(buffer, { ...drawRef.current.bounds, pixels: drawRef.current.before });
      const entry = drawRef.current.kind === 'eraser'
        ? eraseStroke(buffer, drawRef.current.points, brushRef.current, strokeOptions())
        : drawRef.current.kind === 'smudge'
          ? smudgeStroke(buffer, drawRef.current.points, Math.max(2, brushRef.current.size / 2), brushRef.current.flow || 50, selectionRef.current)
          : applyStroke(buffer, drawRef.current.points, brushRef.current, colorRef.current, strokeOptions());
      if (entry) {
        drawRef.current.bounds = entry;
        drawRef.current.before = entry.before;
        drawRef.current.entry = entry;
      }
      redraw();
      return;
    }
    if (String(drawRef.current.kind).startsWith('select') && drawRef.current.kind !== 'select-wand') {
      drawRef.current.points.push(point);
      drawRef.current.end = point;
      return;
    }
    if (drawRef.current.kind === 'geometry') {
      restoreRect(activeBuffer(), { ...drawRef.current.before, pixels: drawRef.current.before.pixels });
      rasterShape(activeBuffer(), shape, drawRef.current.start, point, brushRef.current, colorRef.current, { ...strokeOptions(), shift: event.shiftKey });
      redraw();
      drawRef.current.end = point;
      drawRef.current.shift = event.shiftKey;
    }
  };

  const onPointerUp = (event) => {
    pointersRef.current.delete(event.pointerId);
    const action = drawRef.current;
    drawRef.current = null;
    if (!action || action.kind === 'pan') return;
    const canvas = canvasRef.current;
    const point = paintPoint(event, canvas, flip);
    if (action.kind === 'brush' || action.kind === 'eraser' || action.kind === 'smudge') {
      if (action.entry) commitPixels(action.entry);
      return;
    }
    if (action.kind === 'geometry') {
      restoreRect(activeBuffer(), { ...action.before, pixels: action.before.pixels });
      const entry = rasterShape(activeBuffer(), shape, action.start, action.end || point, brushRef.current, colorRef.current, { ...strokeOptions(), shift: action.shift });
      commitPixels(entry);
      return;
    }
    if (action.kind === 'move') {
      restoreRect(activeBuffer(), { ...action.before, pixels: action.before.pixels });
      const dx = point.x - action.start.x, dy = point.y - action.start.y;
      if (action.selection?.bounds) {
        const moved = moveSelectionPixels(activeBuffer(), action.selection, dx, dy);
        setSelection(moved.selection);
        commitPixels(moved.entry);
      } else {
        translateBuffer(activeBuffer(), dx, dy);
        const after = captureRect(activeBuffer(), action.before);
        commitPixels({ type: 'pixels', ...action.before, before: action.before.pixels, after: after.pixels });
      }
      return;
    }
    if (action.kind === 'select-wand') {
      const sample = sampleAll ? compositeLayers(docRef.current.paper.width, docRef.current.paper.height, docRef.current.layers, buffersRef.current) : activeBuffer();
      const next = magicWandSelection(sample, point.x, point.y, tolerance);
      setSelection(combineSelection(selectionRef.current, next, action.mode));
      return;
    }
    if (action.kind === 'select-lasso') {
      const next = lassoSelection(docRef.current.paper.width, docRef.current.paper.height, action.points);
      setSelection(combineSelection(selectionRef.current, next, action.mode));
      return;
    }
    if (action.kind === 'select-rect' || action.kind === 'select-ellipse') {
      const end = constrainPoint(action.start, action.end || point, action.kind === 'select-ellipse' ? 'ellipse' : 'rect', event.shiftKey);
      const next = action.kind === 'select-ellipse'
        ? ellipseSelection(docRef.current.paper.width, docRef.current.paper.height, action.start.x, action.start.y, end.x, end.y)
        : rectSelection(docRef.current.paper.width, docRef.current.paper.height, action.start.x, action.start.y, end.x, end.y);
      setSelection(combineSelection(selectionRef.current, next, action.mode));
    }
  };

  const updatePaper = (patch) => {
    const paper = { ...doc.paper, ...patch };
    const next = { ...doc, paper };
    if (paper.width !== doc.paper.width || paper.height !== doc.paper.height) buffersRef.current = resizeBuffers(buffersRef.current, next, paper.width, paper.height);
    setDoc(next);
  };

  const save = async () => {
    setSaving(true);
    try {
      const flattened = await bufferToPngBlob(exportPaint(docRef.current, buffersRef.current, { base: docRef.current.outputMode === 'composite' ? baseRef.current : null }));
      const layers = [];
      for (const layer of docRef.current.layers) layers.push({ id: layer.id, blob: await bufferToPngBlob(buffersRef.current.get(layer.id)) });
      await onSave({ data: { ...docRef.current, touched: true }, flattened, layers });
      setMessage('已保存到项目素材');
    } catch (error) {
      setMessage(error.message || '保存失败');
    } finally { setSaving(false); }
  };

  const extract = async (mode) => {
    const layer = activeLayer();
    const buffer = buffersRef.current.get(layer.id);
    const blob = await bufferToPngBlob(mode === 'mask' ? toMask(buffer) : buffer);
    await onExtract({ blob, mode, title: layer.name });
    setMessage(mode === 'mask' ? '已拆出黑白遮罩节点' : '已拆出透明图层节点');
  };

  const hsv = rgbToHsv(...parseColor(color));
  const layerItems = [...doc.layers].reverse();

  return createPortal(<div className="paint-editor" ref={dialogRef} tabIndex={-1} role="dialog" aria-label="手绘画板" data-testid="paint-editor" onKeyDown={(event) => event.stopPropagation()}>
    <header className="paint-editor-bar">
      <h2>{doc.title}</h2>
      {TOOLS.map(([id, label]) => <button type="button" key={id} data-testid={`paint-tool-${id}`} aria-pressed={tool === id} onClick={() => setTool(id)}>{label}</button>)}
      <span className="paint-message" data-testid="paint-message" role="status">{message}</span>
      <span data-testid="paint-ink">{ink}</span>
      <button type="button" data-testid="paint-save" disabled={readOnly || saving} onClick={save}>{saving ? '保存中' : '保存'}</button>
      <button type="button" data-testid="paint-close" onClick={onClose}>关闭</button>
    </header>
    <aside className="paint-side">
      <div className="paint-colors">
        <button type="button" className="paint-fg" data-testid="paint-foreground" style={{ background: color }} aria-label="前景色" />
        <button type="button" className="paint-fg back" data-testid="paint-background" style={{ background }} aria-label="背景色" />
      </div>
      <label>色相<input className="paint-hue" data-testid="paint-hue" type="range" min="0" max="360" value={Math.round(hsv.h)} onChange={(event) => setColor(colorToHex(hsvToRgb(Number(event.target.value), hsv.s || 1, hsv.v || 1)))} /></label>
      <label>饱和<input type="range" min="0" max="100" value={Math.round(hsv.s * 100)} onChange={(event) => setColor(colorToHex(hsvToRgb(hsv.h, Number(event.target.value) / 100, hsv.v || 1)))} /></label>
      <label>明度<input type="range" min="0" max="100" value={Math.round(hsv.v * 100)} onChange={(event) => setColor(colorToHex(hsvToRgb(hsv.h, hsv.s, Number(event.target.value) / 100)))} /></label>
      <label>HEX<input data-testid="paint-hex" value={color} onChange={(event) => setColor(event.target.value)} /></label>
      <div className="paint-swatches">{[...new Set([color, ...doc.swatches, ...swatches])].slice(0, 16).map((swatch) => <button type="button" key={swatch} className="paint-swatch" style={{ background: swatch }} aria-label={swatch} onClick={() => setColor(swatch)} />)}</div>
      <button type="button" onClick={() => setDoc((current) => ({ ...current, swatches: [...new Set([color, ...current.swatches])].slice(0, 24) }))}>加入色板</button>
      <label>笔刷大小<input data-testid="paint-size" type="range" min="1" max="200" value={brush.size} onChange={(event) => setBrush({ ...brush, size: Number(event.target.value) })} /></label>
      <label>硬度<input type="range" min="0" max="100" value={brush.hardness} onChange={(event) => setBrush({ ...brush, hardness: Number(event.target.value) })} /></label>
      <label>不透明度<input type="range" min="1" max="100" value={brush.opacity} onChange={(event) => setBrush({ ...brush, opacity: Number(event.target.value) })} /></label>
      <label>流量<input type="range" min="1" max="100" value={brush.flow} onChange={(event) => setBrush({ ...brush, flow: Number(event.target.value) })} /></label>
      <label>间距<input type="range" min="1" max="200" value={brush.spacing} onChange={(event) => setBrush({ ...brush, spacing: Number(event.target.value) })} /></label>
      <label>平滑<input data-testid="paint-smoothing" type="range" min="0" max="100" value={brush.smoothing} onChange={(event) => setBrush({ ...brush, smoothing: Number(event.target.value) })} /></label>
      <label>压感曲线<select data-testid="paint-pressure" value={pressureCurve} onChange={(event) => setPressureCurve(event.target.value)}><option value="linear">线性</option><option value="soft">软</option><option value="hard">硬</option></select></label>
      <label><input data-testid="paint-palm" type="checkbox" checked={palmReject} onChange={(event) => setPalmReject(event.target.checked)} />防手掌误触</label>
      <label><input type="checkbox" checked={brush.pressureSize} onChange={(event) => setBrush({ ...brush, pressureSize: event.target.checked })} />压感控制大小</label>
      <label>几何<select data-testid="paint-shape" value={shape} onChange={(event) => setShape(event.target.value)}><option value="line">直线</option><option value="arrow">箭头</option><option value="rect">空心矩形</option><option value="rect-fill">实心矩形</option><option value="ellipse">空心椭圆</option><option value="ellipse-fill">实心椭圆</option></select></label>
      <label>选区<select data-testid="paint-select-mode" value={selectionMode} onChange={(event) => setSelectionMode(event.target.value)}><option value="new">新建</option><option value="add">加选</option><option value="subtract">减选</option></select></label>
      <label>容差<input data-testid="paint-tolerance" type="range" min="0" max="100" value={tolerance} onChange={(event) => setTolerance(Number(event.target.value))} /></label>
      <label>填充扩边<input type="range" min="0" max="3" value={expand} onChange={(event) => setExpand(Number(event.target.value))} /></label>
      <label>羽化<input data-testid="paint-feather" type="range" min="0" max="20" value={feather} onChange={(event) => setFeather(Number(event.target.value))} /></label>
      <button type="button" data-testid="paint-apply-feather" onClick={() => selection && setSelection(featherSelection(selection, feather))}>应用羽化</button>
      <button type="button" data-testid="paint-grow" onClick={() => selection && setSelection(growSelection(selection, 1))}>扩展选区</button>
      <button type="button" data-testid="paint-shrink" onClick={() => selection && setSelection(growSelection(selection, -1))}>收缩选区</button>
      <label><input type="checkbox" checked={sampleAll} onChange={(event) => { setSampleAll(event.target.checked); setBucketAll(event.target.checked); }} />参考全部可见层</label>
      <label>缩放 {Math.round(zoom * 100)}%<input type="range" min="10" max="800" value={Math.round(zoom * 100)} onChange={(event) => setZoom(Number(event.target.value) / 100)} /></label>
      <button type="button" onClick={() => { setZoom(1); setPan({ x: 40, y: 40 }); setRotation(0); setFlip(false); }}>视角复位</button>
      <button type="button" data-testid="paint-flip" aria-pressed={flip} onClick={() => setFlip((value) => !value)}>水平镜像</button>
      <label>旋转<input type="range" min="-180" max="180" value={rotation} onChange={(event) => setRotation(Number(event.target.value))} /></label>
    </aside>
    <div className="paint-stage-wrap" data-testid="paint-viewport" onWheel={(event) => { event.preventDefault(); setZoom((value) => Math.max(0.1, Math.min(8, value * (event.deltaY > 0 ? 0.9 : 1.1)))); }}>
      <div className="paint-stage-frame" style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom}) rotate(${rotation}deg) scaleX(${flip ? -1 : 1})` }}>
        <canvas ref={canvasRef} className={`paint-stage${doc.outputMode === 'transparent' ? ' is-transparent' : ''}`} data-testid="paint-stage" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} />
      </div>
    </div>
    <aside className="paint-side right" data-testid="paint-layers">
      <label>输出模式<select data-testid="paint-output" value={doc.outputMode} onChange={(event) => setDoc({ ...doc, outputMode: event.target.value })}>{OUTPUT_MODES.map((mode) => <option key={mode} value={mode}>{OUTPUT_MODE_LABELS[mode]}</option>)}</select></label>
      <label>纸张<select data-testid="paint-preset" value="" onChange={(event) => { const preset = PAPER_PRESETS.find((item) => item.id === event.target.value); if (preset) updatePaper(preset); }}><option value="">预设</option>{PAPER_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}</select></label>
      <label>宽<input data-testid="paint-width" type="number" min="64" max="4096" value={doc.paper.width} onChange={(event) => updatePaper({ width: Number(event.target.value) })} /></label>
      <label>高<input data-testid="paint-height" type="number" min="64" max="4096" value={doc.paper.height} onChange={(event) => updatePaper({ height: Number(event.target.value) })} /></label>
      <button type="button" data-testid="paint-match-base" disabled={!baseImage} onClick={() => baseRef.current && updatePaper(initialPaperForBase({ ...doc, touched: false }, baseRef.current))}>一键匹配底图尺寸</button>
      <label>纸底<select value={doc.paper.background} onChange={(event) => updatePaper({ background: event.target.value })}>{BACKGROUNDS.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
      <label>纸纹<select value={doc.paper.texture} onChange={(event) => updatePaper({ texture: event.target.value })}>{TEXTURES.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
      <label>纸纹透明度<input type="range" min="0" max="100" value={doc.paper.textureOpacity} onChange={(event) => updatePaper({ textureOpacity: Number(event.target.value) })} /></label>
      <label><input type="checkbox" checked={doc.paper.textureInOutput} onChange={(event) => updatePaper({ textureInOutput: event.target.checked })} />纸纹进入成图</label>
      <label>规划线<select data-testid="paint-guides" value={doc.paper.guideGrid} onChange={(event) => updatePaper({ guideGrid: event.target.value })}>{GUIDES.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
      <label>底图透明度<input type="range" min="0" max="100" value={doc.baseOverlay.opacity} onChange={(event) => setDoc({ ...doc, baseOverlay: { ...doc.baseOverlay, opacity: Number(event.target.value) } })} /></label>
      <button type="button" onClick={() => setDoc({ ...doc, baseOverlay: { ...doc.baseOverlay, position: doc.baseOverlay.position === 'above' ? 'below' : 'above', visible: true } })}>底图{doc.baseOverlay.position === 'above' ? '置顶' : '置底'}</button>
      <button type="button" data-testid="paint-add-layer" onClick={() => { const added = addLayer(doc); if (added.error) setMessage(added.error); else replaceDoc(added.doc, new Map([[added.doc.activeLayerId, new PaintBuffer(doc.paper.width, doc.paper.height)]])); }}>新建图层</button>
      <div className="paint-layers">{layerItems.map((layer) => <div key={layer.id} className={`paint-layer${layer.id === doc.activeLayerId ? ' active' : ''}`} data-testid={`paint-layer-${layer.id}`}>
        <input type="checkbox" checked={layer.visible} aria-label={`${layer.name}可见`} onChange={(event) => setDoc(patchLayer(doc, layer.id, { visible: event.target.checked }).doc)} />
        <button type="button" onClick={() => setDoc({ ...doc, activeLayerId: layer.id })}>{layer.name}</button>
        <span>{layer.opacity}%</span>
      </div>)}</div>
      <p>{doc.layers.length}/12</p>
      {doc.layers.length >= 12 && <p>{LAYER_LIMIT_MESSAGE}</p>}
      <label>图层名<input data-testid="paint-layer-name" value={activeLayer().name} onChange={(event) => setDoc(renameLayer(doc, doc.activeLayerId, event.target.value).doc)} /></label>
      <label>图层不透明度<input data-testid="paint-layer-opacity" type="range" min="0" max="100" value={activeLayer().opacity} onChange={(event) => setDoc(patchLayer(doc, doc.activeLayerId, { opacity: Number(event.target.value) }).doc)} /></label>
      <label>混合<select data-testid="paint-blend" value={activeLayer().blendMode} onChange={(event) => setDoc(patchLayer(doc, doc.activeLayerId, { blendMode: event.target.value }).doc)}>{['normal', 'multiply', 'screen', 'add', 'overlay', 'soft-light'].map((mode) => <option key={mode} value={mode}>{mode}</option>)}</select></label>
      <label><input type="checkbox" checked={activeLayer().alphaLock} onChange={(event) => setDoc(patchLayer(doc, doc.activeLayerId, { alphaLock: event.target.checked }).doc)} />锁定透明像素</label>
      <label><input type="checkbox" checked={activeLayer().clippingMask} onChange={(event) => setDoc(patchLayer(doc, doc.activeLayerId, { clippingMask: event.target.checked }).doc)} />剪贴蒙版</label>
      <button type="button" onClick={() => setDoc(moveLayer(doc, doc.activeLayerId, 'up').doc)}>上移</button>
      <button type="button" onClick={() => setDoc(moveLayer(doc, doc.activeLayerId, 'down').doc)}>下移</button>
      <button type="button" data-testid="paint-duplicate-layer" onClick={() => { const copied = duplicateLayer(doc); if (copied.error) setMessage(copied.error); else replaceDoc(copied.doc, new Map([[copied.doc.activeLayerId, buffersRef.current.get(copied.sourceId).clone()]])); }}>复制图层</button>
      <button type="button" onClick={() => { const removed = deleteLayer(doc); if (removed.error) setMessage(removed.error); else replaceDoc(removed.doc, new Map([[doc.activeLayerId, null]])); }}>删除图层</button>
      <button type="button" data-testid="paint-merge-down" onClick={() => { const merged = mergeDown(doc, buffersRef.current); if (merged.error) setMessage(merged.error); else { buffersRef.current = merged.buffers; setDoc({ ...merged.doc, touched: true }); redraw(); } }}>向下合并</button>
      <button type="button" data-testid="paint-stamp" onClick={() => { const stamped = stampVisible(doc, buffersRef.current); if (stamped.error) setMessage(stamped.error); else { buffersRef.current = stamped.buffers; setDoc({ ...stamped.doc, touched: true }); redraw(); } }}>盖印可见层</button>
      <button type="button" data-testid="paint-tint" onClick={() => { const entry = tintBuffer(buffersRef.current.get(doc.activeLayerId), color); commitPixels({ ...entry, layerId: doc.activeLayerId }); }}>图层着色</button>
      <button type="button" data-testid="paint-extract" onClick={() => extract('transparent')}>拆出为透明图</button>
      <button type="button" data-testid="paint-extract-mask" onClick={() => extract('mask')}>拆出为黑白遮罩</button>
      <button type="button" data-testid="paint-fill-mask" onClick={() => selection && commitPixels(fillColor(activeBuffer(), '#ffffff', selection, false))}>当前选区一键填白生成遮罩</button>
      <button type="button" data-testid="paint-transform-flip" onClick={() => commitPixels(transformBuffer(activeBuffer(), selectionRef.current, { flipH: true }))}>水平翻转像素</button>
      <button type="button" data-testid="paint-push" disabled title="局域网伴侣功能待 M3 接入">推到平板</button>
    </aside>
  </div>, document.body);
}
