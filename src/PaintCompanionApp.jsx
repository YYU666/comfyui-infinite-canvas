import React, { useEffect, useRef, useState } from 'react';
import { builtinBrushes, brushState } from './paint-brushes.js';
import { PaintBuffer, countInk, floodFill, previewRect, sampleColor, colorToHex, createStrokeSession, strokeTo, finishStroke } from './paint-engine.js';
import { clientToCanvasPoint } from './paint-viewport.js';
import { createLocalHistory, palmBlocksStroke, pushLocalHistory, redoLocalHistory, undoLocalHistory } from './paint-companion.js';

const CLIENT = `tablet-${Math.random().toString(36).slice(2, 8)}`;

function pointOf(event, canvas) {
  const frame = canvas.closest('.companion-frame') || canvas.parentElement;
  const local = clientToCanvasPoint(event.clientX, event.clientY, frame);
  const scaleX = canvas.width / (frame.offsetWidth || canvas.width);
  const scaleY = canvas.height / (frame.offsetHeight || canvas.height);
  const pressure = event.pointerType === 'pen' ? (event.pressure || 0.5) : (event.pointerType === 'touch' ? Math.max(0.35, event.pressure || 0.7) : 1);
  return { x: local.x * scaleX, y: local.y * scaleY, pressure, pointerType: event.pointerType || 'touch' };
}

async function loadPng(url, width, height, empty = true) {
  const buffer = new PaintBuffer(width, height);
  const image = await fetch(url, { credentials: 'include' });
  if (!image.ok) return empty ? buffer : null;
  const bitmap = await createImageBitmap(await image.blob());
  const scratch = document.createElement('canvas');
  scratch.width = width;
  scratch.height = height;
  const context = scratch.getContext('2d');
  context.drawImage(bitmap, 0, 0, width, height);
  buffer.data.set(context.getImageData(0, 0, width, height).data);
  return buffer;
}

