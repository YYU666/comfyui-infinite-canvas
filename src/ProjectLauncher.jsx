import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle, ArrowDownToLine, Box, Check, ChevronRight, Clock3, Copy, FilePlus2, Film,
  Folder, FolderOpen, Grid2X2, HardDrive, Image as ImageIcon, LayoutGrid, List, LoaderCircle,
  MoreHorizontal, Pencil, Plus, RefreshCw, RotateCcw, Search, Settings2, ShieldCheck, Sparkles,
  SquareArrowOutUpRight, Trash2, WandSparkles, X,
} from 'lucide-react';
import {
  createProject, deleteProject, duplicateProject, exportProject, importProject, listProjects,
  openProject, openProjectPath, renameProject, restoreProject, revealProject,
} from './project-store-http';
import { listLegacyProjects, migrateLegacyProjects } from './legacy-migration';
import './launcher.css';

const TEMPLATES = [
  { id: 'blank', name: '空白画布', description: '从自由节点开始，适合探索与整理已有素材。', icon: Box, mode: null },
  { id: 'text', name: '文生视频', description: '预置全能参考生成器，直接输入创意开始。', icon: Film, mode: 'reference', title: '全能参考' },
  { id: 'swap', name: '角色替换', description: '预置逐帧角色替换工作流，保留原视频音轨。', icon: WandSparkles, mode: 'swap', title: '精准角色替换' },
  { id: 'outfit', name: '换装四视图', description: '预置无抠图换装节点，适配多种角色图版面。', icon: ImageIcon, mode: 'outfitEdit', title: '无抠图换装' },
  { id: 'image', name: '图生图', description: '预置本地生图节点，用于人物、场景和风格探索。', icon: Sparkles, mode: 'image', title: '本地生图' },
  { id: 'upscale', name: '图片高清', description: '预置独立高清节点，适用于低于 1K 的图片。', icon: SquareArrowOutUpRight, mode: 'imageUpscale', title: '图片高清' },
];

