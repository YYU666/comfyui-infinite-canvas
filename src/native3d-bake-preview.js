import {nativeOutputNode} from './native3d-output.js';
export const BAKE_CHANNELS=[['basecolor','底色'],['normal','法线'],['roughness','粗糙度'],['metallic','金属度'],['ao','AO'],['orm','ORM'],['curvature','凸棱曲率'],['edge-wear','磨损遮罩']];
const SHARED_LOD_SPECS = [
  ['lod0', 'LOD0 高模', 'LOD0_high.glb', (d) => [d?.quality?.triangles, d?.quality?.faces, d?.metadata?.source?.triangles].find((v) => Number.isInteger(v) && v > 0) ?? null],
  ['lod1', 'LOD1 中模', 'LOD1_medium.glb', (d) => d?.metadata?.bake?.sharedLods?.medium?.faces ?? null],
  ['lod2', 'LOD2 低模', 'LOD2_low.glb', (d) => d?.metadata?.bake?.sharedLods?.low?.faces ?? null],
];
const modelPath=/^assets\/[a-f0-9]{64}\.(glb|obj)$/i;
const imagePath=/^assets\/[a-f0-9]{64}\.png$/i;
export function nativeSharedLodVariants(data) {
  const artifacts = data?.nativeArtifacts || [];
  const shared = SHARED_LOD_SPECS.flatMap(([key, label, name, getTriangles]) => {
    const match = artifacts.find((a) => a?.role === 'export' && a?.name === name && modelPath.test(a?.assetPath || ''));
    return match ? [{ key, label, name, path: match.assetPath, triangles: getTriangles(data) }] : [];
  });
  if (shared.length > 1) return shared;
  const stages = (data?.metadata?.geometry?.stages || []).filter((s) => s?.status === 'accepted' && /^lod[0-4]$/.test(s?.stage || ''));
  const staged = stages.flatMap((s) => {
    const match = artifacts.find((a) => a?.role === 'export' && a?.name === s.filename && modelPath.test(a?.assetPath || ''));
    if (!match) return [];
    const triangles = s.receipt?.actual_triangles ?? s.receipt?.geometry?.triangles ?? null;
    const label = ({ lod0: 'LOD0 高模', lod1: 'LOD1 中模', lod2: 'LOD2 低模' })[s.stage] || s.stage.toUpperCase();
    return [{ key: s.stage, label, name: s.filename, path: match.assetPath, triangles }];
  });
  return staged.length > 1 ? staged : [];
}
export function nativeBakePreview(node) {
  const live=node?.data;
  const operation = live?.metadata?.operation;
  if(node?.type!=='native3d'||live?.status!=='completed'||live.error||!['bake','material_wear'].includes(operation))return null;
  const jobId=live.operation===operation?live.nativeJobId:live.operation==='analyze'?live.sourceJobId:null;
  const model=live.operation===operation?live.resultAssetPath:live.assetPath;
  if(!/^n3d_[a-f0-9]{32}$/.test(jobId||'')||live.nativeDeliveredJobId!==jobId||!modelPath.test(model||''))return null;
  let output;try{output=nativeOutputNode(node);}catch{return null;}
  const data=output.data;
  if(output.nativeOutputRecordId&&(data.sourceJobId!==jobId||data.nativeDeliveredJobId!==jobId||data.assetPath!==model||data.status!=='completed'||data.error||data.metadata?.operation!==operation))return null;
  const artifacts=data.nativeArtifacts || [];
  const models=artifacts.filter(a=>a.name==='model.glb'&&a.role==='model'&&a.assetPath===model);
  if(models.length!==1)return null;
  const channels=BAKE_CHANNELS.flatMap(([key,label])=>{
    const matches=artifacts.filter(a=>a.name===`${key}.png`&&a.role==='texture'&&imagePath.test(a.assetPath||''));
    return matches.length===1?[{key,label,assetPath:matches[0].assetPath}]:[];
  });
  if(!channels.length)return null;
  const posters=artifacts.filter(a=>a.role==='poster'&&a.assetPath===data.posterAssetPath&&imagePath.test(a.assetPath||''));
  if(posters.length===1)channels.push({key:'grey',label:'灰模',assetPath:data.posterAssetPath});
  const requested=data.nativeBakePreviewMode??live.nativeBakePreviewMode;
  const mode=channels.some(c=>c.key===requested)?requested:channels[0].key;
  const selected=channels.find(c=>c.key===mode);
  const proxy=artifacts.find(a=>a.role==='proxy'&&a.assetPath===data.proxyAssetPath&&modelPath.test(a.assetPath||''));
  return {jobId,modelAssetPath:model,channels,mode,selected,materialPath:proxy?.assetPath||model,lodVariants:nativeSharedLodVariants(data)};
}
export function extractBakeTextureNode({node,channel,projectId,id,position}) {
  const preview=nativeBakePreview(node);
  const selected=preview?.channels.find(item=>item.key===channel);
  if(!selected||selected.key==='grey')throw Error('请选择一张已写入项目的烘焙贴图。');
  return {nodes:[{id,type:'media',position,data:{kind:'image',output:true,title:selected.label,name:`${selected.key}.png`,assetPath:selected.assetPath,url:`/api/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(selected.assetPath.slice(7))}`,sourceNodeId:node.id,mediaRole:'extracted-texture'}}]};
}
