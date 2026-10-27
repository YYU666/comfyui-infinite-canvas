import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Brush, Check, Eraser, Minus, Plus, Trash2, Undo2, X } from 'lucide-react';

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('底图或遮罩读取失败，请确认素材仍可访问。'));
    image.src = url;
  });
}

export default function MaskEditor({ guideUrl, guideTitle, maskUrl, onSave, onClose }) {
  const viewRef = useRef(null);
  const maskRef = useRef(null);
  const stageRef = useRef(null);
  const historyRef = useRef([]);
  const drawingRef = useRef(false);
  const lastPointRef = useRef(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [tool, setTool] = useState('brush');
  const [brushSize, setBrushSize] = useState(42);
  const [zoom, setZoom] = useState(1);
  const [cursor, setCursor] = useState({ x: 0, y: 0, size: 42, visible: false });
  const [saving, setSaving] = useState(false);

  const renderMask = useCallback(() => {
    const view = viewRef.current;
    const mask = maskRef.current;
    if (!view || !mask) return;
    const context = view.getContext('2d');
    context.clearRect(0, 0, view.width, view.height);
    context.globalCompositeOperation = 'source-over';
    context.drawImage(mask, 0, 0);
    context.globalCompositeOperation = 'source-in';
    context.fillStyle = 'rgba(255, 48, 56, .5)';
    context.fillRect(0, 0, view.width, view.height);
    context.globalCompositeOperation = 'source-over';
  }, []);

  useEffect(() => {
    let active = true;
    setReady(false);
    setError('');
    historyRef.current = [];
    (async () => {
      try {
        const guide = await loadImage(guideUrl);
        if (!active) return;
        const width = guide.naturalWidth;
        const height = guide.naturalHeight;
        const mask = document.createElement('canvas');
        mask.width = width;
        mask.height = height;
        maskRef.current = mask;
        const view = viewRef.current;
        view.width = width;
        view.height = height;
        if (maskUrl) {
          const existing = await loadImage(maskUrl);
          if (!active) return;
          const temporary = document.createElement('canvas');
          temporary.width = width;
          temporary.height = height;
          const temporaryContext = temporary.getContext('2d', { willReadFrequently: true });
          temporaryContext.drawImage(existing, 0, 0, width, height);
          const pixels = temporaryContext.getImageData(0, 0, width, height);
          for (let index = 0; index < pixels.data.length; index += 4) {
            const alpha = pixels.data[index];
            pixels.data[index] = 255;
            pixels.data[index + 1] = 255;
            pixels.data[index + 2] = 255;
            pixels.data[index + 3] = alpha;
          }
          mask.getContext('2d').putImageData(pixels, 0, 0);
        }
        renderMask();
        setReady(true);
      } catch (reason) {
        if (active) setError(reason.message || '遮罩编辑器初始化失败。');
      }
    })();
    return () => { active = false; };
  }, [guideUrl, maskUrl, renderMask]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onClose();
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        const mask = maskRef.current;
        const previous = historyRef.current.pop();
        if (mask && previous) {
          mask.getContext('2d').putImageData(previous, 0, 0);
          renderMask();
        }
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose, renderMask]);

  const pointFromEvent = (event) => {
    const view = viewRef.current;
    const rect = view.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * view.width / rect.width,
      y: (event.clientY - rect.top) * view.height / rect.height,
    };
  };

  const remember = () => {
    const mask = maskRef.current;
    if (!mask) return;
    historyRef.current.push(mask.getContext('2d').getImageData(0, 0, mask.width, mask.height));
    if (historyRef.current.length > 8) historyRef.current.shift();
  };

  const paintTo = (point, dot = false) => {
    const mask = maskRef.current;
    if (!mask) return;
    const context = mask.getContext('2d');
    context.globalCompositeOperation = tool === 'eraser' ? 'destination-out' : 'source-over';
    context.strokeStyle = '#ffffff';
    context.fillStyle = '#ffffff';
    context.lineWidth = brushSize;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    const previous = lastPointRef.current || point;
    context.beginPath();
    context.moveTo(previous.x, previous.y);
    context.lineTo(point.x, point.y);
    context.stroke();
    if (dot) {
      context.beginPath();
      context.arc(point.x, point.y, brushSize / 2, 0, Math.PI * 2);
      context.fill();
    }
    lastPointRef.current = point;
    renderMask();
  };

  const updateCursor = (event) => {
    const stage = stageRef.current;
    const view = viewRef.current;
    if (!stage || !view) return;
    const stageRect = stage.getBoundingClientRect();
    const viewRect = view.getBoundingClientRect();
    setCursor({
      x: event.clientX - stageRect.left,
      y: event.clientY - stageRect.top,
      size: Math.max(8, brushSize * viewRect.width / view.width),
      visible: true,
    });
  };

  const onPointerDown = (event) => {
    if (!ready || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    remember();
    drawingRef.current = true;
    lastPointRef.current = null;
    paintTo(pointFromEvent(event), true);
    updateCursor(event);
  };

  const onPointerMove = (event) => {
    updateCursor(event);
    if (drawingRef.current) paintTo(pointFromEvent(event));
  };

  const stopPainting = (event) => {
    drawingRef.current = false;
    lastPointRef.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const undo = () => {
    const mask = maskRef.current;
    const previous = historyRef.current.pop();
    if (!mask || !previous) return;
    mask.getContext('2d').putImageData(previous, 0, 0);
    renderMask();
  };

  const clear = () => {
    const mask = maskRef.current;
    if (!mask) return;
    remember();
    mask.getContext('2d').clearRect(0, 0, mask.width, mask.height);
    renderMask();
  };

  const save = async () => {
    const mask = maskRef.current;
    if (!mask || saving) return;
    setSaving(true);
    setError('');
    try {
      const output = document.createElement('canvas');
      output.width = mask.width;
      output.height = mask.height;
      const context = output.getContext('2d');
      context.fillStyle = '#000000';
      context.fillRect(0, 0, output.width, output.height);
      context.drawImage(mask, 0, 0);
      const blob = await new Promise((resolve) => output.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('遮罩图片编码失败，请重试。');
      await onSave(new File([blob], `painted-mask-${Date.now()}.png`, { type: 'image/png' }));
    } catch (reason) {
      setError(reason.message || '保存遮罩失败。');
      setSaving(false);
    }
  };

  return createPortal(
    <div className="mask-editor-backdrop" role="dialog" aria-modal="true" aria-label="母图遮罩绘制" onPointerDown={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
      <section className="mask-editor-panel">
        <header className="mask-editor-header">
          <div><Brush size={16} /><strong>在原始母图上绘制遮罩</strong><span>{guideTitle}</span></div>
          <button onClick={onClose} aria-label="关闭遮罩编辑器" title="关闭 · Esc"><X size={18} /></button>
        </header>
        <div className="mask-editor-toolbar">
          <div className="mask-tool-group" aria-label="遮罩工具">
            <button className={tool === 'brush' ? 'active' : ''} onClick={() => setTool('brush')}><Brush size={14} />画笔</button>
            <button className={tool === 'eraser' ? 'active' : ''} onClick={() => setTool('eraser')}><Eraser size={14} />橡皮</button>
            <button onClick={undo} title="撤销 · Ctrl+Z"><Undo2 size={14} />撤销</button>
            <button onClick={clear}><Trash2 size={14} />清除</button>
          </div>
          <label className="mask-brush-size"><span>笔刷</span><input type="range" min="8" max="180" step="2" value={brushSize} onChange={(event) => setBrushSize(Number(event.target.value))} /><b>{brushSize} px</b></label>
          <div className="mask-zoom-group"><button onClick={() => setZoom((value) => Math.max(1, value / 2))} disabled={zoom === 1} aria-label="缩小遮罩底图"><Minus size={14} /></button><span>{zoom * 100}%</span><button onClick={() => setZoom((value) => Math.min(4, value * 2))} disabled={zoom === 4} aria-label="放大遮罩底图"><Plus size={14} /></button></div>
        </div>
        <div className="mask-editor-workspace">
          <div className="mask-editor-scroll">
            <div ref={stageRef} className="mask-editor-stage" style={{ width: `${zoom * 100}%` }} onPointerLeave={() => setCursor((value) => ({ ...value, visible: false }))}>
              <img src={guideUrl} alt={`${guideTitle} · 遮罩底图`} draggable={false} />
              <canvas ref={viewRef} className={`mask-paint-canvas ${tool === 'eraser' ? 'erasing' : ''}`} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={stopPainting} onPointerCancel={stopPainting} />
              {cursor.visible && ready && <div className={`mask-brush-cursor ${tool === 'eraser' ? 'erasing' : ''}`} style={{ left: cursor.x, top: cursor.y, width: cursor.size, height: cursor.size }} />}
            </div>
          </div>
          {!ready && !error && <div className="mask-editor-loading">正在读取原始母图……</div>}
          {error && <div className="mask-editor-error">{error}</div>}
        </div>
        <footer className="mask-editor-footer">
          <span><i />红色区域会被重绘，未涂红区域保持原图。可放大后精修脚部边缘。</span>
          <div><button onClick={onClose}>取消</button><button className="mask-save" disabled={!ready || saving} onClick={save}><Check size={15} />{saving ? '正在保存……' : '保存到遮罩节点'}</button></div>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
