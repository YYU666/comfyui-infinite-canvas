import React, { useEffect, useRef, useState } from 'react';
import { ObjectUrlLru } from './object-url-lru';
import { thumbnailUrl } from './canvas-thumbnails';
import { thumbnailLoader } from './thumbnail-loader';

const EMPTY_IMAGE = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
const blobCache = new ObjectUrlLru(64);
let blobQueue = Promise.resolve();
export const clearCanvasThumbnails = () => blobCache.clear();

function blobThumbnail(source) {
  const cached = blobCache.get(source);
  if (cached) return cached.pending;
  const create = async () => {
    const response = await fetch(source);
    if (!response.ok) throw new Error('缩略图读取失败');
    const bitmap = await createImageBitmap(await response.blob(), { resizeWidth: 640, resizeQuality: 'high' });
    try {
      const scale = Math.min(1, 640 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.82));
      if (!blob) throw new Error('缩略图编码失败');
      return URL.createObjectURL(blob);
    } finally { bitmap.close(); }
  };
  const pending = blobQueue.then(create, create);
  blobQueue = pending.catch(() => {});
  blobCache.set(source, pending);
  return pending;
}

export default function CanvasImage({ source, alt = '', ...props }) {
  const imageRef = useRef(null);
  const [display, setDisplay] = useState(null);
  const [failure, setFailure] = useState(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    let visible = false;
    let loaded = false;
    let unsubscribe;
    let blobStarted = false;
    setDisplay(null);
    setFailure(null);
    const load = () => {
      if (!active || !source || unsubscribe) return;
      const url = thumbnailUrl(source);
      if (url) unsubscribe = thumbnailLoader.subscribe(url,
        (url) => { if (active && visible) { loaded = true; setDisplay({ source, url }); } },
        () => { if (active && visible) setFailure(source); });
      else if (source.startsWith('blob:')) {
        if (blobStarted) return;
        blobStarted = true;
        blobThumbnail(source)
          .then((url) => { if (active) setDisplay({ source, url }); })
          .catch(() => { if (active) setFailure(source); });
      }
      else setFailure(source);
    };
    // ReactFlow culls distant nodes; this additionally gates mounted offscreen
    // nodes and toolbar reference images before any fetch or bitmap work begins.
    if (!globalThis.IntersectionObserver) {
      visible = true;
      load(); // ReactFlow still limits this fallback to mounted viewport nodes.
      return () => { active = false; unsubscribe?.(); };
    }
    const observer = new IntersectionObserver((entries) => {
      visible = entries.some((entry) => entry.isIntersecting);
      if (visible) { setFailure(null); load(); }
      else if (unsubscribe && !loaded) { unsubscribe(); unsubscribe = undefined; setDisplay(null); }
    });
    if (imageRef.current) observer.observe(imageRef.current);
    return () => { active = false; unsubscribe?.(); observer.disconnect(); };
  }, [source, attempt]);
  const failed = source && failure === source;
  return <>
    <img key={`${source}:${attempt}`} ref={imageRef} src={!failed && display?.source === source ? display.url : EMPTY_IMAGE}
      alt={alt} draggable={false} decoding="async" {...props}
      onError={() => setFailure(source)} />
    {failed && <button type="button" className="nodrag" title="双击节点可查看原图"
      style={{ position: 'absolute', left: 8, top: 8, zIndex: 2, fontSize: 11 }}
      onClick={(event) => { event.stopPropagation(); setAttempt((value) => value + 1); }}>缩略图未加载 · 重试</button>}
  </>;
}
