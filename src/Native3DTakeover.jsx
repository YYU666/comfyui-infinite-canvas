import React, { useState } from 'react';
import { nativeAssetUrl } from './native3d.js';
import './Native3DTakeover.css';

function Parameter({ field, disabled, change }) {
  const { key, label, value, rule } = field;
  if (rule.type === 'boolean') return <label className="takeover-parameter">
    <span>{label}</span><input type="checkbox" checked={value} disabled={disabled} onChange={event => change(key, event.target.checked)} />
  </label>;
  if (rule.enum) return <label className="takeover-parameter">
    <span>{label}</span><select value={value} disabled={disabled} onChange={event => change(key, rule.type === 'integer' || rule.type === 'number' ? Number(event.target.value) : event.target.value)}>
      {rule.enum.map(option => <option key={option} value={option}>{option}</option>)}
    </select>
  </label>;
  return <label className="takeover-parameter">
    <span>{label}</span><input type="number" value={value} min={rule.minimum} max={rule.maximum}
      step={rule.type === 'integer' ? 1 : 'any'} disabled={disabled}
      onChange={event => { if (event.target.value !== '' && event.target.validity.valid) change(key, Number(event.target.value)); }} />
  </label>;
}

const visibleParameters = {
  uv_plan: ['resolution', 'padding', 'chartMergeCost'],
  uv: ['resolution', 'padding', 'seamStrategy'],
  source_lod: ['lodCount', 'selectedLodLevel'],
  repair_lod: ['lodCount'],
  bake: ['resolution', 'padding', 'aoSamples'],
  material_wear: ['strength'],
};

export default function Native3DTakeover({ api, state, objects }) {
  const [action, setAction] = useState('');
  const [error, setError] = useState('');
  const disabled = api.readOnly || state.busy || Boolean(action);
  const primaryKeys = new Set(visibleParameters[state.operation] || state.fields.slice(0, 3).map(field => field.key));
  const primary = state.fields.filter(field => primaryKeys.has(field.key));
  const advanced = state.fields.filter(field => !primaryKeys.has(field.key));
  const fieldRow = field => <Parameter key={field.key} field={field} disabled={disabled} change={setParameter} />;
  async function perform(name, callback) {
    setAction(name);
    setError('');
    try { await callback(); }
    catch (error) { setError(error.message); }
    finally { setAction(''); }
  }
  const setParameter = (key, value) => {
    try { api.parameter(state.processorId, key, value); setError(''); }
    catch (error) { setError(error.message); }
  };
  return <aside className="native3d-takeover-sidebar" aria-label="模型接手详情">
    <section>
      <h3>来源与步骤</h3>
      <dl>
        <dt>当前步骤</dt><dd>{state.step}</dd>
        <dt>查看对象</dt><dd>{state.preview?.title || state.title}{state.preview && <small>{state.preview.sourceLabel}</small>}</dd>
        {state.sources.map(source => <React.Fragment key={source.label}><dt>{source.label}</dt><dd>{source.title}</dd></React.Fragment>)}
      </dl>
      {state.preview && <a href={nativeAssetUrl(api.projectId, state.preview.path)} download>下载当前模型</a>}
    </section>
    <section>
      <h3>对象</h3>
      {objects.length ? <ul>{objects.map((object, index) => <li key={index}>{object.name} <small>{object.triangles.toLocaleString()} 三角面</small></li>)}</ul> : <p>等待读取模型</p>}
    </section>
    <section>
      <h3>参数 <span className="takeover-status" data-state={state.pending ? 'pending' : undefined}>
        {state.busy ? '任务进行中' : state.pending ? '待重算' : state.lastSuccess ? '已对齐最近成功' : '未运行'}
      </span></h3>
      {state.fields.length ? primary.map(fieldRow) : <p>本步骤暂无可调参数。</p>}
      {advanced.length > 0 && <details className="takeover-advanced"><summary>更多参数</summary>{advanced.map(fieldRow)}</details>}
      {state.changed.length > 0 && <ul aria-label="参数改动">
        {state.changed.map(field => <li key={field.key}>{field.label} {String(field.baseline)} → {String(field.value)}</li>)}
      </ul>}
      {state.fields.length > 0 && <div className="takeover-actions">
        <button type="button" disabled={disabled || !state.changed.length} onClick={() => void perform('revert', async () => {
          for (const field of state.changed) api.parameter(state.processorId, field.key, field.baseline);
          await api.persist();
        })}>回退改动</button>
        <button type="button" disabled={disabled} onClick={() => void perform('save', api.persist)}>保存参数</button>
        <button type="button" disabled={disabled || !state.ready} onClick={() => void perform('run', () => api.run(state.processorId))}>运行此步骤</button>
      </div>}
      {state.fields.length > 0 && state.runBlock && <p role="status">{state.runBlock}</p>}
      {error && <p role="alert">{error}</p>}
    </section>
    <section aria-label="运行回执">
      <h3>运行回执</h3>
      <dl>
        <dt>最近成功</dt><dd>{state.lastSuccess ? <><code>{state.lastSuccess.jobId}</code><small>{state.lastSuccess.stage || '结果已保存'}</small></> : '尚无已交付结果'}</dd>
        <dt>当前任务</dt><dd>{state.receipt.jobId && (state.receipt.jobId !== state.lastSuccess?.jobId || state.busy) ? <><code>{state.receipt.jobId}</code>
          <small>{[state.receipt.stage, state.receipt.backendStatus, state.receipt.progress !== null ? state.receipt.progress + '%' : null].filter(Boolean).join(' · ')}</small></> : state.pending ? '这次改动尚未提交' : '无进行中的任务'}</dd>
        {state.receipt.error && <><dt>任务错误</dt><dd>{state.receipt.error}</dd></>}
      </dl>
    </section>
  </aside>;
}
