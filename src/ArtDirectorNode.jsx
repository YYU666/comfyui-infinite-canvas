import React, { useEffect, useRef, useState } from 'react';
import { Handle, Position, useUpdateNodeInternals } from '@xyflow/react';
import { ART_PORTS, REFERENCE_PURPOSES, demoAnalysis, moveGuide, validateAnalysis, guideGeometry, removeArtGuide } from './art-director.js';
import './art-director.css';

export default function ArtDirectorNode({ id, data, actions, title, toolbar }) {
  const state = actions.getArtDirectorState(id), updateInternals = useUpdateNodeInternals();
  const [credential, setCredential] = useState(''), [configMessage, setConfigMessage] = useState(''), [configBusy,setConfigBusy]=useState(false);
  const [status, setStatus] = useState(null), [selected, setSelected] = useState(null), [history, setHistory] = useState([]), [localError, setLocalError] = useState('');
  const drag = useRef(null), importRef = useRef(null), fileRef = useRef(null), slotRef = useRef('artwork');
  const running = actions.isImageProcessBusy(id), disabled = running || actions.readOnly || configBusy;
  const provider = data.artProvider || 'qwen';
  const profile = status?.providers?.find(p=>p.id===provider);
  const providerStatus = profile || (provider==='qwen'?status:null);
  const providerRef=useRef(provider);providerRef.current=provider;
  useEffect(()=>{setCredential('');setConfigMessage('');},[provider]);
  const providerName = ({qwen:'Qwen',kimi:'Kimi',doubao:'豆包',deepseek:'DeepSeek Flash'})[provider] || '视觉模型';
  const providerModel = data.artModel || profile?.defaultModel || (provider==='qwen'?'qwen3-vl-plus':'');
  const analysis = data.analysis?.sourceVersion === state.signature ? data.analysis : null;
  const currentBoard = analysis && data.boardSignature === JSON.stringify([state.signature, analysis]);
  useEffect(() => { let alive=true; fetch('/api/art-director/status').then(r=>r.ok?r.json():Promise.reject()).then(v=>{if(alive)setStatus(v);}).catch(()=>{if(alive)setStatus({unavailable:true});});return()=>{alive=false;}; }, []);
  useEffect(() => { setHistory([]); setSelected(null); }, [state.signature, data.analysisGeneration]);
  useEffect(() => { updateInternals(id); }, [id, state.artwork?.data.url, analysis, updateInternals]);
  const patch = change => { if(!disabled) actions.updateNode(id, {...change,error:null}); };
  const edit = next => { if(!analysis || disabled)return;setHistory(h=>[...h.slice(-19),analysis]);patch({analysis:validateAnalysis(guideGeometry(next),state.signature)}); };
  const apply = async(value, provenance) => {setLocalError('');try{await actions.applyArtAnalysis(id,value,provenance);}catch(e){setLocalError(e.message);}};
  const configure = async(persistence,action='set') => {
    const configuredProvider=provider;setConfigMessage('');setConfigBusy(true);
    try { const r=await fetch('/api/art-director/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider,persistence,action,...(action==='set'?{key:credential}:{})})});const body=await r.json();if(!r.ok)throw new Error(body.message||'配置失败');setStatus(body);if(providerRef.current===configuredProvider)setConfigMessage(persistence==='local'?(action==='delete'?'已移除本机加密凭据；环境配置仍可生效。':'已使用 Windows DPAPI 保存到本机当前用户安全目录；不进入项目或导出包。'):(action==='delete'?'已清除会话凭据；本机加密或环境配置仍可生效。':'已用于本次后端会话，重启后清除。')); } catch(error) {if(providerRef.current===configuredProvider)setConfigMessage(error.message);} finally {if(providerRef.current===configuredProvider)setCredential('');setConfigBusy(false);}
  };
  const selectedGuide = analysis?.guides.find(g=>g.id===selected);
  const downloadJson = () => {const blob=new Blob([JSON.stringify(analysis || demoAnalysis(state.signature),null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='art-analysis-template.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
  const source = state.artwork;
  return <div className="art-director-node" data-art-director="v1">{title}{toolbar}
    {ART_PORTS.map((port,i)=><React.Fragment key={port}><Handle type="target" id={port} position={Position.Left} style={{top:88+i*30}} isConnectable={!disabled}/><span className="art-port" style={{top:80+i*30}}>{i===0?'作品图片':`参考 ${i} · 可选`}</span></React.Fragment>)}
    <Handle type="source" id="ref" position={Position.Right} style={{top:88}} isConnectable={false}/>
    <div className="art-heading"><strong>图解分析 · 原图保留</strong><span>本机排版 / 可编辑标注</span></div>
    <div className="art-controls nodrag nopan nowheel">
      <label>视觉供应商<select aria-label="视觉供应商" value={provider} disabled={disabled} onChange={e=>{setCredential('');setConfigMessage('');patch({artProvider:e.target.value,artModel:status?.providers?.find(p=>p.id===e.target.value)?.defaultModel || ''});}}>{(status?.providers || [{id:'qwen',name:'千问 Qwen'}]).map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      <label>视觉模型<select aria-label="视觉模型" value={providerModel} disabled={disabled} onChange={e=>patch({artModel:e.target.value})}>{(profile?.models || ['qwen3-vl-plus']).map(model=><option key={model}>{model}</option>)}</select></label>
      <div className="art-status">{providerStatus?.configured?`${providerName} 已配置 · 点击分析后上传作品与参考` : status?.unavailable?'云端入口尚未就绪 · 可用示例 / JSON 导入':`${providerName} 未配置本机凭据 · 可用示例 / JSON 导入`}</div>
      <p>视觉能力按官方文档核对；本功能仅验证了模拟请求，未进行付费推理测试。DeepSeek V4 Pro 不支持图像理解，不能用于审图；Flash 视觉模型可选。</p>
      <details className="art-config"><summary>本机千问配置 / 视觉供应商配置</summary><p>当前配置：{providerName} · 来源 {providerStatus?.credentialSource || 'none'}。凭据不会写入画布、浏览器存储或导出包。会话配置重启后清除；本机保存使用 Windows 当前用户 DPAPI 加密，仅当前系统用户可解密。</p>
        <input type="password" aria-label="本机千问密钥" autoComplete="off" value={credential} onChange={e=>setCredential(e.target.value)} placeholder={`输入 ${providerName} API Key`}/>
        <button disabled={!credential || disabled} onClick={()=>configure('session')}>用于本次后端会话</button>
        <button disabled={disabled || !status?.persistenceAvailable || (!credential && providerStatus?.credentialSource!=='session')} onClick={()=>configure('local',credential?'set':'persist-session')}>加密保存在本机</button>
        <button disabled={disabled} onClick={()=>configure('session','delete')}>清除会话密钥</button>
        <button disabled={disabled || !status?.persistenceAvailable} onClick={()=>configure('local','delete')}>删除本机加密凭据</button>
        {!status?.persistenceAvailable&&<p>本机持久保存不可用；需要 Windows 安全存储，且凭据目录必须位于仓库和所有项目目录之外。不会回退到明文保存。</p>}
        {providerStatus?.storageError&&<p className="art-error">已有加密存储无法安全读取；未使用明文回退。</p>}
        {configMessage&&<p>{configMessage}</p>}
      </details><p>示例和导入图板在本机处理。点击云端分析会发送作品及参考；取消只停止接收/应用结果，已发送请求可能继续执行和计费。</p>
      {ART_PORTS.map((port,i)=><div className="art-input" key={port}><span>{i===0?'作品':`参考 ${i}`}：{state.refs?.find(r=>r.data.slot===port)?.data.title || '未连接'}</span>{i>0&&<select aria-label={`参考 ${i} 用途`} disabled={disabled} value={data.referencePurposes?.[port] || '配色'} onChange={e=>patch({referencePurposes:{...data.referencePurposes,[port]:e.target.value}})}>{REFERENCE_PURPOSES.map(p=><option key={p}>{p}</option>)}</select>}<button disabled={disabled} onClick={()=>{slotRef.current=port;fileRef.current?.click();}}>导入</button>{state.refs?.some(r=>r.data.slot===port)&&<button disabled={disabled} onClick={()=>actions.disconnectArtInput(id,port)}>断开</button>}</div>)}
      <input ref={fileRef} hidden type="file" accept="image/png,image/jpeg,image/webp" onChange={async e=>{const f=e.target.files?.[0];e.target.value='';if(!f)return;try{await actions.attachArtInput(id,slotRef.current,f);}catch(error){setLocalError(error.message);}}}/>
      <label>创作目标<textarea aria-label="创作目标" maxLength={2000} value={data.brief || ''} disabled={disabled} onChange={e=>patch({brief:e.target.value})} placeholder="用途、风格、主焦点、希望改善的关系"/></label>
      <label>必须保留<textarea aria-label="必须保留" maxLength={2000} value={data.preserve || ''} disabled={disabled} onChange={e=>patch({preserve:e.target.value})} placeholder="身份、构图、配色、叙事和风格约束"/></label>
      <div className="art-buttons"><button disabled={disabled || !!state.error || !providerStatus?.configured} onClick={()=>actions.runArtAnalysis(id)}>{providerName} 分析并输出解析图</button><button disabled={disabled || !!state.error} onClick={()=>apply(demoAnalysis(state.signature),'demo')}>加载明确标识的示例</button><button disabled={disabled || !!state.error} onClick={()=>importRef.current?.click()}>导入解析 JSON</button><button disabled={!!state.error} onClick={downloadJson}>下载 JSON 模板</button></div>
      <input ref={importRef} hidden type="file" aria-label="导入解析 JSON" accept=".json,application/json" onChange={async e=>{const f=e.target.files?.[0];e.target.value='';if(!f)return;try{if(f.size>128*1024)throw new Error('JSON 最多 128KB。');await apply(validateAnalysis(JSON.parse(await f.text()),state.signature),'import');}catch(error){setLocalError(error.message);}}}/>
      {source&&<div className="art-source" aria-label="原图可编辑辅助线"><img src={source.data.url} alt="作品原图" draggable={false}/><svg className="art-guides" viewBox="0 0 1000 1000" preserveAspectRatio="none" onPointerMove={e=>{if(!drag.current || disabled)return;const r=e.currentTarget.getBoundingClientRect();const {guide,x,y,original,issueId}=drag.current;const next=moveGuide(guide,(e.clientX-x)/r.width,(e.clientY-y)/r.height);if(issueId){const [[nx,ny],[xx,yy]]=next.points;patch({analysis:{...original,issues:original.issues.map(issue=>issue.id===issueId?{...issue,box:[nx,ny,xx-nx,yy-ny]}:issue)}});}else patch({analysis:guideGeometry({...original,guides:original.guides.map(g=>g.id===guide.id?next:g)})});}} onPointerUp={e=>{if(drag.current){e.currentTarget.releasePointerCapture(e.pointerId);drag.current=null;}}} onPointerCancel={()=>{drag.current=null;}}>
        {analysis?.issues.filter(issue=>!issue.hidden&&!analysis.guides.some(g=>g.kind==='rect'&&g.issueId===issue.id)).map((issue,i)=>{const [x,y,w,h]=issue.box;return <g key={issue.id} data-issue-locator={issue.id}><rect x={x*1000} y={y*1000} width={w*1000} height={h*1000} fill="#ffd16e08" stroke="#ffd16e" strokeWidth="3" vectorEffect="non-scaling-stroke" onPointerDown={e=>{if(disabled)return;e.stopPropagation();setHistory(h=>[...h.slice(-19),analysis]);drag.current={guide:{points:[[x,y],[x+w,y+h]]},issueId:issue.id,original:analysis,x:e.clientX,y:e.clientY};e.currentTarget.ownerSVGElement.setPointerCapture(e.pointerId);}}/><text x={x*1000} y={Math.max(25,y*1000-10)} fill="#ffd16e" fontSize="30">{analysis.issues.findIndex(a=>a.id===issue.id)+1} · 观察区域（估计）</text></g>;})}
        {analysis?.guides.filter(g=>!g.hidden).map((g,i)=>{const [[x,y],[xx,yy]]=g.points,props={stroke:selected===g.id?'#ffffff':['#ffd16e','#7fe0e6','#e9a5ff'][i%3],strokeWidth:4,vectorEffect:'non-scaling-stroke',fill:g.kind==='rect'?'#ffd16e08':'none',onPointerDown:e=>{if(disabled)return;e.stopPropagation();setSelected(g.id);setHistory(h=>[...h.slice(-19),analysis]);drag.current={guide:g,original:analysis,x:e.clientX,y:e.clientY};e.currentTarget.ownerSVGElement.setPointerCapture(e.pointerId);}};return <g key={g.id} data-guide={g.id}>{g.kind==='rect'?<rect x={x*1000} y={y*1000} width={(xx-x)*1000} height={(yy-y)*1000} {...props}/>:<line x1={x*1000} y1={y*1000} x2={xx*1000} y2={yy*1000} {...props}/>}<text x={x*1000} y={Math.max(25,y*1000-10)} fill={props.stroke} fontSize="30">{g.label}</text></g>;})}
      </svg></div>}
      {analysis&&<><div className={`art-provenance ${data.analysisProvenance==='demo'?'demo':''}`}>{data.analysisProvenance==='demo'?'操作示例 · 未进行模型视觉审查':['qwen','kimi','doubao','deepseek'].includes(data.analysisProvenance)?`${({qwen:'Qwen',kimi:'Kimi',doubao:'豆包',deepseek:'DeepSeek Flash'})[data.analysisProvenance]} 视觉判断 · ${data.analysisModel || ''} · 辅助线为估计`:'导入判断 · 来源由用户确认'}</div><p>{analysis.summary}</p><p>保留：{analysis.strengths}</p>
        <div className="art-guide-list">{analysis.guides.map(g=><div key={g.id}><button disabled={disabled} aria-pressed={selected===g.id} onClick={()=>setSelected(g.id)}>{g.label}</button><label><input type="checkbox" checked={!g.hidden} disabled={disabled} onChange={()=>edit({...analysis,guides:analysis.guides.map(a=>a.id===g.id?{...a,hidden:!a.hidden}:a)})}/>显示</label><button disabled={disabled} onClick={()=>edit(removeArtGuide(analysis,g.id))}>删除</button></div>)}</div>
        {selectedGuide&&<fieldset disabled={disabled}><legend>选中辅助线 · 原图归一化坐标</legend><input aria-label="辅助线文字" maxLength={100} value={selectedGuide.label} onChange={e=>{if(e.target.value.trim())edit({...analysis,guides:analysis.guides.map(g=>g.id===selected?{...g,label:e.target.value}:g)});}}/>{selectedGuide.points.map((p,i)=>p.map((v,j)=><label key={`${i}-${j}`}>{`${i+1}${j===0?'X':'Y'}`}<input aria-label={`端点${i+1}${j===0?'X':'Y'}`} type="number" min="0" max="1" step="0.01" value={Number(v.toFixed(4))} onChange={e=>{try{const points=selectedGuide.points.map(p=>[...p]);points[i][j]=Number(e.target.value);edit({...analysis,guides:analysis.guides.map(g=>g.id===selected?{...g,points}:g)});}catch(error){setLocalError(error.message);}}}/></label>))}</fieldset>}
        <div className="art-buttons"><button disabled={disabled || !history.length} onClick={()=>{const prev=history.at(-1);setHistory(h=>h.slice(0,-1));patch({analysis:prev});}}>撤销标注编辑</button><button disabled={disabled || analysis.guides.length >= 20} onClick={()=>{const n=analysis.guides.length+1;edit({...analysis,guides:[...analysis.guides,{id:`user_${Date.now()}`,kind:'line',points:[[.1,.5],[.9,.5]],label:`候选线 ${n}（手动）`,issueId:null,hidden:false}]});}}>添加候选线</button><button disabled={disabled} onClick={()=>actions.persistProject().catch(e=>setLocalError(e.message))}>保存标注</button></div>
        <p>拖动框或线可移动；端点数值可缩放/调整。关联框与局部裁切同步。隐藏或删除辅助线只移除主图定位，保留文字与局部。标注随项目保存，PNG 是静态衍生图。</p>
        {analysis.issues.map((issue,i)=><details key={issue.id}><summary>{i+1} · {issue.priority} · {issue.evidence}</summary><p>观察：{issue.observation}</p><p>为什么：{issue.impact}</p><p>动作：{issue.action}</p><p>保留：{issue.preserve}</p><p>限制：{issue.uncertainty}</p>{!analysis.guides.some(g=>g.kind==='rect'&&g.issueId===issue.id)&&<label><input type="checkbox" disabled={disabled} checked={!issue.hidden} onChange={()=>edit({...analysis,issues:analysis.issues.map(a=>a.id===issue.id?{...a,hidden:!a.hidden}:a)})}/>显示编号区域（拖动原图框可移动）</label>}</details>)}
      </>}
      {(state.error||localError||data.error)&&<p role="alert" className="art-error">{state.error||localError||data.error}</p>}
      {data.stale&&<p className="art-error">输入或目标已改变，旧解析已清除。请重新分析或导入当前版本。</p>}
      <footer><span>{running?data.stage:analysis?currentBoard?'解析板已输出':'标注已变更 · 待重新输出':'连接作品开始'}</span>{running?<button onClick={()=>actions.cancelArtDirector(id)}>取消</button>:<button disabled={disabled || !analysis} onClick={()=>actions.exportArtBoard(id)}>输出 / 更新解析 PNG</button>}</footer>
      {currentBoard&&state.boardUrl&&<div className="art-board"><img src={state.boardUrl} alt="图解分析板 PNG" onDoubleClick={()=>actions.openImagePreview({url:state.boardUrl,title:'电子主美 · 图解分析板'})}/><a href={state.boardUrl} download="art-director-analysis.png">下载解析 PNG</a><button onClick={()=>actions.openImagePreview({url:state.boardUrl,title:'电子主美 · 图解分析板'})}>放大查看</button></div>}
    </div>
  </div>;
}
