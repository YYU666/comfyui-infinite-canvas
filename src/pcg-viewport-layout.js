/** Bounded floating-panel geometry and immutable native-artifact request identity. */
export const PCG_PANEL_MIN=Object.freeze({width:300,height:240});
export const PCG_HANDLE_KEYS=Object.freeze(['projectId','nodeId','revision','descriptorVersion','operationVersion','runId','jobId','inputHash']);
const number=(value,fallback)=>typeof value==='number'&&Number.isFinite(value)?value:fallback;
const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
function bounds(host){return {width:Math.max(1,number(host?.width,1)),height:Math.max(1,number(host?.height,1))};}
export function clampPcgViewportLayout(layout,host){
  const area=bounds(host),width=clamp(number(layout?.width,480),Math.min(PCG_PANEL_MIN.width,area.width),area.width),height=clamp(number(layout?.height,360),Math.min(PCG_PANEL_MIN.height,area.height),area.height);
  return {x:clamp(number(layout?.x,16),0,area.width-width),y:clamp(number(layout?.y,16),0,area.height-height),width,height};
}
export function movePcgViewportLayout(layout,dx,dy,host){return clampPcgViewportLayout({...layout,x:layout.x+number(dx,0),y:layout.y+number(dy,0)},host);}
export function resizePcgViewportLayout(layout,direction,dx,dy,host){
  const area=bounds(host),start=clampPcgViewportLayout(layout,area),minW=Math.min(PCG_PANEL_MIN.width,area.width),minH=Math.min(PCG_PANEL_MIN.height,area.height);
  let left=start.x,right=start.x+start.width,top=start.y,bottom=start.y+start.height;
  if(direction.includes('w'))left=clamp(left+number(dx,0),0,right-minW);
  if(direction.includes('e'))right=clamp(right+number(dx,0),left+minW,area.width);
  if(direction.includes('n'))top=clamp(top+number(dy,0),0,bottom-minH);
  if(direction.includes('s'))bottom=clamp(bottom+number(dy,0),top+minH,area.height);
  return {x:left,y:top,width:right-left,height:bottom-top};
}
function requireValue(condition,message){if(!condition){const error=new Error(message);error.code='INVALID_ARTIFACT_IDENTITY';throw error;}}
/** This function never fetches; it authorizes only the native managed-artifact URL. */
export function pcgArtifactRequest(desired,projectId,origin,generation){
  requireValue(desired&&typeof desired==='object','Missing PCG artifact.');
  const handle=desired.handle;
  requireValue(handle&&typeof handle==='object'&&!Array.isArray(handle)&&Object.keys(handle).length===PCG_HANDLE_KEYS.length&&PCG_HANDLE_KEYS.every(key=>Object.hasOwn(handle,key)),'Incomplete PCG task handle.');
  requireValue(handle.projectId===projectId&&desired.graphRevision===handle.revision,'Artifact project or graph revision mismatch.');
  for(const key of ['projectId','nodeId','runId'])requireValue(typeof handle[key]==='string'&&handle[key].length>0&&handle[key].length<=256,'Invalid PCG task identity.');
  for(const key of ['revision','descriptorVersion','operationVersion'])requireValue(Number.isSafeInteger(handle[key])&&handle[key]>=0,'Invalid PCG task version.');
  requireValue(typeof handle.jobId==='string'&&typeof handle.inputHash==='string'&&/^pcg_[a-f0-9]{32}$/.test(handle.jobId)&&/^[a-f0-9]{64}$/.test(handle.inputHash),'Invalid PCG task digest.');
  requireValue(typeof desired.artifactId==='string'&&/^pcga_[a-f0-9]{64}$/.test(desired.artifactId)&&typeof desired.sha256==='string'&&/^[a-f0-9]{64}$/.test(desired.sha256),'Invalid PCG artifact digest.');
  requireValue(Number.isSafeInteger(desired.bytes)&&desired.bytes>=20&&desired.bytes<=64*1024*1024,'PCG artifact exceeds viewer byte budget.');
  requireValue(desired.format==='glb'&&desired.role==='model','PCG viewport requires a model GLB.');
  requireValue(typeof desired.url==='string'&&desired.url.length<=4096,'Invalid PCG artifact URL.');
  let url;try{url=new URL(desired.url,origin);}catch{requireValue(false,'Invalid PCG artifact URL.');}
  requireValue(url.origin===origin&&!url.username&&!url.password&&!url.hash&&url.pathname===`/api/pcg/artifacts/${desired.artifactId}`,'PCG artifact URL must be same-origin and managed.');
  const keys=[...url.searchParams.keys()];requireValue(keys.length===PCG_HANDLE_KEYS.length&&new Set(keys).size===keys.length&&keys.every(key=>PCG_HANDLE_KEYS.includes(key))&&PCG_HANDLE_KEYS.every(key=>url.searchParams.get(key)===String(handle[key])),'PCG artifact URL handle mismatch.');
  return {url:url.href,bytes:desired.bytes,sha256:desired.sha256,identity:{...handle,artifactId:desired.artifactId,sha256:desired.sha256,generation}};
}
