import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, Clapperboard, Download, Film, Heart, MapPin, Pencil, Play, Plus, Search, Shirt, Star, Trash2, UserRound, X } from 'lucide-react';
import {
  assetUrl, createDomainEntity, deleteDomainEntity, exportDelivery, searchProject,
  updateDomainEntity, updateProjectMetadata, updateTake,
} from './project-store-http';
import './creative.css';

const LIBRARIES = [
  ['characters', '角色', UserRound], ['outfits', '服装', Shirt], ['locations', '场景', MapPin],
];
const LABELS = { characters: '角色', outfits: '服装', locations: '场景', shots: '镜头' };

function AssetMedia({ project, take, className = '', mediaRef }) {
  const external = take.recipe?.output;
  const localAsset = project.assets.find((asset) => asset.path === take.asset);
  const url = localAsset ? assetUrl(project.id, take.asset) : external?.url;
  const image = localAsset?.mime.startsWith('image/') || /\.(png|jpe?g|webp|gif)(\?|$)/i.test(external?.filename || '');
  const poster = take.poster ? assetUrl(project.id, take.poster) : undefined;
  return image
    ? <img ref={mediaRef} className={className} src={url} alt={`${take.id} 预览`} />
    : <video ref={mediaRef} className={className} src={url} poster={poster} controls playsInline preload="metadata" aria-label={`${take.id} 成片`} />;
}

