import React, { useRef, useState } from 'react';
import { DependencyList, ExchangeDialog } from './WorkflowDependencies';
import { extensionArchive, shareExtension } from './workflow-extensions';
import { shareTextPreview, shareSummary } from './workflow-sharing';

export default function WorkflowShare({ source, title, staged = false, onClose, onSend }) {
  const [metadata, setMetadata] = useState({ name: title || '我的工作流', packageId: 'community/my-workflow', version: '0.1.0', description: '', license: 'UNSPECIFIED', includePrompts: false });
  const [bundle, setBundle] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const busyRef = useRef(false);
  const set = (key, value) => { setMetadata((previous) => ({ ...previous, [key]: value })); setBundle(null); };
  const run = async (action) => { if (busyRef.current) return; busyRef.current = true; setBusy(true); setError(''); try { await action(); } catch (err) { setError(err.message); } finally { busyRef.current = false; setBusy(false); } };
  return <ExchangeDialog title="上传节点到节点库" busy={busy} onClose={onClose}>
    <p>自动整理模型、LoRA 和 ComfyUI 节点说明。图片素材不会打包；确认后在 Refmuse 登录并提交审核。</p>
    {staged && <p>四视图会完整打包为逐张生成、最后拼接的一个画布节点。各视角的提示词是流程的一部分，需勾选包含提示词后预览；其中也会包含当前角色描述，请在提交前检查。</p>}
    <label>节点名称<input disabled={busy} value={metadata.name} onChange={(event) => set('name', event.target.value)} maxLength={100} /></label>
    <label>包标识（命名空间/名称）<input disabled={busy} value={metadata.packageId} onChange={(event) => set('packageId', event.target.value)} maxLength={128} /></label>
    <label>版本<input disabled={busy} value={metadata.version} onChange={(event) => set('version', event.target.value)} /></label>
    <label>使用说明<textarea disabled={busy} value={metadata.description} onChange={(event) => set('description', event.target.value)} maxLength={4000} /></label>
    <label>工作流许可<select disabled={busy} value={metadata.license} onChange={(event) => set('license', event.target.value)}><option value="UNSPECIFIED">未声明（请确认拥有分享权限）</option><option value="Apache-2.0">Apache-2.0</option><option value="MIT">MIT</option><option value="CC0-1.0">CC0-1.0</option><option value="CC-BY-4.0">CC-BY-4.0</option></select></label>
    <label className="workflow-check"><input type="checkbox" disabled={busy} checked={metadata.includePrompts} onChange={(event) => set('includePrompts', event.target.checked)} />包含当前提示词（可能含个人创作内容）</label>
    {error && <p role="alert">{error}</p>}
    {bundle && <><DependencyList report={bundle.dependencyReport} /><h3>将分享的文本参数</h3><p>请检查模型名、提示词和其他字符串，确认没有私密内容。</p><pre className="workflow-share-preview">{shareTextPreview(bundle)}</pre></>}
    <footer><button disabled={busy || (staged && !metadata.includePrompts)} onClick={() => run(async () => setBundle(await shareExtension({ ...source, ...metadata })))}>{busy ? '正在打包…' : bundle ? '重新整理说明' : '整理依赖并预览'}</button><button disabled={busy || !bundle} onClick={() => run(async () => { const archive = await extensionArchive(bundle.digest); await onSend({ requestId: crypto.randomUUID(), package: archive, filename: `${bundle.manifest.packageId.replace('/', '-')}-${bundle.manifest.version}.h3pack`, summary: shareSummary(bundle) }); })}>确认并前往 Refmuse 提交</button></footer>
  </ExchangeDialog>;
}
