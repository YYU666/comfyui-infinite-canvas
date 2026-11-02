import React, { useEffect, useRef, useState } from 'react';
import { DependencyList, ExchangeDialog } from './WorkflowDependencies';
import { extensionArchive, shareExtension } from './workflow-extensions';
import { shareTextPreview, shareSummary, suggestShareMetadata } from './workflow-sharing';
import { prepareShareThumbnail } from './workflow-share-preview';
import { sharePackageIdentity, rememberSharePackageIdentity } from './workflow-share-identity';

const LICENSE_HELP = {
  UNSPECIFIED: '暂未授予他人使用、修改或再发布的许可。若不确定自己是否有权授权，可先保留此项；想开放分享时，请选择符合你意愿的许可。',
  'Apache-2.0': '允许他人使用、修改、分享和商用；需保留许可及版权声明，修改文件需注明改动，原有 NOTICE 声明适用时也需保留。此许可还包含贡献者专利授权条款。',
  MIT: '允许他人使用、修改、分享和商用；复制或分发时需保留版权声明及 MIT 许可文本。',
  'CC0-1.0': '在法律允许的范围内放弃版权等权利，允许他人使用、修改和商用，通常无需署名。只适用于你有权作出这种授权的内容。',
  'CC-BY-4.0': '允许他人分享、修改和商用；需注明作者、提供许可链接，并说明是否作了修改。',
};

