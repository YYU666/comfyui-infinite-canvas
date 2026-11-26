import React, { useEffect, useRef, useState } from 'react';
import { builtinBrushes, brushState } from './paint-brushes.js';
import { PaintBuffer, applyStroke, eraseStroke, countInk, captureRect, restoreRect } from './paint-engine.js';

const CLIENT = `tablet-${Math.random().toString(36).slice(2, 8)}`;

function pointOf(event, canvas) {
  const rect = canvas.getBoundingClientRect();
  const x = (event.clientX - rect.left) * canvas.width / rect.width;
  const y = (event.clientY - rect.top) * canvas.height / rect.height;
  const pressure = event.pointerType === 'pen' ? (event.pressure || 0.5) : (event.pointerType === 'touch' ? Math.max(0.35, event.pressure || 0.7) : 1);
  return { x, y, pressure, pointerType: event.pointerType || 'touch' };
}

export default function PaintCompanionApp() {
  const canvasRef = useRef(null);
  const buffersRef = useRef(new Map());
  const drawRef = useRef(null);
  const pointersRef = useRef(new Map());
  const [session, setSession] = useState(null);
  const [error, setError] = useState('');
  const [code, setCode] = useState(() => new URLSearchParams(location.search).get('code') || '');
  const [tool, setTool] = useState('brush');
  const [color, setColor] = useState('#111111');
  const [brush, setBrush] = useState(() => brushState(builtinBrushes()[0]));
  const [layerId, setLayerId] = useState('');
  const [ink, setInk] = useState(0);
  const [palm, setPalm] = useState(true);
  const [view, setView] = useState({ zoom: 1, rotation: 0, flip: false });
  const viewRef = useRef(view);
  useEffect(() => { viewRef.current = view; }, [view]);

  const redraw = () => {
    const canvas = canvasRef.current;
    const current = buffersRef.current.get(layerId);
    if (!canvas || !current) return;
    canvas.width = current.width;
    canvas.height = current.height;
    canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(current.data), current.width, current.height), 0, 0);
    setInk(countInk(current));
  };

  const pair = async (value) => {
    setError('');
    const response = await fetch('/api/lan/pair', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: value }) });
    const payload = await response.json();
    if (!response.ok) { setError(payload.message || '配对失败'); return; }
    const next = payload.session;
    buffersRef.current = new Map();
    for (const layer of next.layers || []) {
      const buffer = new PaintBuffer(next.paper.width, next.paper.height);
      try {
        const image = await fetch(`/api/lan/layer/${layer.id}`, { credentials: 'include' });
        if (image.ok) {
          const bitmap = await createImageBitmap(await image.blob());
          const scratch = document.createElement('canvas');
          scratch.width = buffer.width; scratch.height = buffer.height;
          const context = scratch.getContext('2d');
          context.drawImage(bitmap, 0, 0);
          buffer.data.set(context.getImageData(0, 0, buffer.width, buffer.height).data);
        }
      } catch { /* an empty layer is still drawable */ }
      buffersRef.current.set(layer.id, buffer);
    }
    setSession(next);
    setLayerId(next.activeLayerId || next.layers?.[0]?.id || '');
  };

  useEffect(() => { if (code) pair(code); }, []);
  useEffect(() => { redraw(); }, [layerId, session]);

  const postStroke = async (points) => {
    await fetch('/api/lan/stroke', {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: CLIENT, layerId, tool, brushId: brush.id, color, params: { ...brush, stamp: undefined }, points }),
    });
  };

  const sendCommand = async (type) => {
    await fetch('/api/lan/command', {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, layerId }),
    });
  };

  const onPointerDown = (event) => {
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY, t: Date.now() });
    if (pointersRef.current.size >= 2) { drawRef.current = null; return; }
    if (palm && event.pointerType === 'touch' && event.width > 40) return;
    const canvas = canvasRef.current;
    const buffer = buffersRef.current.get(layerId);
    if (!buffer) return;
    drawRef.current = { points: [pointOf(event, canvas)], tool, before: captureRect(buffer, { x: 0, y: 0, width: buffer.width, height: buffer.height }) };
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
    if (!drawRef.current?.points) return;
    const buffer = buffersRef.current.get(layerId);
    restoreRect(buffer, drawRef.current.before);
    drawRef.current.points.push(pointOf(event, canvasRef.current));
    const entry = tool === 'eraser'
      ? eraseStroke(buffer, drawRef.current.points, brush, { layerId })
      : applyStroke(buffer, drawRef.current.points, brush, color, { layerId });
    if (entry) drawRef.current.entry = entry;
    redraw();
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
    if (count === 3) { await sendCommand('redo'); drawRef.current = null; return; }
    const action = drawRef.current;
    drawRef.current = null;
    if (!action?.points?.length) return;
    await postStroke(action.points);
    redraw();
  };

  const undoLocal = () => {
    setInk((value) => value);
  };

  return <div className="companion-shell" data-testid="companion-app">
    <header className="companion-bar">
      <i className="companion-status" data-testid="companion-status" data-state={session ? 'live' : 'idle'} />
      <strong>Refmuse 平板画板</strong>
      {!session && <form onSubmit={(event) => { event.preventDefault(); pair(code); }}>
        <input data-testid="companion-code" value={code} inputMode="numeric" onChange={(event) => setCode(event.target.value)} />
        <button type="submit">配对</button>
      </form>}
      <span data-testid="companion-ink">{ink}</span>
      <span role="alert">{error}</span>
    </header>
    <div className="companion-stage">
      <canvas ref={canvasRef} data-testid="companion-stage" style={{ transform: `scale(${view.zoom}) rotate(${view.rotation}deg) scaleX(${view.flip ? -1 : 1})` }}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} />
    </div>
    <footer className="companion-tools">
      {[['brush', '画笔'], ['eraser', '橡皮']].map(([id, label]) => <button type="button" key={id} data-testid={`companion-${id}`} aria-pressed={tool === id} onClick={() => setTool(id)}>{label}</button>)}
      <input data-testid="companion-color" type="color" value={color} onChange={(event) => setColor(event.target.value)} />
      <input data-testid="companion-size" type="range" min="1" max="160" value={brush.size} onChange={(event) => setBrush({ ...brush, size: Number(event.target.value) })} />
      <button type="button" data-testid="companion-undo" onClick={() => sendCommand('undo')}>撤销</button>
      <button type="button" data-testid="companion-redo" onClick={() => sendCommand('redo')}>重做</button>
      <button type="button" data-testid="companion-flip" onClick={() => setView((value) => ({ ...value, flip: !value.flip }))}>镜像</button>
      <button type="button" data-testid="companion-reset" onClick={() => setView({ zoom: 1, rotation: 0, flip: false })}>复位</button>
      <label><input data-testid="companion-palm" type="checkbox" checked={palm} onChange={(event) => setPalm(event.target.checked)} />防手掌</label>
    </footer>
  </div>;
}
