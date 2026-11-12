import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Plus, Trash2, ArrowUp, ArrowDown, Scissors, Undo2, Redo2, ArrowDownToLine, Square } from 'lucide-react';
import { normalizeVideoEditDocument, defaultVideoEditDocument, VIDEO_EDIT_VIDEO_PORTS, VIDEO_EDIT_PORTS, framesOf, timecode, ptsToSeconds } from './video-edit-document';
import { probeVideoAsset } from './video-edit-runtime';

const FPS_CHOICES = [[{ num: 24, den: 1 }, '24'], [{ num: 25, den: 1 }, '25'], [{ num: 30000, den: 1001 }, '29.97'], [{ num: 30, den: 1 }, '30'], [{ num: 60, den: 1 }, '60']];
const fpsKey = (fps) => `${fps.num}/${fps.den}`;
const clone = (value) => JSON.parse(JSON.stringify(value));

export default function VideoEditorPanel({ id, data, state, actions, onClose }) {
  const root = useRef(null);
  const videoRef = useRef(null);
  const [draft, setDraft] = useState(() => clone(data.editDocument || defaultVideoEditDocument()));
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(0);
  const [probes, setProbes] = useState({});
  const [splitAt, setSplitAt] = useState('');
  const history = useRef({ past: [], future: [] });
  const running = ['running', 'queued'].includes(data.status) || state.busy;
  const locked = running || actions.readOnly;

  // Probe every connected input that already is a project asset (frame-exact info).
  useEffect(() => {
    const controller = new AbortController();
    for (const [slot, input] of Object.entries(state.inputs)) {
      if (!input.assetPath || probes[slot]?.assetPath === input.assetPath) continue;
      probeVideoAsset(actions.projectId, input.assetPath, { signal: controller.signal })
        .then((info) => setProbes((items) => ({ ...items, [slot]: { ...info, assetPath: input.assetPath } })))
        .catch((reason) => { if (reason.name !== 'AbortError') setProbes((items) => ({ ...items, [slot]: { error: reason.message, assetPath: input.assetPath } })); });
    }
    return () => controller.abort();
  }, [JSON.stringify(Object.entries(state.inputs).map(([slot, input]) => [slot, input.assetPath]))]);

  const commit = useCallback((next, { record = true } = {}) => {
    setDraft(next);
    try {
      const normalized = normalizeVideoEditDocument(next);
      setError('');
      if (record) { history.current.past.push(clone(data.editDocument || defaultVideoEditDocument())); history.current.future = []; }
      actions.updateNode(id, { editDocument: normalized, error: null });
    } catch (reason) { setError(reason.message); }
  }, [actions, id, data.editDocument]);
  const change = (mutate) => { if (locked) return; const next = clone(draft); mutate(next); commit(next); };
  const undo = () => { const previous = history.current.past.pop(); if (!previous) return; history.current.future.push(clone(draft)); commit(previous, { record: false }); };
  const redo = () => { const next = history.current.future.pop(); if (!next) return; history.current.past.push(clone(draft)); commit(next, { record: false }); };

  const clips = draft.clips || [];
  const clip = clips[selected];
  const fps = draft.outputProfile?.fps || { num: 24, den: 1 };
  const frames = clips.map((item) => framesOf(item, fps));
  const total = frames.reduce((sum, value) => sum + (value ?? 0), 0);

  const addWhole = (slot) => change((doc) => {
    const info = probes[slot];
    if (!info?.frameTimebase) throw new Error('需要先完成素材探测（恒定帧率）。');
    const ids = new Set(doc.clips.map((item) => item.id));
    let n = doc.clips.length + 1; while (ids.has(`clip${n}`)) n += 1;
    const isPlaceholder = doc.clips.length === 1 && doc.clips[0].id === 'clip1' && !data.editResultAssetPath && JSON.stringify(doc.clips[0]) === JSON.stringify(defaultVideoEditDocument().clips[0]);
    const item = { id: `clip${n}`, inputSlot: slot, sourceInPts: 0, sourceOutPts: info.frameCount, timebase: info.frameTimebase, reverse: false, pad: { mode: 'none', count: 0 }, muted: false, gain: 1 };
    if (isPlaceholder) { doc.clips = [{ ...item, id: 'clip1' }]; if (info.fps) { doc.outputProfile.fps = info.fps; doc.timelineTimebase = info.frameTimebase; } }
    else doc.clips.push(item);
  });
  const setClip = (patch) => change((doc) => { Object.assign(doc.clips[selected], patch); });
  const move = (delta) => change((doc) => { const [item] = doc.clips.splice(selected, 1); doc.clips.splice(selected + delta, 0, item); setSelected(selected + delta); });
  const remove = () => change((doc) => { if (doc.clips.length > 1) { doc.clips.splice(selected, 1); setSelected(Math.max(0, selected - 1)); } });
  const split = () => change((doc) => {
    const at = Number(splitAt), item = doc.clips[selected];
    if (!Number.isSafeInteger(at) || at <= item.sourceInPts || at >= item.sourceOutPts) throw new Error('分割点必须在入点与出点之间（源时基整数）。');
    const ids = new Set(doc.clips.map((value) => value.id));
    let n = 2; while (ids.has(`${item.id}_${n}`)) n += 1;
    doc.clips.splice(selected + 1, 0, { ...clone(item), id: `${item.id}_${n}`.slice(0, 64), sourceInPts: at });
    item.sourceOutPts = at;
  });
  const safe = (fn) => (...args) => { try { fn(...args); } catch (reason) { setError(reason.message); } };

  // Keyboard is scoped to this panel: never reaches the canvas delete handler.
  useEffect(() => {
    const element = root.current;
    const onKey = (event) => {
      event.stopPropagation();
      const typing = ['INPUT', 'SELECT', 'TEXTAREA'].includes(event.target.tagName);
      if (event.key === 'Escape') { event.preventDefault(); onClose(); }
      else if (!typing && (event.key === 'Delete' || event.key === 'Backspace')) { event.preventDefault(); safe(remove)(); }
      else if (!typing && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo(); }
    };
    element?.addEventListener('keydown', onKey);
    element?.focus();
    return () => element?.removeEventListener('keydown', onKey);
  });

  // Timeline trimming with pointer capture; always released on up/cancel/lost capture.
  const drag = useRef(null);
  const startTrim = (event, index, edge) => {
    if (locked || !clips[index].timebase) return;
    event.preventDefault(); event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const strip = event.currentTarget.closest('.video-edit-timeline').getBoundingClientRect();
    drag.current = { index, edge, startX: event.clientX, base: clone(clips[index]), perFrame: strip.width / Math.max(total, 1), pointerId: event.pointerId };
  };
  const moveTrim = (event) => {
    const current = drag.current; if (!current || current.pointerId !== event.pointerId) return;
    const delta = Math.round((event.clientX - current.startX) / Math.max(current.perFrame, 0.01));
    const next = clone(draft); const item = next.clips[current.index];
    const max = probes[item.inputSlot]?.frameCount ?? Number.MAX_SAFE_INTEGER;
    if (current.edge === 'in') item.sourceInPts = Math.min(Math.max(0, current.base.sourceInPts + delta), item.sourceOutPts - 1);
    else item.sourceOutPts = Math.max(Math.min(max, current.base.sourceOutPts + delta), item.sourceInPts + 1);
    setDraft(next);
  };
  const endTrim = (event) => {
    if (!drag.current) return;
    try { event.currentTarget.releasePointerCapture?.(event.pointerId); } catch { /* already released */ }
    drag.current = null; commit(clone(draft));
  };

  const source = clip ? state.inputs[clip.inputSlot] : null;
  const seek = (pts) => { const video = videoRef.current; if (video && clip?.timebase) video.currentTime = ptsToSeconds(pts, clip.timebase) + 1e-3; };
  useEffect(() => { if (clip) seek(clip.sourceInPts); }, [selected, source?.url]);
  const label = (pts) => clip?.timebase ? `${pts} · ${timecode(Math.round(ptsToSeconds(pts, clip.timebase) * fps.num / fps.den), fps)}` : String(pts);
  const external = draft.outputProfile?.audio === 'external';

  return createPortal(<div className="video-edit-overlay" onPointerDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}>
    <section className="video-edit-panel" ref={root} tabIndex={-1} role="dialog" aria-label="视频编辑">
      <header><b>{data.title || '视频编辑'}</b><span>帧号 = 源时基整数；预览为近似定位，导出由后端逐帧精确完成</span>
        <button onClick={undo} title="撤销 (Ctrl+Z)" disabled={locked}><Undo2 size={14} /></button><button onClick={redo} title="重做 (Ctrl+Shift+Z)" disabled={locked}><Redo2 size={14} /></button>
        <button onClick={onClose} aria-label="关闭"><X size={16} /></button></header>
      <div className="video-edit-columns">
        <aside className="video-edit-inputs">
          <h4>素材</h4>
          {VIDEO_EDIT_PORTS.filter((slot) => state.inputs[slot]).map((slot) => {
            const info = probes[slot];
            return <div key={slot} className="video-edit-input">
              <b>{slot}</b><span>{state.inputs[slot].title}</span>
              <small>{!state.inputs[slot].assetPath ? '生成结果：导出时导入项目素材' : info?.error ? info.error : info ? `${info.width}×${info.height} · ${info.frameCount} 帧 · ${info.fps ? (info.fps.num / info.fps.den).toFixed(3) : '可变'} fps · ${info.hasAudio ? '有声' : '无声'}` : '探测中…'}</small>
              {slot !== 'a1' && <button disabled={locked || !info?.frameTimebase} onClick={safe(() => addWhole(slot))}><Plus size={12} />添加整段</button>}
            </div>;
          })}
          {!Object.keys(state.inputs).length && <p>把视频素材连接到节点左侧 v1–v8 端口；a1 可连音频作为外挂原声。</p>}
          {Object.values(state.inputs).some((input) => !input.assetPath) && <button disabled={locked} onClick={() => actions.prepareVideoEdit(id).catch((reason) => setError(reason.message))}>导入生成结果到项目素材</button>}
        </aside>
        <main className="video-edit-preview">
          {source?.url ? <video ref={videoRef} src={source.url} controls preload="metadata" playsInline onTimeUpdate={(event) => {
            if (clip?.timebase && event.currentTarget.currentTime >= ptsToSeconds(clip.sourceOutPts, clip.timebase)) { event.currentTarget.pause(); seek(clip.sourceInPts); }
          }} /> : <span>选择镜头后在这里预览源片段</span>}
          <div className="video-edit-timeline" onPointerMove={moveTrim}>
            {clips.map((item, index) => <div key={item.id} className={`video-edit-clip ${index === selected ? 'selected' : ''}`} style={{ flexGrow: Math.max(frames[index] ?? 1, 1) }} onClick={() => setSelected(index)}>
              <i className="trim in" onPointerDown={(event) => startTrim(event, index, 'in')} onPointerUp={endTrim} onPointerCancel={endTrim} onLostPointerCapture={endTrim} />
              <span>{index + 1}. {item.inputSlot}{item.reverse ? ' ⟲' : ''}{item.pad?.count ? ` +${item.pad.count}` : ''}<small>{frames[index] ?? '?'} 帧</small></span>
              <i className="trim out" onPointerDown={(event) => startTrim(event, index, 'out')} onPointerUp={endTrim} onPointerCancel={endTrim} onLostPointerCapture={endTrim} />
            </div>)}
          </div>
          <div className="video-edit-total">成片 {total} 帧 · {timecode(total, fps)} · 镜头按顺序无缝拼接</div>
        </main>
        <aside className="video-edit-clip-settings">
          <h4>镜头 {clip ? selected + 1 : ''}</h4>
          {clip && <>
            <label>输入<select value={clip.inputSlot} disabled={locked} onChange={(event) => setClip({ inputSlot: event.target.value })}>{VIDEO_EDIT_VIDEO_PORTS.map((slot) => <option key={slot} value={slot}>{slot}{state.inputs[slot] ? ` · ${state.inputs[slot].title}` : ''}</option>)}</select></label>
            <label>入点<input type="number" min={0} step={1} value={clip.sourceInPts} disabled={locked} onChange={(event) => setClip({ sourceInPts: Number(event.target.value) })} /><small>{label(clip.sourceInPts)}</small></label>
            <label>出点（不含）<input type="number" min={1} step={1} value={clip.sourceOutPts} disabled={locked} onChange={(event) => setClip({ sourceOutPts: Number(event.target.value) })} /><small>{label(clip.sourceOutPts)}</small></label>
            <small>时基 {clip.timebase ? `${clip.timebase.num}/${clip.timebase.den}` : '源视频流时基'}</small>
            <label className="check"><input type="checkbox" checked={clip.reverse} disabled={locked} onChange={(event) => setClip({ reverse: event.target.checked })} />倒放（音频同步倒放）</label>
            <label>末帧补帧<input type="number" min={0} max={2000} step={1} value={clip.pad?.count || 0} disabled={locked} onChange={(event) => { const count = Number(event.target.value); setClip({ pad: count > 0 ? { mode: 'last_frame', count } : { mode: 'none', count: 0 } }); }} /><small>补帧段静音</small></label>
            <label className="check"><input type="checkbox" checked={clip.muted} disabled={locked} onChange={(event) => setClip({ muted: event.target.checked })} />静音</label>
            <label>音量<input type="range" min={0} max={1} step={0.05} value={clip.gain} disabled={locked || clip.muted} onChange={(event) => setClip({ gain: Number(event.target.value) })} /><small>{Math.round(clip.gain * 100)}%</small></label>
            <div className="video-edit-row"><input type="number" placeholder="分割点" value={splitAt} onChange={(event) => setSplitAt(event.target.value)} /><button disabled={locked} onClick={safe(split)}><Scissors size={12} />分割</button></div>
            <div className="video-edit-row"><button disabled={locked || selected === 0} onClick={safe(() => move(-1))}><ArrowUp size={12} />前移</button><button disabled={locked || selected >= clips.length - 1} onClick={safe(() => move(1))}><ArrowDown size={12} />后移</button><button disabled={locked || clips.length <= 1} onClick={safe(remove)}><Trash2 size={12} />删除</button></div>
          </>}
          <h4>输出</h4>
          <label>帧率<select value={fpsKey(fps)} disabled={locked} onChange={(event) => change((doc) => { const [num, den] = event.target.value.split('/').map(Number); doc.outputProfile.fps = { num, den }; doc.timelineTimebase = { num: den, den: num }; })}>{FPS_CHOICES.map(([value, text]) => <option key={fpsKey(value)} value={fpsKey(value)}>{text}</option>)}{!FPS_CHOICES.some(([value]) => fpsKey(value) === fpsKey(fps)) && <option value={fpsKey(fps)}>{(fps.num / fps.den).toFixed(3)}</option>}</select></label>
          <label>声音<select value={draft.outputProfile?.audio || 'clips'} disabled={locked} onChange={(event) => change((doc) => {
            doc.outputProfile.audio = event.target.value;
            if (event.target.value === 'external') {
              const first = doc.clips[0];
              doc.outputProfile.audioFrom = doc.outputProfile.audioFrom || { inputSlot: state.inputs.a1 ? 'a1' : first.inputSlot, sourceInPts: 0, sourceOutPts: total, timebase: { num: fps.den, den: fps.num } };
            } else delete doc.outputProfile.audioFrom;
          })}><option value="clips">片段原声</option><option value="mute">无声</option><option value="external">外挂整段原声</option></select></label>
          {external && <>
            <label>原声来源<select value={draft.outputProfile.audioFrom.inputSlot} disabled={locked} onChange={(event) => change((doc) => { doc.outputProfile.audioFrom.inputSlot = event.target.value; })}>{VIDEO_EDIT_PORTS.map((slot) => <option key={slot} value={slot}>{slot}</option>)}</select></label>
            <label>原声入点<input type="number" value={draft.outputProfile.audioFrom.sourceInPts} disabled={locked} onChange={(event) => change((doc) => { doc.outputProfile.audioFrom.sourceInPts = Number(event.target.value); })} /></label>
            <label>原声出点<input type="number" value={draft.outputProfile.audioFrom.sourceOutPts} disabled={locked} onChange={(event) => change((doc) => { doc.outputProfile.audioFrom.sourceOutPts = Number(event.target.value); })} /><small>时基 {draft.outputProfile.audioFrom.timebase ? `${draft.outputProfile.audioFrom.timebase.num}/${draft.outputProfile.audioFrom.timebase.den}` : '源'}；长度须与成片一致（±1 帧内）</small></label>
          </>}
          <label>画质 CRF<input type="number" min={0} max={51} value={draft.outputProfile?.crf ?? 14} disabled={locked} onChange={(event) => change((doc) => { doc.outputProfile.crf = Number(event.target.value); })} /></label>
        </aside>
      </div>
      {(error || data.error) && <p className="video-edit-error" role="alert">{error || data.error}</p>}
      <footer>
        <span>{running ? `${data.stage || '导出中'} ${Math.round((data.progress || 0) * 100)}%` : data.editResultAssetPath ? '已有导出结果；再次导出会替换节点内结果（旧文件保留在项目素材中）' : '尚未导出'}</span>
        {running ? <button onClick={() => actions.cancelVideoEdit(id)}><Square size={12} />取消导出</button>
          : <button className="video-edit-export" disabled={actions.readOnly || Boolean(error)} onClick={() => actions.generateNode(id)}><ArrowDownToLine size={14} />导出 MP4</button>}
      </footer>
    </section>
  </div>, document.body);
}
