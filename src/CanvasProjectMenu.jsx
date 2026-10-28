import React, { useEffect, useRef, useState } from 'react';
import { AlertCircle, Check, ChevronDown, Image as ImageIcon, LoaderCircle, Plus, Search } from 'lucide-react';

export default function CanvasProjectMenu({ current, projects, name, onNameChange, saveState, error, busy, locked, onRefresh, onOpen, onCreate }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [savedNoticeVisible, setSavedNoticeVisible] = useState(false);
  const container = useRef(null);
  const previousSaveState = useRef(saveState);
  useEffect(() => {
    const justSaved = previousSaveState.current === '保存中' && saveState === '已保存' && !error;
    previousSaveState.current = saveState;
    if (!justSaved) {
      if (saveState === '保存中' || error) setSavedNoticeVisible(false);
      return undefined;
    }
    setSavedNoticeVisible(true);
    const timer = setTimeout(() => setSavedNoticeVisible(false), 1800);
    return () => clearTimeout(timer);
  }, [saveState, error]);
  useEffect(() => {
    if (!open) return undefined;
    const close = (event) => {
      if (event.type === 'keydown' ? event.key === 'Escape' : !container.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', close); };
  }, [open]);
  const show = () => {
    if (!open) onRefresh();
    setOpen(!open);
  };
  const create = async (event) => {
    event.preventDefault();
    if (await onCreate('未命名画布')) setOpen(false);
  };
  return <div className="canvas-project-control" ref={container}>
    <div className="neo-project-pill">
      <span className="neo-logo">H<b>3</b></span>
      <i />
      <input value={name} onChange={(event) => onNameChange(event.target.value)} disabled={busy} aria-label="画布项目名称" maxLength={120} />
      <button className="project-list-toggle" onClick={show} aria-label="项目列表" aria-expanded={open} aria-controls="canvas-project-list"><ChevronDown size={13} style={{ transform: open ? 'rotate(180deg)' : undefined }} /></button>
      <span className={`save-indicator ${error ? 'failed' : ''}`} title={saveState} aria-label={saveState}>{error ? <AlertCircle size={13} /> : saveState === '保存中' ? <LoaderCircle size={13} className="spin" /> : <Check size={13} />}</span>
    </div>
    {savedNoticeVisible && <div className="autosave-complete" role="status"><Check size={13} />画布已自动保存</div>}
    {open && <section id="canvas-project-list" className="canvas-project-panel" aria-label="项目列表面板">
      <label className="project-search"><Search size={15} /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索画布" aria-label="搜索画布" /></label>
      <div className="project-filters" role="tablist" aria-label="画布类型">{[['all', '全部'], ['personal', '个人'], ['shared', '协作']].map(([value, label]) => <button key={value} role="tab" aria-selected={filter === value} onClick={() => setFilter(value)}>{label}</button>)}</div>
      <div className="project-list" aria-label="已保存项目">
        {filter !== 'shared' && projects.filter((project) => (project.id === current.id ? name : project.name).toLocaleLowerCase().includes(query.toLocaleLowerCase())).map((project) => <button
          key={project.id} className={`project-row ${project.id === current.id ? 'current' : ''}`}
          aria-label={`打开项目：${project.name}`} aria-current={project.id === current.id ? 'page' : undefined}
          disabled={busy || locked || project.id === current.id}
          onClick={async () => { if (await onOpen(project.id)) setOpen(false); }}>
          <span className="project-row-icon">{project.thumbnail ? <img src={project.thumbnail} alt="" /> : <ImageIcon size={18} />}</span>
          <span className="project-row-copy"><strong>{project.id === current.id ? name || '未命名项目' : project.name}</strong><small>{project.nodeCount} 个节点 · {new Date(project.updatedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</small></span>
          {project.id === current.id && <Check size={16} className="project-current" aria-label="当前画布" />}
        </button>)}
        {filter === 'shared' ? <p className="project-empty">暂无协作画布<br /><small>当前项目保存在此浏览器中。</small></p> : !projects.some((project) => (project.id === current.id ? name : project.name).toLocaleLowerCase().includes(query.toLocaleLowerCase())) && <p className="project-empty">没有找到这个画布</p>}
      </div>
      <div className="project-create"><button type="button" disabled={busy || locked} onClick={create}><Plus size={16} />新建画布</button></div>
      <p className="project-storage-note">{locked ? '任务进行中，完成后即可新建或切换项目。' : '自动保存在此浏览器。新建项目会保留当前画布。'}</p>
    </section>}
    {error && <div className="project-save-error" role="alert">{error}</div>}
  </div>;
}
