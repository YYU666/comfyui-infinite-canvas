import React, { useEffect, useRef, useState } from 'react';
import { Download, Image as ImageIcon, X } from 'lucide-react';
import { imageExportBlob } from './image-export.js';
import ImageComparison from './ImageComparison';

const FIT_VIEW = { scale: 1, x: 0, y: 0 };
const clampScale = (value) => Math.min(8, Math.max(1, value));

export default function ImageLightbox({ preview, onClose, closeRef }) {
  const [view, setView] = useState(FIT_VIEW);
  const [showCompare, setShowCompare] = useState(false);
  const contentRef = useRef(null);
  const dragRef = useRef(null);
  const [removeMetadata, setRemoveMetadata] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');
  const exportImage = async () => {
    if (exporting) return;
    setExporting(true); setExportError('');
    try {
      const blob = await imageExportBlob(preview.url, removeMetadata);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      const name = (preview.name || preview.title || 'image').replace(/[\\/:*?"<>|]/g, '_');
      const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/avif': 'avif' }[blob.type];
      link.download = removeMetadata ? `${name.replace(/\.[^.]+$/, '')}.png` : /\.[a-z0-9]{2,5}$/i.test(name) || !extension ? name : `${name}.${extension}`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (error) { setExportError(error.message); }
    finally { setExporting(false); }
  };

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
  }, [showCompare]);

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
        <div>{preview.comparison && <button className="image-lightbox-compare-tab" type="button" aria-pressed={showCompare} onClick={() => setShowCompare(!showCompare)}>图像对照</button>}<span className="image-lightbox-hint" hidden={showCompare}>滚轮缩放 · 拖动查看 · 双击复位 · Esc 关闭</span><span className="image-lightbox-zoom" data-testid="image-preview-zoom" hidden={showCompare}>{Math.round(view.scale * 100)}%</span><button ref={closeRef} onClick={onClose} aria-label="关闭大图预览" title="关闭 · Esc"><X size={18} /></button></div>
      </header>
      <div className="image-export-controls" onClick={(event) => event.stopPropagation()}>
        <label><input type="checkbox" checked={removeMetadata} onChange={(event) => setRemoveMetadata(event.target.checked)} />去除元数据（PNG）</label>
        <small>移除提示词、工作流、种子等信息，保留像素与色彩配置；原文件不变。</small>
        <button disabled={exporting} onClick={exportImage}><Download size={14} />{exporting ? '正在导出…' : '导出图片'}</button>
        {exportError && <span role="alert">{exportError}</span>}
      </div>
      {showCompare ? <ImageComparison {...preview.comparison} /> : <div ref={contentRef} className="image-lightbox-content" onClick={onClose} onDoubleClick={() => setView(FIT_VIEW)}>
        <img src={preview.url} alt={preview.title || '生成图片大图'} draggable={false} className={view.scale > 1 ? 'is-zoomed' : ''}
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
          onClick={(event) => event.stopPropagation()} onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag} />
      </div>}
    </section>
  </div>;
}
