import {nativeOutputNode} from './native3d-output.js';
export const BAKE_CHANNELS=[['basecolor','底色'],['normal','法线'],['ao','AO'],['roughness','粗糙度'],['metallic','金属度']];
const modelPath=/^assets\/[a-f0-9]{64}\.(glb|obj)$/i;
const imagePath=/^assets\/[a-f0-9]{64}\.png$/i;
export function nativeBakePreview(node) {
  const live=node?.data;
  if(node?.type!=='native3d'||live?.status!=='completed'||live.error||live.metadata?.operation!=='bake')return null;
  const jobId=live.operation==='bake'?live.nativeJobId:live.operation==='analyze'?live.sourceJobId:null;
  const model=live.operation==='bake'?live.resultAssetPath:live.assetPath;
  if(!/^n3d_[a-f0-9]{32}$/.test(jobId||'')||live.nativeDeliveredJobId!==jobId||!modelPath.test(model||''))return null;
  let output;try{output=nativeOutputNode(node);}catch{return null;}
  const data=output.data;
  if(output.nativeOutputRecordId&&(data.sourceJobId!==jobId||data.nativeDeliveredJobId!==jobId||data.assetPath!==model||data.status!=='completed'||data.error||data.metadata?.operation!=='bake'))return null;
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
  return {jobId,modelAssetPath:model,channels,mode,selected,materialPath:proxy?.assetPath||model};
}