export default function PaintCompanionApp() {
  const canvasRef = useRef(null);
  const buffersRef = useRef(new Map());
  const baseRef = useRef(null);
  const drawRef = useRef(null);
  const pointersRef = useRef(new Map());
  const historyRef = useRef(createLocalHistory());
  const revisionRef = useRef(0);
  const [session, setSession] = useState(null);
  const [error, setError] = useState('');
  const [code, setCode] = useState(() => new URLSearchParams(location.search).get('code') || '');
  const [tool, setTool] = useState('brush');
  const [color, setColor] = useState('#111111');
  const [brush, setBrush] = useState(() => brushState(builtinBrushes()[0]));
  const [brushes, setBrushes] = useState(() => builtinBrushes());
  const [layerId, setLayerId] = useState('');
  const [ink, setInk] = useState(0);
  const [palm, setPalm] = useState(true);
  const [drawer, setDrawer] = useState('');
  const [view, setView] = useState({ zoom: 1, rotation: 0, flip: false });
  const viewRef = useRef(view);
  const sessionRef = useRef(null);
  const layerRef = useRef('');
  const toolRef = useRef(tool);
  const brushRef = useRef(brush);
  const colorRef = useRef(color);
  useEffect(() => { viewRef.current = view; }, [view]);
  useEffect(() => { sessionRef.current = session; }, [session]);
  useEffect(() => { layerRef.current = layerId; }, [layerId]);
  useEffect(() => { toolRef.current = tool; }, [tool]);
  useEffect(() => { brushRef.current = brush; }, [brush]);
  useEffect(() => { colorRef.current = color; }, [color]);

  const paint = (rect) => {
    const canvas = canvasRef.current;
    const current = sessionRef.current;
    if (!canvas || !current) return;
    if (canvas.width !== current.paper.width || canvas.height !== current.paper.height) {
      canvas.width = current.paper.width;
      canvas.height = current.paper.height;
    }
    const doc = {
      paper: current.paper,
      layers: current.layers,
      outputMode: 'composite',
      baseOverlay: current.baseOverlay || { visible: true, opacity: 100, position: 'below' },
    };
    const patch = previewRect(doc, buffersRef.current, rect || { x: 0, y: 0, width: current.paper.width, height: current.paper.height }, { base: baseRef.current, guides: false });
    if (patch.width && patch.height) canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(patch.pixels), patch.width, patch.height), patch.x, patch.y);
  };

  const refreshInk = () => {
    const buffer = buffersRef.current.get(layerRef.current);
    setInk(buffer ? countInk(buffer) : 0);
  };

  const loadSession = async (next) => {
    buffersRef.current = new Map();
    for (const layer of next.layers || []) buffersRef.current.set(layer.id, await loadPng(`/api/lan/layer/${layer.id}`, next.paper.width, next.paper.height));
    try { baseRef.current = await loadPng('/api/lan/base-image', next.paper.width, next.paper.height, false); }
    catch { baseRef.current = null; }
    const imported = [];
    for (const item of next.brushes || []) {
      if (item.stampPngBase64) {
        const stamp = await loadPng(`data:image/png;base64,${item.stampPngBase64}`, 32, 32).catch?.(() => null);
        imported.push({ ...item, kind: 'stamp', stamp: stamp ? { width: stamp.width, height: stamp.height, alpha: stampAlpha(stamp) } : null });
      }
    }
    setBrushes([...builtinBrushes(), ...imported.filter((item) => item.stamp)]);
    setSession(next);
    sessionRef.current = next;
    const active = next.activeLayerId || next.layers?.[0]?.id || '';
    setLayerId(active);
    layerRef.current = active;
    paint(null);
    refreshInk();
  };

  const pair = async (value) => {
    setError('');
    const response = await fetch('/api/lan/pair', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: value }) });
    const payload = await response.json();
    if (!response.ok) { setError(payload.message || '配对失败'); return; }
    await loadSession(payload.session);
  };

  useEffect(() => { if (code) pair(code); }, []);
  useEffect(() => { paint(null); refreshInk(); }, [layerId, session]);

  useEffect(() => {
    if (!session) return undefined;
    let closed = false;
    const source = new EventSource('/api/lan/events');
    source.addEventListener('ready', (event) => { revisionRef.current = JSON.parse(event.data).revision || 0; });
    source.addEventListener('update', (event) => {
      const payload = JSON.parse(event.data);
      revisionRef.current = payload.revision || revisionRef.current;
      if (payload.clientId === CLIENT) return;
      applyRemote(payload);
    });
    const timer = setInterval(async () => {
      if (closed || source.readyState === 1) return;
      try {
        const response = await fetch(`/api/lan/sync?since=${revisionRef.current}`, { credentials: 'include' });
        if (!response.ok) return;
        const payload = await response.json();
        revisionRef.current = payload.revision || revisionRef.current;
        if (payload.session) { sessionRef.current = { ...sessionRef.current, ...payload.session, paper: payload.session.paper || sessionRef.current.paper }; setSession(sessionRef.current); }
        for (const item of payload.events || []) if (item.clientId !== CLIENT) applyRemote(item);
        paint(null);
      } catch { /* the next poll retries */ }
    }, 1200);
    return () => { closed = true; source.close(); clearInterval(timer); };
  }, [session?.nodeId]);

  const applyRemote = (payload) => {
    if (payload.type === 'undo') { undoLocalHistory(historyRef.current, buffersRef.current); paint(null); refreshInk(); return; }
    if (payload.type === 'redo') { redoLocalHistory(historyRef.current, buffersRef.current); paint(null); refreshInk(); return; }
    if (payload.type === 'snapshot') { loadSession(sessionRef.current); return; }
    if (payload.type === 'switchLayer') { setLayerId(payload.layerId); return; }
    if (!payload.points?.length) return;
    const buffer = buffersRef.current.get(payload.layerId);
    if (!buffer) return;
    const preset = brushes.find((item) => item.id === payload.brushId) || brushRef.current;
    const session = createStrokeSession(buffer, brushState(preset), payload.color || '#111111', { layerId: payload.layerId, eraser: payload.tool === 'eraser' });
    for (const point of payload.points) strokeTo(session, { ...point, pointerType: 'pen' });
    finishStroke(session);
    paint(null);
    refreshInk();
  };

  const postStroke = async (points) => {
    await fetch('/api/lan/stroke', {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: CLIENT, layerId: layerRef.current, tool: toolRef.current, brushId: brushRef.current.id, color: colorRef.current, params: { ...brushRef.current, stamp: undefined }, points }),
    });
  };

  const sendCommand = async (type, extra = {}) => {
    await fetch('/api/lan/command', {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, layerId: layerRef.current, clientId: CLIENT, ...extra }),
    });
  };

  const onPointerDown = (event) => {
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY, t: Date.now() });
    if (pointersRef.current.size >= 2) { drawRef.current = null; return; }
    if (palmBlocksStroke(palm, event, pointersRef.current.size)) return;
    const canvas = canvasRef.current;
    const buffer = buffersRef.current.get(layerRef.current);
    if (!buffer) return;
    const point = pointOf(event, canvas);
    if (toolRef.current === 'picker') {
      const current = sessionRef.current;
      const doc = { paper: current.paper, layers: current.layers, outputMode: 'composite', baseOverlay: current.baseOverlay };
      setColor(colorToHex(sampleColor({ data: previewRect(doc, buffersRef.current, { x: point.x, y: point.y, width: 1, height: 1 }, { base: baseRef.current }).pixels, width: 1, height: 1 }, 0, 0)));
      return;
    }
    if (toolRef.current === 'bucket') {
      const entry = floodFill(buffer, point.x, point.y, colorRef.current, { tolerance: 12 });
      if (entry) pushLocalHistory(historyRef.current, { ...entry, layerId: layerRef.current });
      paint(entry);
      refreshInk();
      postStroke([point]);
      return;
    }
    const stroke = createStrokeSession(buffer, brushRef.current, colorRef.current, { layerId: layerRef.current, eraser: toolRef.current === 'eraser' });
    drawRef.current = { points: [point], stroke };
    paint(strokeTo(stroke, point));
  };

  const onPointerMove = (event) => {
    if (!pointersRef.current.has(event.pointerId)) return;
    const previous = pointersRef.current.get(event.pointerId);
    pointersRef.current.set(event.pointerId, { ...previous, x: event.clientX, y: event.clientY });
    if (pointersRef.current.size === 2) {
      const [a, b] = [...pointersRef.current.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      const angle = Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
      if (!drawRef.current?.pinch) drawRef.current = { pinch: true, distance, angle, view: { ...viewRef.current } };
      const scale = distance / Math.max(1, drawRef.current.distance);
      setView({ ...drawRef.current.view, zoom: Math.max(0.2, Math.min(6, drawRef.current.view.zoom * scale)), rotation: drawRef.current.view.rotation + (angle - drawRef.current.angle) });
      return;
    }
    if (!drawRef.current?.stroke) return;
    const next = pointOf(event, canvasRef.current);
    drawRef.current.points.push(next);
    paint(strokeTo(drawRef.current.stroke, next));
  };

  const onPointerUp = async (event) => {
    const count = pointersRef.current.size;
    pointersRef.current.delete(event.pointerId);
    if (count === 2 && pointersRef.current.size === 1) {
      const started = [...pointersRef.current.values()][0];
      if (started && Date.now() - started.t < 280) { undoLocal(); await sendCommand('undo'); }
      drawRef.current = null;
      return;
    }
    if (count === 3) { redoLocal(); await sendCommand('redo'); drawRef.current = null; return; }
    const action = drawRef.current;
    drawRef.current = null;
    if (!action?.stroke) return;
    const entry = finishStroke(action.stroke);
    if (entry) pushLocalHistory(historyRef.current, { ...entry, layerId: layerRef.current });
    refreshInk();
    await postStroke(action.points);
  };

  const undoLocal = () => { undoLocalHistory(historyRef.current, buffersRef.current); paint(null); refreshInk(); };
  const redoLocal = () => { redoLocalHistory(historyRef.current, buffersRef.current); paint(null); refreshInk(); };
  const active = session?.layers?.find((layer) => layer.id === layerId);

  return <div className="companion-shell" data-testid="companion-app">
    <header className="companion-bar">
      <i className="companion-status" data-testid="companion-status" data-state={session ? 'live' : 'idle'} />
      <strong>{active?.name || 'Refmuse 平板画板'}</strong>
      <button type="button" data-testid="companion-layers" onClick={() => setDrawer(drawer === 'layers' ? '' : 'layers')}>图层</button>
      {!session && <form onSubmit={(event) => { event.preventDefault(); pair(code); }}>
        <input data-testid="companion-code" value={code} inputMode="numeric" onChange={(event) => setCode(event.target.value)} />
        <button type="submit">配对</button>
      </form>}
      <span data-testid="companion-ink">{ink}</span>
      <button type="button" data-testid="companion-flip" onClick={() => setView((value) => ({ ...value, flip: !value.flip }))}>镜像</button>
      <button type="button" data-testid="companion-reset" onClick={() => setView({ zoom: 1, rotation: 0, flip: false })}>复位</button>
      <label><input data-testid="companion-palm" type="checkbox" checked={palm} onChange={(event) => setPalm(event.target.checked)} />防手掌</label>
      <span role="alert">{error}</span>
    </header>
    <div className="companion-stage">
      <aside className="companion-sliders">
        <input data-testid="companion-size" type="range" min="1" max="160" value={brush.size} onChange={(event) => setBrush({ ...brush, size: Number(event.target.value) })} />
        <input data-testid="companion-opacity" type="range" min="1" max="100" value={brush.opacity || 100} onChange={(event) => setBrush({ ...brush, opacity: Number(event.target.value) })} />
        <button type="button" data-testid="companion-undo" onClick={() => { undoLocal(); sendCommand('undo'); }}>撤销</button>
        <button type="button" data-testid="companion-redo" onClick={() => { redoLocal(); sendCommand('redo'); }}>重做</button>
      </aside>
      <div className="companion-frame" style={{ transform: `scale(${view.zoom}) rotate(${view.rotation}deg) scaleX(${view.flip ? -1 : 1})` }}>
        <canvas ref={canvasRef} data-testid="companion-stage" data-base={baseRef.current ? 'yes' : 'no'}
          onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} />
      </div>
      {drawer === 'layers' && <aside className="companion-drawer" data-testid="companion-layer-drawer">
        {(session?.layers || []).map((layer) => <div key={layer.id}>
          <button type="button" aria-pressed={layer.id === layerId} onClick={() => { setLayerId(layer.id); sendCommand('switchLayer', { layerId: layer.id }); }}>{layer.name}</button>
          <input type="checkbox" checked={layer.visible !== false} aria-label={`${layer.name}可见`} onChange={(event) => { const visible = event.target.checked; setSession({ ...session, layers: session.layers.map((item) => item.id === layer.id ? { ...item, visible } : item) }); sendCommand('toggleVisible', { layerId: layer.id, visible }); }} />
          <input type="range" min="0" max="100" value={layer.opacity ?? 100} aria-label={`${layer.name}不透明度`} onChange={(event) => { const opacity = Number(event.target.value); setSession({ ...session, layers: session.layers.map((item) => item.id === layer.id ? { ...item, opacity } : item) }); sendCommand('opacity', { layerId: layer.id, opacity }); }} />
        </div>)}
      </aside>}
      {drawer === 'brushes' && <aside className="companion-drawer" data-testid="companion-brush-drawer">
        {brushes.map((item) => <button type="button" key={item.id} onClick={() => { setBrush(brushState(item)); setDrawer(''); }}>{item.name}</button>)}
      </aside>}
    </div>
    <footer className="companion-tools">
      {[['brush', '画笔'], ['eraser', '橡皮'], ['picker', '吸管'], ['bucket', '油漆桶']].map(([id, label]) => <button type="button" key={id} data-testid={`companion-${id}`} aria-pressed={tool === id} onClick={() => setTool(id)}>{label}</button>)}
      <button type="button" data-testid="companion-brushes" onClick={() => setDrawer(drawer === 'brushes' ? '' : 'brushes')}>笔刷</button>
      <input data-testid="companion-color" type="color" value={color} onChange={(event) => setColor(event.target.value)} />
    </footer>
  </div>;
}

function stampAlpha(buffer) {
  const alpha = new Uint8Array(buffer.width * buffer.height);
  for (let index = 0; index < alpha.length; index += 1) alpha[index] = buffer.data[index * 4 + 3];
  return alpha;
}
