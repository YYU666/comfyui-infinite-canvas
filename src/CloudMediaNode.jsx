import React, { useEffect, useRef, useState } from 'react';
import { Handle, Position, useUpdateNodeInternals } from '@xyflow/react';
import { cloudProfiles, configureCloud, cloudJob, refreshCloud, cloudMediaPorts, cloudPortLabels } from './cloud-media.js';
import './cloud-media.css';

const STATE_LABELS = {
  submitting: '正在提交', submission_unknown: '提交结果未确认。请先向供应商核对订单。',
  missing: '当前项目没有查到提交记录。请先核对供应商订单。',
  pending: '已取得任务号，等待查询', queued: '已排队', running: '生成中',
  download_pending: '供应商已返回媒体，等待取回', failed: '供应商报告任务失败',
  done: '媒体已准备好', rejected: '供应商已拒绝本次请求。',
};
const REJECTION_LABELS = {
  request: '请检查模型、提示词及参数。', authentication: '请核对并重新填写 API 密钥。',
  balance: '请检查供应商余额或计费状态。', permission: '请检查账号、模型与区域权限。',
  route: '请核对 API 地址和模型是否可用。', limit: '已达到供应商限额，请检查配额后再提交。',
};

function Choices({ label, value, values, onChange }) {
  return <label>{label}<select value={value} onChange={event => onChange(event.target.value)}>
    {values.map(option => <option key={option}>{option}</option>)}
  </select></label>;
}

function Credentials({ profile, model, disabled, onSave, onForget }) {
  const key = useRef(null);
  const base = useRef(null);
  return <details className="cloud-media-credentials">
    <summary>配置供应商 · {profile.configured ? '已配置' : '需配置'}</summary>
    <p>密钥仅保留在本次工作台服务中，关闭后需重新填写。</p>
    <form onSubmit={event => {
      event.preventDefault();
      const value = key.current.value;
      key.current.value = '';
      onSave({ provider: profile.id, model, key: value, ...(base.current ? { base: base.current.value.trim() } : {}) });
    }}>
      <fieldset disabled={disabled}>
        {profile.models.length === 0 && <label>HTTPS API 地址
          <input ref={base} type="url" required placeholder="https://你的兼容网关/v1" defaultValue={profile.configuration?.base || profile.base} />
        </label>}
        <label>API 密钥<input ref={key} type="password" required autoComplete="off" maxLength={4096} /></label>
        <div className="cloud-media-buttons">
          <button type="submit">保存本次会话配置</button>
          {profile.configured && <button type="button" onClick={onForget}>清除密钥</button>}
        </div>
      </fieldset>
    </form>
  </details>;
}

