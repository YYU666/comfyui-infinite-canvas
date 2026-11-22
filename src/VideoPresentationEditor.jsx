import React, { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { timecode, VIDEO_PRESENTATION_MAX_PAGES } from './video-edit-document';

const LAYOUT = { fullscreen: '全屏 · 保留原声', side: '右侧卡片 · 保留录屏' };
const MOTION = { none: '直接出现', fade: '淡入淡出', reveal: '要点逐条出现' };

export default function VideoPresentationEditor({ pages, fps, total, locked, onChange }) {
  const [selectedId, setSelectedId] = useState(null);
  const page = pages.find((item) => item.id === selectedId) || pages[0];
  const cursor = pages.at(-1)?.endFrame || 0;
  const canAdd = !locked && pages.length < VIDEO_PRESENTATION_MAX_PAGES && total > cursor;

  function add() {
    if (!canAdd) return;
    const ids = new Set(pages.map((item) => item.id));
    let index = pages.length + 1;
    while (ids.has('page' + index)) index += 1;
    const id = 'page' + index;
    onChange([...pages, { id, startFrame: cursor, endFrame: Math.min(total, cursor + Math.round(4 * fps.num / fps.den)),
      title: '新演示页', bullets: [], layout: 'fullscreen', motion: 'reveal' }]);
    setSelectedId(id);
  }
  function update(patch) {
    onChange(pages.map((item) => item.id === page.id ? { ...item, ...patch } : item));
  }

  return <div className="video-edit-columns video-presentation-columns">
    <aside className="video-edit-inputs">
      <h4>演示页</h4>
      {pages.map((item) => <button key={item.id} className="video-presentation-choice"
        aria-pressed={item.id === page?.id} onClick={() => setSelectedId(item.id)}>
        <span>{item.title || '演示页'}</span>
        <small>{timecode(item.startFrame, fps)} – {timecode(item.endFrame, fps)}</small>
      </button>)}
      <button disabled={!canAdd} onClick={add}><Plus size={14} />添加演示页</button>
      <small>演示页按成片帧定位。改剪辑后，请复核各页时码。</small>
    </aside>
    <main className="video-presentation-preview">
      {page ? <>
        <h4>版式预览</h4>
        <div className={'video-presentation-stage ' + (page.layout === 'side' ? 'side' : '')}>
          {page.layout === 'side' && <span>录屏画面</span>}
          <article>
            <strong>{page.title}</strong>
            <ul>{page.bullets.map((bullet, i) => <li key={i}>{bullet}</li>)}</ul>
          </article>
        </div>
        <small>导出后在画布节点播放，查看演示动画和旁白同步。</small>
      </> : <p>添加一页，在讲解处穿插标题和要点。</p>}
    </main>
    <aside className="video-edit-clip-settings">
      {page && <>
        <h4>页内容</h4>
        <label>标题<input value={page.title} disabled={locked} onChange={(event) => update({ title: event.target.value })} /></label>
        <label>要点<textarea rows={5} disabled={locked} value={page.bullets.join('\n')}
          onChange={(event) => update({ bullets: event.target.value ? event.target.value.split('\n') : [] })} /></label>
        <small>一行一个要点，最多 4 条。</small>
        <h4>时间与动画</h4>
        <label>起始帧<input type="number" min={0} max={total - 1} value={page.startFrame} disabled={locked}
          onChange={(event) => update({ startFrame: Number(event.target.value) })} /></label>
        <label>结束帧<input type="number" min={1} max={total} value={page.endFrame} disabled={locked}
          onChange={(event) => update({ endFrame: Number(event.target.value) })} /></label>
        <label>版式<select aria-label="版式" value={page.layout} disabled={locked} onChange={(event) => update({ layout: event.target.value })}>
          {Object.entries(LAYOUT).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></label>
        <label>动画<select aria-label="动画" value={page.motion} disabled={locked} onChange={(event) => update({ motion: event.target.value })}>
          {Object.entries(MOTION).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></label>
        <button disabled={locked} onClick={() => onChange(pages.filter((item) => item.id !== page.id))}><Trash2 size={14} />移除演示页</button>
      </>}
    </aside>
  </div>;
}
