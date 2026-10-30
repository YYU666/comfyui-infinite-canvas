import React, { useState } from 'react';
import { AlertCircle, ArrowLeftRight, Check, LoaderCircle, Pause, Play, X } from 'lucide-react';

const EMPTY_HANDOFF = { status: 'active', agent: '', objective: '', acceptance: '', notes: '', updatedAt: null };

export default function HandoffDialog({ project, onClose, onSaved }) {
  const [form, setForm] = useState({ ...EMPTY_HANDOFF, ...(project.settings?.handoff || {}) });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (key, value) => setForm((current) => ({ ...current, [key]: value }));

  const save = async (event, status = form.status) => {
    event?.preventDefault();
    if (busy) return;
    setBusy(true); setError('');
    try {
      const next = await onSaved({ agent: form.agent, objective: form.objective, acceptance: form.acceptance, notes: form.notes, status });
      setForm({ ...EMPTY_HANDOFF, ...(next.settings?.handoff || {}) });
    } catch (reason) { setError(reason.message || '接力信息保存失败。'); }
    finally { setBusy(false); }
  };

  return <div className="launcher-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <form className="launcher-modal settings-modal" role="dialog" aria-modal="true" aria-labelledby="handoff-dialog-title" aria-busy={busy} onSubmit={save}>
      <button type="button" className="modal-close" aria-label="关闭接力" disabled={busy} onClick={onClose}><X size={17} /></button>
      <span className="modal-icon"><ArrowLeftRight size={22} /></span>
      <h2 id="handoff-dialog-title">Agent 接力</h2>
      <div className="settings-content">
        <section className="settings-section">
          <h3>{form.status === 'paused' ? '已暂停接管' : '允许接力'} · {form.agent || '尚未指定 Agent'}</h3>
          <p className="modal-help">Kimi、GPT、Codex 等连接同一项目即可读取这些记录。暂停只是协调信号，不取消活动任务，也不替代保存冲突保护。</p>
          <label>接管 Agent 名称<input name="agent" maxLength={80} value={form.agent} onChange={(event) => set('agent', event.target.value)} placeholder="例如：Kimi / GPT / Codex" /></label>
          <label>当前目标<input name="objective" required maxLength={2000} value={form.objective} onChange={(event) => set('objective', event.target.value)} placeholder="下一位 Agent 需要完成什么" /></label>
          <label>验收标准<textarea name="acceptance" rows={3} maxLength={2000} value={form.acceptance} onChange={(event) => set('acceptance', event.target.value)} placeholder="怎样算完成；哪些结果不能改动" /></label>
          <label>已验证结论与下一步<textarea name="notes" rows={5} maxLength={4000} value={form.notes} onChange={(event) => set('notes', event.target.value)} placeholder="记录已验证事实、失败尝试、活动任务和建议下一步" /></label>
          {form.updatedAt && <p className="modal-help">上次保存：{new Date(form.updatedAt).toLocaleString()}</p>}
        </section>
      </div>
      {error && <div className="settings-error" role="alert"><AlertCircle size={15} /><span>{error}</span></div>}
      <div className="modal-actions">
        <button type="button" disabled={busy} onClick={onClose}>关闭</button>
        <button type="button" disabled={busy} onClick={(event) => save(event, form.status === 'paused' ? 'active' : 'paused')}>
          {form.status === 'paused' ? <Play size={15} /> : <Pause size={15} />}{form.status === 'paused' ? '恢复接力' : '暂停并交接'}
        </button>
        <button className="primary" disabled={busy} type="submit">{busy ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}保存接力</button>
      </div>
    </form>
  </div>;
}