export default function WorkflowShare({ source, projectId, nodeId, suggestedMetadata, thumbnail, staged = false, onClose, onSend }) {
  const [metadata, setMetadata] = useState(() => ({ ...suggestShareMetadata({}, source), ...suggestedMetadata, packageId: sharePackageIdentity(projectId, nodeId), version: '0.1.0', license: 'UNSPECIFIED', includePrompts: false }));
  const [bundle, setBundle] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [includeThumbnail, setIncludeThumbnail] = useState(Boolean(thumbnail?.url));
  const [cover, setCover] = useState('');
  const [coverError, setCoverError] = useState('');
  const [coverLoading, setCoverLoading] = useState(Boolean(thumbnail?.url));
  const busyRef = useRef(false);
  useEffect(() => {
    if (!thumbnail?.url) return undefined;
    let active = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    prepareShareThumbnail(thumbnail.url, { signal: controller.signal }).then((image) => { if (active) setCover(image); }).catch((err) => { if (active) setCoverError(err.name === 'AbortError' ? '封面读取超时，可取消使用封面后继续。' : err.message || '无法制作封面，可取消使用封面后继续。'); }).finally(() => { clearTimeout(timer); if (active) setCoverLoading(false); });
    return () => { active = false; clearTimeout(timer); controller.abort(); };
  }, [thumbnail?.url]);
  const set = (key, value) => { setMetadata((previous) => ({ ...previous, [key]: value })); setBundle(null); };
  const run = async (action) => { if (busyRef.current) return; busyRef.current = true; setBusy(true); setError(''); try { await action(); } catch (err) { setError(err.message); } finally { busyRef.current = false; setBusy(false); } };
  return <ExchangeDialog title="上传节点到节点库" busy={busy} onClose={onClose}>
    <p>已按工作流用途概括名称和说明，可继续编辑。自动整理模型、LoRA 和 ComfyUI 节点依赖；确认后上传，普通工作流通过自动审核即发布，其他内容转人工审核。未登录时会先提示登录。</p>
    {thumbnail?.url ? <section className="workflow-share-cover" aria-label="节点封面">
      <label className="workflow-check"><input type="checkbox" disabled={busy} checked={includeThumbnail} onChange={(event) => { setIncludeThumbnail(event.target.checked); setBundle(null); }} />使用当前图片作为节点封面</label>
      {includeThumbnail && <>{cover && <img src={bundle?.manifest.preview || cover} alt="将公开展示的节点封面" />}{coverLoading && <p role="status">正在制作封面…</p>}{coverError && <p className="workflow-warning">{coverError}</p>}</>}
      <p>{thumbnail.title || '当前图片'}。封面会压缩后随节点包公开展示；取消勾选即可不上传。原始图片不打包。</p>
    </section> : <p>当前没有可用图片，节点将不带封面上传。原始图片不打包。</p>}
    {staged && <p>四视图会完整打包为逐张生成、最后拼接的一个画布节点。各视角的提示词是流程的一部分，需勾选包含提示词后预览；其中也会包含当前角色描述，请在提交前检查。</p>}
    <label>节点名称<input disabled={busy} value={metadata.name} onChange={(event) => set('name', event.target.value)} maxLength={100} /></label>
    <label>发布标识（自动生成，可修改）<input disabled={busy} value={metadata.packageId} onChange={(event) => set('packageId', event.target.value)} maxLength={128} /></label>
    <p>已自动生成独立标识，首次上传后归当前登录账号使用。同一节点会记住此标识；发布新版本时请提高版本号。若更换账号或提示标识被占用，可重新生成。</p>
    <button type="button" disabled={busy} onClick={() => set('packageId', sharePackageIdentity(projectId, nodeId, { fresh: true }))}>重新生成发布标识</button>
    <label>版本<input disabled={busy} value={metadata.version} onChange={(event) => set('version', event.target.value)} /></label>
    <label>使用说明<textarea aria-label="使用说明" disabled={busy} value={metadata.description} onChange={(event) => set('description', event.target.value)} maxLength={4000} /></label>
    <label>工作流许可<select aria-label="工作流许可" aria-describedby="workflow-license-help" disabled={busy} value={metadata.license} onChange={(event) => set('license', event.target.value)}><option value="UNSPECIFIED">未声明</option><option value="Apache-2.0">Apache-2.0 · 保留声明，可商用</option><option value="MIT">MIT · 保留声明，可商用</option><option value="CC0-1.0">CC0 · 尽可能放弃版权限制</option><option value="CC-BY-4.0">CC BY · 署名后可分享、修改和商用</option></select></label>
    <p id="workflow-license-help" className="workflow-license-help">许可决定别人下载后能否使用、修改、分享或商用你的工作流。<br />{LICENSE_HELP[metadata.license]}<br />这里只授权你有权分享的工作流内容；模型、LoRA、封面图片及第三方节点仍遵循各自授权。</p>
    <label className="workflow-check"><input type="checkbox" disabled={busy} checked={metadata.includePrompts} onChange={(event) => set('includePrompts', event.target.checked)} />包含当前提示词（可能含个人创作内容）</label>
    {error && <p role="alert">{error}</p>}
    {bundle && <><DependencyList report={bundle.dependencyReport} /><h3>将分享的文本参数</h3><p>请检查模型名、提示词和其他字符串，确认没有私密内容。</p><pre className="workflow-share-preview">{shareTextPreview(bundle)}</pre></>}
    {!bundle && <p role="status">{staged && !metadata.includePrompts ? '下一步：先勾选「包含当前提示词」，再点击左下方「整理依赖并预览」。' : '下一步：点击左下方「整理依赖并预览」。打包成功后，右侧提交按钮才会启用。'}</p>}
    <footer><button disabled={busy || (staged && !metadata.includePrompts) || (includeThumbnail && !cover)} onClick={() => run(async () => { const prepared = await shareExtension({ ...source, ...metadata, ...(includeThumbnail && cover ? { thumbnail: cover } : {}) }); rememberSharePackageIdentity(projectId, nodeId, metadata.packageId); setBundle(prepared); })}>{busy ? '正在打包…' : bundle ? '重新整理说明' : '整理依赖并预览'}</button><button disabled={busy || !bundle} onClick={() => run(async () => { const archive = await extensionArchive(bundle.digest); await onSend({ requestId: crypto.randomUUID(), autoSubmit: true, package: archive, filename: `${bundle.manifest.packageId.replace('/', '-')}-${bundle.manifest.version}.h3pack`, summary: shareSummary(bundle) }); })}>确认上传到节点库</button></footer>
  </ExchangeDialog>;
}
