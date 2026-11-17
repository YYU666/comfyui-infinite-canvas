export async function dispatchRecordedPublication(packet, record, dispatch) { await record?.(packet.requestId); dispatch(packet); }
import { getExtension, extensionArchive } from './workflow-extensions.js';
import { shareSummary } from './workflow-sharing.js';
export function trustedLibraryMessage(event, frameWindow) { return Boolean(frameWindow) && event.origin === 'https://refmuse.cn' && event.source === frameWindow && event.data?.version === 1; }
export const PUBLISH_LEDGER_KEY = 'refmuse.extension-publications.v1';
export function validatePublishRequest(args) {
  if (!args || Object.keys(args).some(key=>!['digest','packageId','requestId','version','mode'].includes(key)) || !['update','publish'].includes(args.mode ?? 'update') || !/^[A-Za-z0-9_-]{1,100}$/.test(args.requestId || '') || !/^[a-f0-9]{64}$/.test(args.digest || '') || !/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(args.packageId || '') || args.packageId.length > 128 || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/.test(args.version || '')) throw new Error('发布请求需要精确 requestId、digest、packageId、version。');
  return {...args,mode:args.mode ?? 'update'};
}
export async function publicationPreflight(request) {
  const response=await fetch(`/api/extensions/${request.digest}/publication`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({packageId:request.packageId,version:request.version,mode:request.mode})});
  const result=await response.json();if(!response.ok){const error=new Error('发布预检未通过，请核对版本、摘要或网络后重试。');error.code=/^PUBLICATION_[A-Z_]+$/.test(result.code || result.error?.code || '')?(result.code || result.error.code):'PUBLICATION_UNAVAILABLE';throw error;}return result;
}
function checkedPublic(result, request) { if(!result || !['ready','published'].includes(result.status) || ['digest','packageId','version'].some(key=>result[key]!==request[key])) throw Object.assign(new Error('公开预检身份不匹配。'),{code:'PUBLICATION_IDENTITY_MISMATCH'});return result; }
export function createPublishLedger({ storage, now = Date.now, timeoutMs = 120000, getBundle = getExtension, archive = extensionArchive, preflight = publicationPreflight, send, locks = globalThis.navigator?.locks } = {}) {
  let entries;
  const refresh = () => { try { entries = Object.assign(Object.create(null),JSON.parse(storage.getItem(PUBLISH_LEDGER_KEY) || '{}')); } catch { throw new Error('发布去重记录无法读取；停止上传。'); } };
  refresh();
  const save = () => storage.setItem(PUBLISH_LEDGER_KEY, JSON.stringify(entries));
  const snapshot = entry => Object.fromEntries(['requestId','digest','packageId','version','mode','status','sent','createdAt','reason','code','message','remoteStatus','phase'].filter(key=>entry[key]!==undefined).map(key=>[key,entry[key]]));
  const get = requestId => {
    const entry = entries[requestId];
    if (!entry) return {requestId,status:'unknown',reason:'request-not-recorded'};
    if (['submitted','awaiting-login'].includes(entry.status) && !entry.remoteStatus && now()-entry.createdAt >= timeoutMs) return {...snapshot(entry),status:'unknown',reason:'acknowledgement-timeout'};
    return snapshot(entry);
  };
  const methods = {
    get,
    async status(requestId) {
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(requestId || '')) throw new Error('无效requestId。');
      const current=get(requestId);if(!entries[requestId] || current.status==='published')return current;
      try { const publicState=checkedPublic(await preflight(entries[requestId]),entries[requestId]);if(publicState.status==='published'){entries[requestId].status='published';entries[requestId].reason='public-digest-verified';save();} } catch { /* A read failure is not publication failure and never retries upload. */ }
      return get(requestId);
    },
    async publish(args) {
      const request=validatePublishRequest(args);
      if (entries[request.requestId]) {
        if (['digest','packageId','version','mode'].some(key=>entries[request.requestId][key]!==request[key])) throw new Error('requestId 已绑定其他发布身份。');
        if (!(entries[request.requestId].status==='failed' && !entries[request.requestId].sent && entries[request.requestId].phase==='preparing')) return get(request.requestId);
      }
      if (Object.values(entries).some(entry=>entry.requestId!==request.requestId && entry.digest===request.digest && entry.packageId===request.packageId && entry.version===request.version)) throw new Error('该精确包已有发布记录；请查询原 requestId，不要重复上传。');
      if (Object.values(entries).some(entry=>['submitted','awaiting-login'].includes(get(entry.requestId).status))) throw new Error('已有发布等待确认；先查询原请求，避免覆盖上传窗口。');
      if (Object.keys(entries).length>=200) throw new Error('发布去重记录已满；不会清除记录或重复上传。');
      entries[request.requestId]={...request,status:'submitted',sent:false,phase:'preparing',createdAt:now()};save();
      try {
        const bundle=await getBundle(request.digest);
        if (bundle.digest!==request.digest || bundle.manifest?.packageId!==request.packageId || bundle.manifest?.version!==request.version) throw new Error('installed-identity-mismatch');
        const checked=checkedPublic(await preflight(request),request);
        if(checked.status==='published'){entries[request.requestId].status='published';entries[request.requestId].reason='public-digest-verified';save();return get(request.requestId);}
        if(checked.status!=='ready')throw new Error('public-preflight-not-ready');
        const data=await archive(request.digest);
        entries[request.requestId].phase='enqueued';save();
        await send({requestId:request.requestId,autoSubmit:true,package:data,filename:`${request.packageId.replace('/','-')}-${request.version}.h3pack`,summary:shareSummary(bundle)});
      } catch(error) { const entry=entries[request.requestId];const ambiguous=entry.sent || entry.phase==='enqueued';entry.status=ambiguous?'unknown':'failed';entry.reason=ambiguous?'dispatch-outcome-unknown':'preflight-or-preparation-failed';entry.code=/^PUBLICATION_[A-Z_]+$/.test(error.code || '')?error.code:'PUBLICATION_PREPARATION_FAILED';entry.message=ambiguous?'上传结果未确认；请查询状态，不要重新上传。':'发布预检或准备失败；核对包身份、版本与网络后，可用同一 requestId 显式重试。';save(); }
      return get(request.requestId);
    },
    sent(requestId) { if (entries[requestId]) {entries[requestId].sent=true;save();} },
    // Caller must verify the iframe origin AND event.source before calling this.
    result(data) {
      const entry=entries[data.requestId];
      if (!entry || !entry.sent || typeof data.ok!=='boolean' || ['published','failed'].includes(entry.status)) return;
      entry.status=!data.ok ? (data.status==='awaiting-login'?'awaiting-login':['changes_requested','rejected','cancelled','invalid-package'].includes(data.status)?'failed':'unknown') : data.status==='published'?'published':data.status==='awaiting-login'?'awaiting-login':'submitted';
      if (['changes_requested','rejected','cancelled','invalid-package','pending_review','approved','publishing','awaiting-login'].includes(data.status)) entry.remoteStatus=data.status;
      entry.message=entry.status==='unknown'?'节点库未确认最终结果；请查询公开状态，不要重复上传。':entry.status==='failed'?'节点库明确要求修改、拒绝或取消；查看节点库窗口的校验详情后准备新版本。':entry.status==='published'?'节点库已确认发布。':'节点库已确认接收，正在等待审核或发布。';
      entry.reason=entry.status==='published'?'trusted-published-ack':entry.status==='failed'?'trusted-failure-ack':'trusted-pending-ack';save();
    },
  };
  const serialized = method => (...args) => {
    if (!locks?.request) return Promise.reject(new Error('当前浏览器不支持跨页面发布锁；已停止上传。'));
    return locks.request(PUBLISH_LEDGER_KEY, async () => { refresh(); return method(...args); });
  };
  return { get: requestId => { refresh(); return get(requestId); }, publish: serialized(methods.publish), status: serialized(methods.status), sent: serialized(methods.sent), result: serialized(methods.result) };
}
