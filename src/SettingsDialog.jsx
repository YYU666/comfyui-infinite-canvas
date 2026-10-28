import React, { useEffect, useState } from 'react';
import { AlertCircle, Check, LoaderCircle, Settings2, X } from 'lucide-react';
import { getSettings, updateSettings } from './settings-client';

const KEY_SOURCES = { environment: '环境变量', keyring: '系统密钥库', file: '本机受保护文件', none: '未配置' };

export default function SettingsDialog({ onClose, onSaved }) {
  const [settings, setSettings] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    getSettings().then((result) => { if (active) setSettings(result); })
      .catch((reason) => { if (active) setError(reason.message); });
    return () => { active = false; };
  }, []);

  const save = async (event) => {
    event.preventDefault();
    if (busy || !settings) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const payload = {
      projectsRoot: String(form.get('projectsRoot') || '').trim(),
      comfyRoot: String(form.get('comfyRoot') || '').trim(),
      modelRoots: String(form.get('modelRoots') || '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean),
      defaults: {
        ratio: form.get('ratio'), resolution: form.get('resolution'), duration: Number(form.get('duration')),
      },
      queue: { concurrency: Number(form.get('concurrency')) },
      notifications: form.get('notifications') === 'on',
      logLevel: form.get('logLevel'),
    };
    const key = String(form.get('deepseekKey') || '').trim();
    if (key) payload.deepseekKey = key;
    setBusy(true); setError('');
    try {
      const result = await updateSettings(payload);
      formElement.reset();
      await onSaved(result);
      onClose();
    } catch (reason) { setError(reason.message); }
    finally { setBusy(false); }
  };

  return <div className="launcher-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <form className="launcher-modal settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-dialog-title" aria-busy={busy || !settings} onSubmit={save}>
      <button type="button" className="modal-close" aria-label="关闭设置" disabled={busy} onClick={onClose}><X size={17} /></button>
      <span className="modal-icon"><Settings2 size={22} /></span>
      <h2 id="settings-dialog-title">工作台设置</h2>
      {!settings && !error && <div className="doctor-loading"><LoaderCircle className="spin" size={24} /><span>正在读取本机设置…</span></div>}
      {settings && <div className="settings-content">
        <section className="settings-section"><h3>存储与运行环境</h3>
          <label>项目根目录<input name="projectsRoot" required defaultValue={settings.projectsRoot} /></label>
          <p className="modal-help">切换后只读取新目录，不会移动或删除旧项目；打开中的项目或活动队列会阻止切换。</p>
          <label>ComfyUI 便携版根目录<input name="comfyRoot" required defaultValue={settings.comfyRoot} /></label>
          <p className="modal-help">目录中必须包含 ComfyUI\main.py。保存不会重启当前 ComfyUI，新路径将在下次由工作台启动时生效。</p>
          <label>额外模型根目录（每行一个）<textarea name="modelRoots" rows={3} defaultValue={settings.modelRoots.join('\n')} placeholder="留空则自动读取 ComfyUI 的模型目录配置" /></label>
        </section>
        <section className="settings-section"><h3>新建项目默认参数</h3>
          <div className="settings-grid">
            <label>画面比例<select name="ratio" defaultValue={settings.defaults.ratio}>{['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'].map((value) => <option key={value}>{value}</option>)}</select></label>
            <label>分辨率<select name="resolution" defaultValue={settings.defaults.resolution}>{['480P', '720P', '1080P'].map((value) => <option key={value}>{value}</option>)}</select></label>
            <label>时长（秒）<input name="duration" type="number" min={4} max={15} step={1} required defaultValue={settings.defaults.duration} /></label>
            <label>队列并发<select name="concurrency" defaultValue={settings.queue.concurrency}><option value={1}>1（推荐）</option><option value={2}>2</option></select></label>
            <label>日志级别<select name="logLevel" defaultValue={settings.logLevel}>{['DEBUG', 'INFO', 'WARNING', 'ERROR'].map((value) => <option key={value}>{value}</option>)}</select></label>
            <label className="settings-checkbox"><input name="notifications" type="checkbox" defaultChecked={settings.notifications} /><span>启用任务完成通知</span></label>
          </div>
        </section>
        <section className="settings-section"><h3>DeepSeek 提示词优化</h3>
          <p className="settings-key-status">当前状态：{settings.deepseek.configured ? '已配置' : '未配置'} · {KEY_SOURCES[settings.deepseek.source] || settings.deepseek.source}</p>
          <label>更新 API Key（留空表示不修改）<input name="deepseekKey" type="password" autoComplete="new-password" placeholder="不会读取或回显已保存的密钥" /></label>
          <p className="modal-help">密钥不会写入 config.json，也不会出现在接口响应、诊断报告或日志包中。</p>
        </section>
      </div>}
      {error && <div className="settings-error" role="alert"><AlertCircle size={15} /><span>{error}</span></div>}
      <div className="modal-actions"><button type="button" disabled={busy} onClick={onClose}>取消</button><button className="primary" disabled={busy || !settings} type="submit">{busy ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}保存设置</button></div>
    </form>
  </div>;
}
