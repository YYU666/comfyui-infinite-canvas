import React, { createContext, forwardRef, useContext, useEffect, useRef, useState } from 'react';
import { Film } from 'lucide-react';

// Separate from the mutable node-actions context: media only needs the zoom tier.
export const CanvasPreviewTier = createContext('full');

export const CanvasVideo = forwardRef(function CanvasVideo(props, ref) {
  const tier = useContext(CanvasPreviewTier);
  const container = useRef(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (tier !== 'full') { setVisible(false); return; }
    if (!globalThis.IntersectionObserver) { setVisible(true); return; }
    const observer = new IntersectionObserver(entries => setVisible(entries.some(entry => entry.isIntersecting)));
    if (container.current) observer.observe(container.current);
    return () => observer.disconnect();
  }, [tier]);
  return <div ref={container} className="canvas-video-preview">
    {tier === 'full' && visible ? <video {...props} ref={ref} preload={props.preload || 'metadata'} />
      : <div className="media-video-compact"><Film size={24} /><span>视频预览 · 放大恢复播放</span></div>}
  </div>;
});