function templateCanvas(template) {
  if (!template.mode) return { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
  return { nodes: [{ id: 'main-generator', type: 'generator', position: { x: 160, y: 120 }, data: { title: template.title, mode: template.mode, prompt: '', status: 'idle', runs: [] } }], edges: [], viewport: { x: 0, y: 0, zoom: 0.9 } };
}

const SECTIONS = [
  ['recent', '最近项目', Clock3], ['all', '全部项目', Folder], ['templates', '项目模板', LayoutGrid], ['trash', '回收站', Trash2],
];
const formatBytes = (bytes) => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${Math.max(0, Math.round((bytes || 0) / 1024))} KB`;
const formatDate = (value) => value ? new Date(value).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';

export default function ProjectLauncher({ onOpen }) {
  const [section, setSection] = useState('recent');
  const [projects, setProjects] = useState([]);
  const [trash, setTrash] = useState([]);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('updated');
  const [view, setView] = useState('list');
  const [selectedId, setSelectedId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState(null);
  const [dialog, setDialog] = useState(null);
  const [legacyCount, setLegacyCount] = useState(0);
  const fileInput = useRef(null);
  const operationRef = useRef('');

  const refresh = useCallback(async () => {
    try {
      const [rows, removed] = await Promise.all([listProjects(), listProjects({ trash: true })]);
      setProjects(rows); setTrash(removed); setNotice((current) => current?.type === 'error' ? null : current);
    } catch (error) { setNotice({ type: 'error', text: error.message }); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => { listLegacyProjects().then((rows) => setLegacyCount(rows.length)).catch(() => setLegacyCount(0)); }, []);

  const visible = useMemo(() => {
    const source = section === 'trash' ? trash : section === 'recent' ? projects.slice(0, 8) : projects;
    return source.filter((project) => `${project.name} ${project.path || ''}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
      .sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name, 'zh-CN') : sort === 'size' ? b.bytes - a.bytes : new Date(b.updatedAt) - new Date(a.updatedAt));
  }, [section, projects, trash, query, sort]);
  const selected = [...projects, ...trash].find((project) => project.id === selectedId);

  const perform = async (label, action, success) => {
    if (operationRef.current) return null;
    operationRef.current = label;
    setBusy(label); setNotice(null);
    try {
      const result = await action();
      await refresh();
      if (success) setNotice({ type: 'success', text: typeof success === 'function' ? success(result) : success });
      return result;
    } catch (error) { setNotice({ type: 'error', text: error.message }); return null; }
    finally { operationRef.current = ''; setBusy(''); }
  };
  const open = (project) => perform(`open-${project.id}`, async () => {
    const document = await openProject(project.id);
    onOpen(document);
    return document;
  });
  const create = async (name, template, directory) => {
    const preset = TEMPLATES.find((item) => item.id === template) || TEMPLATES[0];
    const document = await perform('create', () => createProject(name, templateCanvas(preset), preset.id, directory || undefined));
    if (document) {
      setDialog(null);
      const opened = await openProject(document.id);
      onOpen(opened);
    }
  };
  const migrate = () => perform('migrate', async () => {
    const result = await migrateLegacyProjects(({ index, total, name }) => setNotice({ type: 'progress', text: total ? `正在迁移 ${index + 1}/${total}：${name || '校验完成'}` : '正在读取旧项目…' }));
    if (result.failed.length) throw new Error(`已迁移 ${result.migrated.length} 个；${result.failed.map((item) => `${item.name}：${item.error}`).join('；')}`);
    setLegacyCount(0);
    return result;
  }, (result) => `已迁移 ${result.migrated.length} 个浏览器项目，原记录与 ZIP 备份均已保留。`);

  const submitDialog = async (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    if (dialog.type === 'new') return create(data.get('name'), data.get('template'), data.get('directory')?.trim());
    if (dialog.type === 'rename') {
      const result = await perform('rename', () => renameProject(dialog.project, data.get('name')), '项目已重命名。');
      if (result) setDialog(null);
    }
    if (dialog.type === 'open-path') {
      const result = await perform('open-path', () => openProjectPath(data.get('path').trim()));
      if (result) { setDialog(null); onOpen(result); }
    }
    if (dialog.type === 'delete') {
      const result = await perform('delete', () => deleteProject(dialog.project.id), '项目已移入回收站，可随时恢复。');
      if (result) { setDialog(null); setSelectedId(null); }
    }
  };

  return <div className="launcher-shell">
    <aside className="launcher-sidebar">
      <div className="launcher-brand"><span>H<b>3</b></span><div><strong>视频工作台</strong><small>本地创作空间</small></div></div>
      <button className="launcher-new" onClick={() => setDialog({ type: 'new', template: 'blank' })}><Plus size={17} />新建项目</button>
      <nav aria-label="项目导航">{SECTIONS.map(([id, label, Icon]) => <button key={id} className={section === id ? 'active' : ''} onClick={() => { setSection(id); setSelectedId(null); }}><Icon size={16} /><span>{label}</span>{id === 'all' && <small>{projects.length}</small>}{id === 'trash' && <small>{trash.length}</small>}</button>)}</nav>
      <div className="launcher-sidebar-bottom">
        <button disabled title="设置将在下一阶段提供"><Settings2 size={15} />设置<span>M2</span></button>
        <button disabled title="诊断将在下一阶段提供"><ShieldCheck size={15} />诊断<span>M2</span></button>
        <div className="launcher-local"><i /><span>仅在本机运行<small>H3 Workbench · v1.0.0</small></span></div>
      </div>
    </aside>

    <main className="launcher-main">
      <header className="launcher-topbar">
        <div><p>项目</p><h1>{SECTIONS.find(([id]) => id === section)?.[1] || '项目模板'}</h1></div>
        <div className="launcher-top-actions">
          <button onClick={() => setDialog({ type: 'open-path' })}><FolderOpen size={15} />打开文件夹</button>
          <button onClick={() => fileInput.current?.click()}><ArrowDownToLine size={15} />导入项目</button>
          <input ref={fileInput} hidden type="file" accept=".zip,application/zip" onChange={async (event) => {
            const file = event.target.files?.[0]; event.target.value = '';
            if (file) await perform('import', () => importProject(file), '项目包已导入。');
          }} />
        </div>
      </header>

      {legacyCount > 0 && <section className="migration-banner">
        <div><HardDrive size={19} /><span><strong>发现 {legacyCount} 个旧浏览器项目</strong><small>迁移到磁盘前会保留 ZIP 备份，原浏览器记录不会删除。</small></span></div>
        <button disabled={!!busy} onClick={migrate}>{busy === 'migrate' ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}迁移到项目文件夹</button>
      </section>}
      {notice && <div className={`launcher-notice ${notice.type}`} role={notice.type === 'error' ? 'alert' : 'status'}>{notice.type === 'error' ? <AlertCircle size={16} /> : notice.type === 'success' ? <Check size={16} /> : <LoaderCircle className="spin" size={16} />}<span>{notice.text}</span><button aria-label="关闭提示" onClick={() => setNotice(null)}><X size={14} /></button></div>}

      {section === 'templates' ? <section className="template-grid" aria-label="项目模板">{TEMPLATES.map((template) => <button key={template.id} onClick={() => setDialog({ type: 'new', template: template.id })}>
        <span className="template-icon"><template.icon size={23} /></span><strong>{template.name}</strong><p>{template.description}</p><span className="template-use">使用模板<ChevronRight size={14} /></span>
      </button>)}</section> : <>
        <div className="launcher-toolbar">
          <label className="launcher-search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索项目名称或路径" aria-label="搜索项目" /></label>
          <select value={sort} onChange={(event) => setSort(event.target.value)} aria-label="项目排序"><option value="updated">按修改时间</option><option value="name">按名称</option><option value="size">按占用空间</option></select>
          <div className="view-switch"><button className={view === 'list' ? 'active' : ''} onClick={() => setView('list')} aria-label="列表视图"><List size={16} /></button><button className={view === 'grid' ? 'active' : ''} onClick={() => setView('grid')} aria-label="网格视图"><Grid2X2 size={16} /></button></div>
          <button className="icon-action" onClick={refresh} aria-label="刷新项目"><RefreshCw size={16} /></button>
        </div>
        <section className={`project-collection ${view}`} aria-label={section === 'trash' ? '回收站项目' : '磁盘项目'}>
          {view === 'list' && <div className="project-table-head"><span>名称</span><span>修改时间</span><span>内容</span><span>大小</span><span /></div>}
          {visible.map((project) => <article key={project.trashName || project.id} className={`project-entry ${selectedId === project.id ? 'selected' : ''}`} onClick={() => setSelectedId(project.id)} onDoubleClick={() => section !== 'trash' && open(project)}>
            <div className="project-cover">{project.thumbnail ? <img src={project.thumbnail} alt="" /> : <Folder size={22} />}</div>
            <div className="project-identity"><strong>{project.name}</strong><small>{project.path}</small></div>
            <time>{formatDate(section === 'trash' ? project.deletedAt : project.updatedAt)}</time>
            <span className="project-counts">{project.shotCount} 镜头 · {project.nodeCount} 节点</span>
            <span className="project-size">{formatBytes(project.bytes)}</span>
            <div className="project-row-actions">
              {section === 'trash' ? <button disabled={!!busy} onClick={(event) => { event.stopPropagation(); perform('restore', () => restoreProject(project.trashName), '项目已恢复。'); }}><RotateCcw size={14} />恢复</button> : <>
                <button className="project-open" disabled={!!busy} onClick={(event) => { event.stopPropagation(); open(project); }}>{busy === `open-${project.id}` ? <LoaderCircle className="spin" size={14} /> : <FolderOpen size={14} />}打开</button>
                <button className="icon-action" aria-label={`更多操作：${project.name}`} onClick={(event) => { event.stopPropagation(); setSelectedId(project.id); }}><MoreHorizontal size={17} /></button>
              </>}
            </div>
          </article>)}
          {!loading && !visible.length && <div className="launcher-empty"><FolderOpen size={35} /><h2>{query ? '没有匹配的项目' : section === 'trash' ? '回收站是空的' : '从第一个本地项目开始'}</h2><p>{query ? '尝试更换关键词或清除搜索。' : section === 'trash' ? '删除的项目会保留在这里，可恢复或 30 天后清理。' : '项目、素材和画布都会保存在磁盘文件夹中。'}</p>{!query && section !== 'trash' && <div><button onClick={() => setDialog({ type: 'new', template: 'blank' })}><Plus size={15} />新建项目</button><button onClick={() => fileInput.current?.click()}><ArrowDownToLine size={15} />导入项目</button><button onClick={() => setDialog({ type: 'new', template: 'text' })}><FilePlus2 size={15} />载入示例</button></div>}</div>}
          {loading && <div className="launcher-empty"><LoaderCircle className="spin" size={28} /><p>正在读取本地项目…</p></div>}
        </section>
      </>}
      <footer className="launcher-status"><span><i />项目由本地后端管理</span><span>{visible.length} 个项目{busy && ` · 正在处理 ${busy}`}</span></footer>
    </main>

    {selected && section !== 'templates' && <aside className="project-details">
      <div className="details-heading"><span>项目详情</span><button aria-label="关闭项目详情" onClick={() => setSelectedId(null)}><X size={16} /></button></div>
      <div className="details-cover">{selected.thumbnail ? <img src={selected.thumbnail} alt="项目封面" /> : <Folder size={36} />}</div>
      <h2>{selected.name}</h2><p className="details-path">{selected.path}</p>
      <dl><div><dt>修改时间</dt><dd>{formatDate(selected.updatedAt)}</dd></div><div><dt>项目内容</dt><dd>{selected.shotCount} 镜头 · {selected.nodeCount} 节点</dd></div><div><dt>占用空间</dt><dd>{formatBytes(selected.bytes)}</dd></div><div><dt>版本</dt><dd>revision {selected.revision}</dd></div></dl>
      {section === 'trash' ? <button className="details-primary" onClick={() => perform('restore', () => restoreProject(selected.trashName), '项目已恢复。')}><RotateCcw size={15} />恢复项目</button> : <div className="details-actions">
        <button className="details-primary" onClick={() => open(selected)}><FolderOpen size={15} />打开项目</button>
        <button onClick={() => perform('reveal', () => revealProject(selected.id))}><SquareArrowOutUpRight size={15} />在资源管理器显示</button>
        <button onClick={() => setDialog({ type: 'rename', project: selected })}><Pencil size={15} />重命名</button>
        <button onClick={() => perform('duplicate', () => duplicateProject(selected.id), '项目副本已创建。')}><Copy size={15} />创建副本</button>
        <button onClick={() => perform('export', () => exportProject(selected.id), (result) => `已导出：${result.path}`)}><ArrowDownToLine size={15} />导出 ZIP</button>
        <button className="danger" onClick={() => setDialog({ type: 'delete', project: selected })}><Trash2 size={15} />移入回收站</button>
      </div>}
    </aside>}

    {dialog && <div className="launcher-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setDialog(null); }}>
      <form className="launcher-modal" role="dialog" aria-modal="true" aria-labelledby="launcher-dialog-title" onSubmit={submitDialog}>
        <button type="button" className="modal-close" aria-label="关闭对话框" onClick={() => setDialog(null)}><X size={17} /></button>
        <span className="modal-icon">{dialog.type === 'delete' ? <Trash2 size={22} /> : dialog.type === 'open-path' ? <FolderOpen size={22} /> : <FilePlus2 size={22} />}</span>
        <h2 id="launcher-dialog-title">{{ new: '新建本地项目', rename: '重命名项目', 'open-path': '打开项目文件夹', delete: '移入回收站' }[dialog.type]}</h2>
        {dialog.type === 'new' && <>
          <label>项目名称<input autoFocus name="name" required maxLength={80} defaultValue="未命名项目" /></label>
          <label>项目模板<select name="template" defaultValue={dialog.template}>{TEMPLATES.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}</select></label>
          <label>保存位置（可选）<input name="directory" placeholder="留空则保存到 文档 / H3 Workbench / 项目名称" /></label>
          <p className="modal-help">自定义位置必须位于默认项目根目录中；同名文件夹不会被覆盖。</p>
        </>}
        {dialog.type === 'rename' && <label>项目名称<input autoFocus name="name" required maxLength={80} defaultValue={dialog.project.name} /></label>}
        {dialog.type === 'open-path' && <><label>项目文件夹路径<input autoFocus name="path" required placeholder="例如：D:\\Projects\\我的项目" /></label><p className="modal-help">文件夹中必须包含有效的 project.json；已有项目不会被覆盖。</p></>}
        {dialog.type === 'delete' && <p className="delete-confirmation">确定将“{dialog.project.name}”移入回收站吗？项目文件和素材仍保留，可以从回收站恢复。</p>}
        <div className="modal-actions"><button type="button" onClick={() => setDialog(null)}>取消</button><button className={dialog.type === 'delete' ? 'danger' : 'primary'} disabled={!!busy} type="submit">{busy ? <LoaderCircle className="spin" size={15} /> : dialog.type === 'delete' ? <Trash2 size={15} /> : <Check size={15} />}{dialog.type === 'delete' ? '移入回收站' : '确定'}</button></div>
      </form>
    </div>}
  </div>;
}
