import React, { useEffect, useRef, useState } from 'react';
import { Pause, Play } from 'lucide-react';
import { createMotionCanvasPreview } from './motion-canvas-pilot-engine.js';

function labelTime(ms) {
  const centiseconds = Math.max(0, Math.round(ms / 10));
  const minutes = Math.floor(centiseconds / 6000);
  const seconds = String(Math.floor(centiseconds / 100) % 60).padStart(2, '0');
  return minutes + ':' + seconds + '.' + String(centiseconds % 100).padStart(2, '0');
}

export default function MotionCanvasPilot({ plan, url }) {
  const video = useRef(null);
  const canvas = useRef(null);
  const renderer = useRef(null);
  const raf = useRef(null);
  const [atMs, setAtMs] = useState(0);
  const [mediaReady, setMediaReady] = useState(false);
  const [sceneReady, setSceneReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState('');
  const durationMs = plan.sourceOutMs - plan.sourceInMs;

  useEffect(() => {
    const media = video.current;
    let closed = false;
    let engine;
    setSceneReady(false);
    setMediaReady(false);
    setAtMs(0);
    setError('');

    function initializeMedia() {
      if (closed || !media || media.readyState < 1) return;
      if (Number.isFinite(media.duration) && plan.sourceOutMs > Math.round(media.duration * 1000)) {
        setError('预览区间超过源视频，请调整结束时间。');
        return;
      }
      media.pause();
      media.currentTime = plan.sourceInMs / 1000;
      setMediaReady(true);
    }
    function pauseWhileHidden() {
      if (document.hidden) media.pause();
    }

    media.addEventListener('loadedmetadata', initializeMedia);
    document.addEventListener('visibilitychange', pauseWhileHidden);
    initializeMedia();
    const cues = plan.cues.map((cue) => ({ ...cue, atMs: cue.atMs - plan.sourceInMs }));
    createMotionCanvasPreview(canvas.current, { title: plan.title, cues, durationMs })
      .then(async (loaded) => {
        if (closed) { loaded.dispose(); return; }
        engine = loaded;
        renderer.current = loaded;
        await loaded.seek(Math.max(0, media.currentTime * 1000 - plan.sourceInMs));
        if (!closed) setSceneReady(true);
      })
      .catch(() => { if (!closed) setError('Motion Canvas 场景加载失败。'); });

    return () => {
      closed = true;
      media.removeEventListener('loadedmetadata', initializeMedia);
      document.removeEventListener('visibilitychange', pauseWhileHidden);
      cancelAnimationFrame(raf.current);
      media.pause();
      renderer.current = null;
      engine?.dispose();
    };
  }, [plan, url, durationMs]);

  const displayAt = (relativeMs) => {
    const time = Math.max(0, Math.min(durationMs, Math.round(relativeMs)));
    const engine = renderer.current;
    engine?.seek(time).catch(() => {
      if (renderer.current !== engine) return;
      video.current?.pause();
      setError('同步预览暂时无法绘制。');
    });
    setAtMs(time);
  };

  const syncFromVideo = () => {
    const media = video.current;
    if (!media) return;
    const relativeMs = media.currentTime * 1000 - plan.sourceInMs;
    if (relativeMs >= durationMs) {
      media.pause();
      if (media.currentTime * 1000 - plan.sourceOutMs > 10) media.currentTime = plan.sourceOutMs / 1000;
      displayAt(durationMs);
    } else {
      displayAt(relativeMs);
    }
  };

  const animate = () => {
    syncFromVideo();
    if (video.current && !video.current.paused) raf.current = requestAnimationFrame(animate);
  };

  function seek(relativeMs) {
    const media = video.current;
    const time = Math.max(0, Math.min(durationMs, relativeMs));
    media.currentTime = (plan.sourceInMs + time) / 1000;
    displayAt(time);
  }

  async function toggle() {
    const media = video.current;
    if (!media.paused) { media.pause(); return; }
    if (atMs >= durationMs - 25) seek(0);
    try { await media.play(); }
    catch { setError('无法播放源视频，请重新打开预览。'); }
  }

  const activeIndex = plan.cues.findLastIndex((cue) => cue.atMs <= plan.sourceInMs + atMs);
  const ready = sceneReady && mediaReady && !error;

  return <main className="motion-canvas-pilot">
    <div className="motion-canvas-pilot-stages">
      <section>
        <h4>原片与旁白</h4>
        <video ref={video} src={url} playsInline preload="metadata"
          onError={() => setError('源视频无法播放，请检查项目素材。')}
          onSeeked={syncFromVideo}
          onTimeUpdate={syncFromVideo}
          onPlay={() => {
            setPlaying(true);
            cancelAnimationFrame(raf.current);
            animate();
          }}
          onPause={() => {
            setPlaying(false);
            cancelAnimationFrame(raf.current);
          }}
          onEnded={() => { setPlaying(false); displayAt(durationMs); }} />
      </section>
      <section>
        <h4>Motion Canvas 同步动效</h4>
        <canvas ref={canvas} role="img" aria-label={'口播动效预览 · ' + plan.title} />
      </section>
    </div>
    <div className="motion-canvas-pilot-controls">
      <button disabled={!ready} onClick={toggle}>{playing ? <Pause size={15} /> : <Play size={15} />}{playing ? '暂停同步预览' : '播放同步预览'}</button>
      <input type="range" aria-label="同步预览位置" min={0} max={durationMs} step={1} value={atMs}
        disabled={!ready} onChange={(event) => seek(Number(event.target.value))} />
      <span>{labelTime(atMs)} / {labelTime(durationMs)}</span>
    </div>
    {error && <p className="video-edit-error" role="alert">{error}</p>}
    {!error && !ready && <p role="status">正在加载动效与旁白…</p>}
    <div className="motion-canvas-pilot-cues" aria-label="口播触发点">
      {plan.cues.map((cue, index) => <button key={cue.atMs} disabled={!ready} aria-pressed={index === activeIndex}
        onClick={() => seek(Math.min(cue.atMs + 320, (plan.cues[index + 1]?.atMs ?? plan.sourceOutMs) - 1) - plan.sourceInMs)}>
        <time>{labelTime(cue.atMs - plan.sourceInMs)}</time><b>{cue.label}</b>
      </button>)}
    </div>
  </main>;
}