function EntityEditor({ project, collection, entity, onClose, onSave, busy }) {
  const isShot = collection === 'shots';
  return <div className="creative-editor-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <form className="creative-editor" aria-label={`${entity ? '编辑' : '新建'}${LABELS[collection]}`} onSubmit={(event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const data = Object.fromEntries(form.entries());
      if (!isShot) data.refs = data.refs ? [data.refs] : [];
      if (collection === 'characters') {
        data.defaultOutfitId ||= null; data.sheet ||= null; data.voice ||= null;
      }
      if (collection === 'outfits') data.lora ||= null;
      if (isShot) {
        data.characterId ||= null; data.outfitId ||= null; data.locationId ||= null;
        data.tags = String(data.tags || '').split(/[,，]/).map((tag) => tag.trim()).filter(Boolean);
        data.params = { ratio: data.ratio, resolution: data.resolution, duration: Number(data.duration), seed: Number(data.seed), turbo: data.turbo === 'on' };
        delete data.ratio; delete data.resolution; delete data.duration; delete data.seed; delete data.turbo;
      }
      onSave(data);
    }}>
      <header><strong>{entity ? '编辑' : '新建'}{LABELS[collection]}</strong><button type="button" aria-label="关闭编辑" onClick={onClose}><X size={16} /></button></header>
      {isShot && <label>镜头编号<input name="number" required maxLength={30} defaultValue={entity?.number || `S${String(project.shots.length + 1).padStart(2, '0')}`} /></label>}
      <label>名称<input autoFocus name="name" required maxLength={120} defaultValue={entity?.name || ''} placeholder={`${LABELS[collection]}名称`} /></label>
      {!isShot && <label>参考素材<select name="refs" defaultValue={entity?.refs?.[0] || ''}><option value="">暂不关联素材</option>{project.assets.map((asset) => <option key={asset.path} value={asset.path}>{asset.path.slice(7, 15)} · {asset.mime}</option>)}</select></label>}
      {collection === 'characters' && <label>四视图<select name="sheet" defaultValue={entity?.sheet || ''}><option value="">暂不关联四视图</option>{project.assets.filter((asset) => asset.mime.startsWith('image/')).map((asset) => <option key={asset.path} value={asset.path}>{asset.path.slice(7, 15)} · {asset.mime}</option>)}</select></label>}
      {collection === 'characters' && <label>默认服装<select name="defaultOutfitId" defaultValue={entity?.defaultOutfitId || ''}><option value="">无默认服装</option>{project.outfits.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
      {collection === 'characters' && <label>声音<select name="voice" defaultValue={entity?.voice || ''}><option value="">暂不关联声音</option>{project.assets.filter((asset) => asset.mime.startsWith('audio/')).map((asset) => <option key={asset.path} value={asset.path}>{asset.path.slice(7, 15)} · {asset.mime}</option>)}</select></label>}
      {collection === 'characters' && <label>备注<textarea name="notes" defaultValue={entity?.notes || ''} placeholder="身份、四视图与声音设定" /></label>}
      {(collection === 'outfits' || collection === 'locations') && <label>描述 / 提示词<textarea name="prompt" defaultValue={entity?.prompt || ''} /></label>}
      {collection === 'outfits' && <label>LoRA（可选）<input name="lora" defaultValue={entity?.lora || ''} /></label>}
      {collection === 'locations' && <label>备注<textarea name="notes" defaultValue={entity?.notes || ''} /></label>}
      {isShot && <>
        <label>提示词<textarea name="prompt" required defaultValue={entity?.prompt || ''} placeholder="描述动作、运镜、光线与氛围" /></label>
        <div className="creative-shot-links">
          {[['characterId', '角色', project.characters], ['outfitId', '服装', project.outfits], ['locationId', '场景', project.locations]].map(([name, label, rows]) => <label key={name}>{label}<select name={name} defaultValue={entity?.[name] || ''}><option value="">不指定</option>{rows.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>)}
        </div>
        <div className="creative-shot-links">
          <label>比例<input name="ratio" required defaultValue={entity?.params?.ratio || '16:9'} /></label>
          <label>分辨率<input name="resolution" required defaultValue={entity?.params?.resolution || '480P'} /></label>
          <label>时长（秒）<input name="duration" type="number" required min="0.1" max="300" step="0.1" defaultValue={entity?.params?.duration || 5} /></label>
          <label>Seed<input name="seed" type="number" required min="0" step="1" defaultValue={entity?.params?.seed || 0} /></label>
          <label className="creative-checkbox"><input name="turbo" type="checkbox" defaultChecked={!!entity?.params?.turbo} />快速模式</label>
        </div>
        <label>标签<input name="tags" defaultValue={entity?.tags?.join('，') || ''} placeholder="雨夜，追逐" /></label>
      </>}
      <footer><button type="button" onClick={onClose}>取消</button><button className="primary" type="submit" disabled={busy}>{busy ? '保存中…' : '保存'}</button></footer>
    </form>
  </div>;
}

export default function CreativePanel({ project, onProjectChange, onClose, onLocateShot, onPromote, beforeWrite }) {
  const [tab, setTab] = useState('shots');
  const [collection, setCollection] = useState('characters');
  const [editor, setEditor] = useState(null);
  const [activeShotId, setActiveShotId] = useState(project.shots[0]?.id || null);
  const [compareIds, setCompareIds] = useState([]);
  const [activeTakeId, setActiveTakeId] = useState(null);
  const [minRating, setMinRating] = useState(0);
  const [showRejected, setShowRejected] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [notice, setNotice] = useState('');
  const mediaRefs = useRef(new Map());
  const activeShot = project.shots.find((shot) => shot.id === activeShotId) || project.shots[0];
  const takes = useMemo(() => (activeShot?.takes || []).filter((take) => take.rating >= minRating && (showRejected || !take.rejected)), [activeShot, minRating, showRejected]);
  const compared = takes.filter((take) => compareIds.includes(take.id)).slice(0, 4);
  const activeTake = takes.find((take) => take.id === activeTakeId) || compared[0] || takes[0];

  useEffect(() => {
    if (activeShot && !activeShot.takes.some((take) => compareIds.includes(take.id))) {
      setCompareIds(activeShot.takes.slice(0, 4).map((take) => take.id));
      setActiveTakeId(activeShot.takes[0]?.id || null);
    }
  }, [activeShot?.id, tab]);

  const commit = async (operation, message) => {
    if (busyRef.current) return null;
    busyRef.current = true;
    setBusy(true); setNotice('');
    try {
      const current = (await beforeWrite?.()) || project;
      const result = await operation(current);
      onProjectChange(result.project);
      setNotice(message || '已保存到项目。');
      return result;
    } catch (error) { setNotice(error.message || '保存失败，请重试。'); return null; }
    finally { busyRef.current = false; setBusy(false); }
  };
  const openShot = (id, review = false) => { setActiveShotId(id); setCompareIds([]); setTab(review ? 'review' : 'shots'); };
  const remove = async (itemCollection, id) => {
    const result = await commit((current) => deleteDomainEntity(current, itemCollection, id), '已删除；素材文件仍保留。');
    if (result && itemCollection === 'shots') setActiveShotId(result.project.shots[0]?.id || null);
  };
  const changeTake = (take, patch, message) => commit((current) => updateTake(current, activeShot.id, take.id, patch), message);
  const toggleCompare = (id) => setCompareIds((ids) => ids.includes(id) ? ids.filter((item) => item !== id) : ids.length < 4 ? [...ids, id] : ids);
  const cycleTake = (direction) => {
    if (!takes.length) return;
    const index = Math.max(0, takes.findIndex((take) => take.id === activeTake?.id));
    const next = takes[(index + direction + takes.length) % takes.length];
    setActiveTakeId(next.id);
    if (!compareIds.includes(next.id) && compared.length < 4) setCompareIds([...compareIds, next.id]);
  };
  const syncPlayback = async () => {
    const videos = compared.map((take) => mediaRefs.current.get(take.id)).filter((item) => item?.tagName === 'VIDEO');
    await Promise.all(videos.map((video) => { video.currentTime = 0; return video.play().catch(() => {}); }));
  };
  const search = async (event) => {
    event.preventDefault();
    try { const response = await searchProject(project.id, query); setResults(response.results); }
    catch (error) { setNotice(error.message); }
  };

  return <aside className="creative-panel" aria-label="创作层" onKeyDown={(event) => {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName)) return;
    if (tab === 'review' && event.key === 'ArrowRight') { event.preventDefault(); cycleTake(1); }
    if (tab === 'review' && event.key === 'ArrowLeft') { event.preventDefault(); cycleTake(-1); }
  }}>
    <header className="creative-heading"><div><Clapperboard size={17} /><strong>创作管理</strong></div><button aria-label="关闭创作层" onClick={onClose}><X size={16} /></button></header>
    <nav className="creative-tabs" aria-label="创作层页面">{[['shots', '镜头'], ['library', '素材库'], ['review', '审片'], ['search', '搜索']].map(([id, label]) => <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{label}</button>)}</nav>
    <div className="creative-scroll">
      {tab === 'library' && <>
        <div className="creative-library-tabs">{LIBRARIES.map(([id, label, Icon]) => <button key={id} className={collection === id ? 'active' : ''} onClick={() => setCollection(id)}><Icon size={14} />{label}<small>{project[id].length}</small></button>)}</div>
        <button className="creative-add" disabled={project.readOnly} onClick={() => setEditor({ collection })}><Plus size={14} />新建{LABELS[collection]}</button>
        <div className="creative-entity-list">{project[collection].map((item) => <article key={item.id} className="creative-entity">
          {item.refs?.[0] ? <img src={assetUrl(project.id, item.refs[0])} alt="" /> : <span className="creative-entity-icon">{collection === 'characters' ? <UserRound /> : collection === 'outfits' ? <Shirt /> : <MapPin />}</span>}
          <div><strong>{item.name}</strong><small>{item.id} · {item.notes || item.prompt || '尚未填写描述'}</small></div>
          <button aria-label={`编辑${item.name}`} disabled={project.readOnly} onClick={() => setEditor({ collection, entity: item })}><Pencil size={13} /></button>
          <button aria-label={`删除${item.name}`} disabled={project.readOnly || busy} onClick={() => remove(collection, item.id)}><Trash2 size={13} /></button>
        </article>)}</div>
      </>}
      {tab === 'shots' && <>
        <button className="creative-add" disabled={project.readOnly} onClick={() => setEditor({ collection: 'shots' })}><Plus size={14} />新建镜头</button>
        {onPromote && <button className="creative-promote" disabled={project.readOnly} onClick={onPromote}><Film size={14} />将选中生成节点提升为镜头</button>}
        <div className="creative-shot-list">{project.shots.map((shot) => <article key={shot.id} className={`creative-shot ${activeShot?.id === shot.id ? 'active' : ''}`}>
          <button className="creative-shot-main" onClick={() => openShot(shot.id)}><span>{shot.number}</span><div><strong>{shot.name}</strong><small>{shot.takes.length} 条 Take · {shot.status}</small><p>{shot.prompt}</p></div></button>
          <div className="creative-shot-tags">{shot.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>
          <footer><button onClick={() => openShot(shot.id, true)}><Play size={12} />审片</button><button disabled={!shot.canvasNodeId} onClick={() => onLocateShot?.(shot)}>在画布中打开</button><button aria-label={`编辑${shot.name}`} disabled={project.readOnly} onClick={() => setEditor({ collection: 'shots', entity: shot })}><Pencil size={12} /></button><button aria-label={`删除${shot.name}`} disabled={project.readOnly} onClick={() => remove('shots', shot.id)}><Trash2 size={12} /></button></footer>
        </article>)}</div>
      </>}
      {tab === 'review' && <>
        <label className="creative-review-shot">审片镜头<select value={activeShot?.id || ''} onChange={(event) => openShot(event.target.value, true)}><option value="">请选择镜头</option>{project.shots.map((shot) => <option key={shot.id} value={shot.id}>{shot.number} · {shot.name}</option>)}</select></label>
        {activeShot && <>
          <div className="creative-review-tools"><label>最低评级<select value={minRating} onChange={(event) => setMinRating(Number(event.target.value))}>{[0, 1, 2, 3, 4, 5].map((value) => <option key={value} value={value}>{value} 星及以上</option>)}</select></label><label><input type="checkbox" checked={showRejected} onChange={(event) => setShowRejected(event.target.checked)} />显示淘汰</label><button onClick={syncPlayback} disabled={!compared.length}><Play size={12} />同步播放</button></div>
          <p className="creative-keyboard-hint">勾选 2–4 条对比；← → 切换当前 Take，当前 {activeTake?.id || '无'}</p>
          <div className={`creative-compare count-${compared.length}`}>{compared.map((take) => <article key={take.id} className={activeTake?.id === take.id ? 'active' : ''} onClick={() => setActiveTakeId(take.id)}>
            <AssetMedia project={project} take={take} mediaRef={(node) => node ? mediaRefs.current.set(take.id, node) : mediaRefs.current.delete(take.id)} />
            <strong>{take.id} · {take.rating} 星{take.selected && ' · 已选用'}</strong>
          </article>)}</div>
          <div className="creative-take-list">{takes.map((take) => <article key={take.id} className={`${activeTake?.id === take.id ? 'active' : ''} ${take.rejected ? 'rejected' : ''}`}>
            <label title="加入对比，最多 4 条"><input type="checkbox" aria-label={`对比 ${take.id}`} checked={compareIds.includes(take.id)} onChange={() => toggleCompare(take.id)} /></label>
            <button className="take-focus" onClick={() => setActiveTakeId(take.id)}><strong>{take.id}</strong><small>{take.notes || '未备注'}</small></button>
            <div className="take-stars" aria-label={`${take.id} 评级`}>{[1, 2, 3, 4, 5].map((rating) => <button key={rating} disabled={project.readOnly || busy} aria-label={`${take.id} ${rating} 星`} onClick={() => changeTake(take, { rating })}><Star size={13} fill={rating <= take.rating ? 'currentColor' : 'none'} /></button>)}</div>
            <button className={take.selected ? 'selected' : ''} disabled={project.readOnly || busy || take.rejected} onClick={() => changeTake(take, { selected: true }, `${take.id} 已选用。`)}><Check size={13} />选用</button>
            <button disabled={project.readOnly || busy} onClick={() => changeTake(take, { rejected: !take.rejected, selected: false }, take.rejected ? '已恢复。' : '已淘汰。')}>{take.rejected ? '恢复' : '淘汰'}</button>
            <input aria-label={`${take.id} 备注`} disabled={project.readOnly} defaultValue={take.notes || ''} placeholder="备注" onBlur={(event) => event.target.value !== (take.notes || '') && changeTake(take, { notes: event.target.value })} />
          </article>)}</div>
          <button className="creative-export" disabled={!activeShot.takes.some((take) => take.selected) || busy} onClick={async () => {
            setBusy(true); setNotice('');
            try { const result = await exportDelivery(project.id, activeShot.takes.filter((take) => take.selected).map((take) => take.id)); setNotice(`已导出 ${result.count} 条：${result.path}`); }
            catch (error) { setNotice(error.message); } finally { setBusy(false); }
          }}><Download size={14} />导出本镜头选中成片</button>
        </>}
      </>}
      {tab === 'search' && <>
        <form className="creative-search" onSubmit={search}><Search size={15} /><input aria-label="搜索项目创作内容" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索镜头、提示词、备注、标签" /><button type="submit">搜索</button></form>
        <button className="creative-favorite" disabled={project.readOnly} onClick={() => commit((current) => updateProjectMetadata(current, { favorite: !current.favorite }))}><Heart size={14} fill={project.favorite ? 'currentColor' : 'none'} />{project.favorite ? '已收藏项目' : '收藏项目'}</button>
        <div className="creative-search-results">{results.map((result) => <button key={`${result.kind}-${result.id}`} onClick={() => result.shotId || result.kind === 'shot' ? openShot(result.shotId || result.id, result.kind === 'take') : null}><strong>{result.title}</strong><small>{result.kind} · {result.excerpt}</small></button>)}</div>
      </>}
      {notice && <p className="creative-notice" role="status">{notice}</p>}
    </div>
    {editor && <EntityEditor project={project} collection={editor.collection} entity={editor.entity} busy={busy} onClose={() => setEditor(null)} onSave={async (data) => {
      const result = await commit((current) => editor.entity
        ? updateDomainEntity(current, editor.collection, editor.entity.id, data)
        : createDomainEntity(current, editor.collection, data));
      if (result) { if (editor.collection === 'shots' && !editor.entity) setActiveShotId(result.item.id); setEditor(null); }
    }} />}
  </aside>;
}
