import React, { useEffect, useRef, useState } from 'react';
import { Image as ImageIcon, X } from 'lucide-react';

const FIT_VIEW = { scale: 1, x: 0, y: 0 };
const clampScale = (value) => Math.min(8, Math.max(1, value));

export default function ImageLightbox({ preview, onClose, closeRef }) {
  const [view, setView] = useState(FIT_VIEW);
  const contentRef = useRef(null);
  const dragRef = useRef(null);

  useEffect(() => {
    const content = contentRef.current;
    if (!content) return undefined;
    const onWheel = (event) => {
      event.preventDefault();
      event.stopPropagation();
      const rect = content.getBoundingClientRect();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1);
      const pointerX = event.clientX - rect.left - rect.width / 2;
      const pointerY = event.clientY - rect.top - rect.height / 2;
      setView((current) => {
        const scale = clampScale(current.scale * Math.exp(-delta * 0.0015));
        if (scale === current.scale) return current;
        if (scale === 1) return FIT_VIEW;
        return {
          scale,
          x: pointerX - (pointerX - current.x) * scale / current.scale,
          y: pointerY - (pointerY - current.y) * scale / current.scale,
        };
      });
    };
    content.addEventListener('wheel', onWheel, { passive: false });
    return () => content.removeEventListener('wheel', onWheel);
  }, []);

  const startDrag = (event) => {
    if (view.scale === 1 || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY };
  };
  const moveDrag = (event) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    const dx = event.clientX - drag.clientX;
    const dy = event.clientY - drag.clientY;
    dragRef.current = { ...drag, clientX: event.clientX, clientY: event.clientY };
    setView((current) => ({ ...current, x: current.x + dx, y: current.y + dy }));
  };
  const endDrag = (event) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return <div className="image-lightbox" role="dialog" aria-modal="true" aria-label={`${preview.title || '图片'}大图预览`} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }} onDoubleClick={(event) => event.stopPropagation()}>
    <section className="image-lightbox-panel">
      <header className="image-lightbox-header">
        <div><ImageIcon size={15} /><span>{preview.title || '图片预览'}</span>{preview.name && <small>{preview.name}</small>}</div>
        <div><span className="image-lightbox-hint">滚轮缩放 · 拖动查看 · 双击复位 · Esc 关闭</span><span className="image-lightbox-zoom" data-testid="image-preview-zoom">{Math.round(view.scale * 100)}%</span><button ref={closeRef} onClick={onClose} aria-label="关闭大图预览" title="关闭 · Esc"><X size={18} /></button></div>
      </header>
      <div ref={contentRef} className="image-lightbox-content" onClick={onClose} onDoubleClick={() => setView(FIT_VIEW)}>
        <img src={preview.url} alt={preview.title || '生成图片大图'} draggable={false} className={view.scale > 1 ? 'is-zoomed' : ''}
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
          onClick={(event) => event.stopPropagation()} onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag} />
      </div>
    </section>
  </div>;
}