export default function CloudMediaNode({ id, data, title, toolbar, actions }) {
  const [profiles, setProfiles] = useState([]);
  const [job, setJob] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [consent, setConsent] = useState(null);
  const [links, setLinks] = useState('');
  const active = useRef(false);
  const currentProject = useRef(actions.projectId);
  currentProject.current = actions.projectId;
  const { projectId, readOnly } = actions;
  const attempt = data.cloudAttempt;
  const profile = profiles.find(item => item.id === data.provider);
  const model = data.cloudModel || profile?.configuration?.model || profile?.models[0] || '';
  const ports = cloudMediaPorts(data.provider, model);
  const connections = actions.cloudReferences(id);
  const consentFor = JSON.stringify([profile?.configuration, connections]);
  const confirmed = consent === consentFor;
  const updateHandles = useUpdateNodeInternals();
  useEffect(() => { updateHandles(id); }, [id, data.provider, model, updateHandles]);
  useEffect(() => {
    const controller = new AbortController();
    const reload = () => {
      cloudProfiles(controller.signal).then(result => setProfiles(result.providers)).catch(failure => {
        if (!controller.signal.aborted) setError(failure.message);
      });
    };
    reload();
    window.addEventListener('cloud-media-configuration', reload);
    return () => {
      controller.abort();
      window.removeEventListener('cloud-media-configuration', reload);
    };
  }, [projectId]);
  useEffect(() => {
    if (!attempt) {
      setJob(null);
      return;
    }
    const controller = new AbortController();
    setJob(value => value?.attempt === attempt ? value : null);
    cloudJob(projectId, attempt, controller.signal).then(result => {
      if (!controller.signal.aborted && !active.current) setJob({ ...result, attempt });
    }).catch(failure => {
      if (controller.signal.aborted || active.current) return;
      if (failure.code === 'CLOUD_JOB_NOT_FOUND') setJob({ state: 'missing', attempt });
      else setError(failure.message);
    });
    return () => controller.abort();
  }, [projectId, attempt]);

  async function run(operation) {
    if (active.current || readOnly) return;
    active.current = true;
    setBusy(true);
    setError('');
    try {
      await operation();
    } catch (failure) {
      if (currentProject.current === projectId) setError(failure.message || '操作尚未完成。');
    } finally {
      active.current = false;
      setBusy(false);
    }
  }

  function patch(values) {
    setConsent(null);
    actions.updateNode(id, values);
  }

  function configure(payload) {
    return run(async () => {
      const result = await configureCloud(payload);
      setProfiles(result.providers);
      setConsent(null);
      window.dispatchEvent(new Event('cloud-media-configuration'));
    });
  }

  const currentJob = job?.attempt === attempt ? job : null;
  const state = currentJob?.state;
  const disabled = busy || readOnly;
  const frozen = Boolean(attempt) || disabled;
  const configured = profile?.configured && profile.configuration.model === model;
  const isVideo = data.cloudKind === 'video';
  const canRefresh = attempt && !['done', 'failed', 'rejected', 'submission_unknown'].includes(state);
  const visibleLinks = data.provider === 'apipool' && model && model !== 'gpt-image-2';
  const change = key => value => patch({ [key]: value });
  const adopted = index => actions.cloudOutputExists(id, attempt, index);
  const allAdopted = state === 'done' && currentJob.outputs.every((_output, index) => adopted(index));

  return <div className="cloud-media-node">
    {title}{toolbar}
    {ports.map((port, index) => <Handle key={port} type="target" position={Position.Left}
      id={port} className="neo-handle target" style={{ top: 92 + index * 27 }} title={cloudPortLabels[port]} />)}
    <Handle type="source" position={Position.Right} id="ref" className="neo-handle source" isConnectableStart={false} />
    <div className="cloud-media-controls nodrag nowheel">
      <fieldset disabled={frozen}>
        <label>供应商<select value={data.provider} onChange={event => {
          setLinks('');
          patch({ provider: event.target.value, cloudModel: '', quality: 'medium', count: 1 });
        }}>
          {profiles.filter(p => p.kind === data.cloudKind).map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select></label>
        {profile?.models.length > 0 && <Choices label="模型" value={model} values={profile.models} onChange={value => patch({ cloudModel: value, quality: 'medium', count: 1 })} />}
        {profile?.models.length === 0 && <label>{data.provider === 'responses' ? 'Responses 调度模型' : '图像模型 ID'}
          <input value={model} maxLength={128} onChange={event => patch({ cloudModel: event.target.value })} />
        </label>}
        <label>提示词<textarea aria-label="提示词" value={data.prompt} maxLength={4000} onChange={event => patch({ prompt: event.target.value })} /></label>
        <div className="cloud-media-options">
          {isVideo ? <>
            <label>时长（秒）<input type="number" min="4" max="15" value={data.duration} onChange={event => patch({ duration: Number(event.target.value) })} /></label>
            {data.provider === 'ark' && <>
              <Choices label="比例" value={data.ratio} values={['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', 'adaptive']} onChange={change('ratio')} />
              <Choices label="分辨率" value={data.resolution} values={['480p', '720p']} onChange={change('resolution')} />
            </>}
          </> : <>
            {data.provider === 'apipool' ? <>
              <Choices label="比例" value={data.aspect} values={['1:1', '16:9']} onChange={change('aspect')} />
              <Choices label="分辨率" value={data.imageResolution} values={['1k', '2k', '4k']} onChange={change('imageResolution')} />
              {model === 'gpt-image-2' && <Choices label="生成数量" value={String(data.count)} values={['1', '2', '3', '4']} onChange={value => patch({ count: Number(value) })} />}
            </> : <label>图片尺寸<input value={data.size} maxLength={9} placeholder="1024x1024" onChange={event => patch({ size: event.target.value })} /></label>}
            {data.provider !== 'qianwen' && <Choices label="质量" value={data.quality}
              values={data.provider === 'apipool' && model !== 'gpt-image-2' ? ['auto', 'low', 'medium', 'high', 'xhigh', 'max'] : data.provider === 'apipool' ? ['auto', 'low', 'medium', 'high'] : ['low', 'medium', 'high']} onChange={change('quality')} />}
          </>}
        </div>
        {visibleLinks && <label>参考图 HTTPS 链接 · 每行一个<textarea value={links} maxLength={32768}
          onChange={event => { setLinks(event.target.value); setConsent(null); }} /></label>}
      </fieldset>
      {(ports.length > 0 || connections.length > 0) && <ul className="cloud-media-inputs">
        {ports.map(port => {
          const refs = connections.filter(item => item.slot === port);
          return <li key={port}>{cloudPortLabels[port]}{refs.length ? ` · ${refs.map(item => item.title).join(' → ')}` : ' · 未连接'}</li>;
        })}
        {connections.some(item => !ports.includes(item.slot)) && <li>请移除当前供应商不支持的参考连线。</li>}
      </ul>}
      {profile && !readOnly && <Credentials key={`${profile.id}:${profile.configuration?.base || ''}`} profile={profile}
        model={currentJob?.model || model} disabled={disabled} onSave={configure} onForget={() => configure({ provider: profile.id, forget: true })} />}
      {!attempt && <label className="cloud-media-confirm"><input type="checkbox" checked={confirmed} disabled={disabled}
        onChange={event => setConsent(event.target.checked ? consentFor : null)} />允许向所选供应商发送提示词及所选参考图，费用由供应商收取。</label>}
      {!attempt && <button disabled={disabled || !configured || !confirmed || !data.prompt.trim()} onClick={() => run(async () => {
        setConsent(null);
        const result = await actions.submitCloudNode(id, profile.configuration,
          links.split(/\r?\n/).map(line => line.trim()).filter(Boolean), connections);
        if (currentProject.current === projectId) setJob(result);
      })}>提交云端生成</button>}
      {attempt && <div className="cloud-media-status" role="status">{STATE_LABELS[state] || (busy ? '正在处理' : '正在读取提交记录')}
        {currentJob?.rejection && <small>{REJECTION_LABELS[currentJob.rejection]}</small>}
        {currentJob?.taskId && <small>任务 {currentJob.taskId}</small>}
      </div>}
      <div className="cloud-media-buttons">
        {canRefresh && <button disabled={disabled} onClick={() => run(async () => {
          const result = state === 'missing' || state === 'submitting'
            ? await cloudJob(projectId, attempt) : await refreshCloud(projectId, attempt);
          if (currentProject.current === projectId) setJob({ ...result, attempt });
        })}>查询原任务</button>}
        {state === 'done' && currentJob.outputs.map((output, index) => <button key={output.name}
          disabled={disabled || adopted(index)} onClick={() => run(() => actions.adoptCloudOutput(id, attempt, output, index))}>
          {adopted(index) ? '已加入画布' : '加入画布'}{currentJob.outputs.length > 1 ? ` · ${index + 1}` : ''}
        </button>)}
        {(state === 'failed' || state === 'rejected' || allAdopted) && <button disabled={disabled} onClick={() => patch({ cloudAttempt: null })}>准备新一轮</button>}
      </div>
      {error && <p className="cloud-media-error" role="alert">{error}</p>}
    </div>
  </div>;
}
