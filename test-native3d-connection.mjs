import assert from 'node:assert/strict';
import { probeLocalConnection, localConnectionPresentation, EMPTY_METRICS } from './src/local-connection.js';
const healthy = {ok:true,native3dOnly:true,native3d:{service:true},comfy:{enabled:false,running:false}};
const hardware = {cpuPercent:17,ramUsed:12*1024**3,ramTotal:64*1024**3,vramUsed:6*1024**3,vramTotal:24*1024**3,gpuPercent:83,gpuIndex:0,gpuName:'NVIDIA test GPU'};
const requests=[];let refreshed=false;
const fetchImpl=async url=>{
  requests.push(url);
  if(url==='/api/health')return{ok:true,json:async()=>healthy};
  if(url==='/api/native3d/capabilities')return{ok:true,status:200,json:async()=>({operations:{ai_lowpoly:{ready:false}}})};
  if(url==='/api/hardware-metrics')return{ok:true,json:async()=>hardware};
  throw Error(`Unexpected request ${url}`);
};
const native=await probeLocalConnection({fetchImpl});
assert.equal(native.online,false,'native service never enables Comfy image/video generation');
assert.equal(native.native3dOnline,true);assert.equal(native.comfyEnabled,false);
assert.deepEqual(localConnectionPresentation(native),{connected:true,text:'3D服务已连接'});
assert.match(native.label,/ComfyUI未启动/);assert.doesNotMatch(native.label,/检查.*启动|等待.*就绪/);
assert.deepEqual(native.metrics,hardware);
assert.deepEqual(requests,['/api/health','/api/native3d/capabilities','/api/hardware-metrics'],'independent hardware probe, no Comfy or startup request');
const rotated=[];
const restored=await probeLocalConnection({fetchImpl:async url=>{
  rotated.push(url);
  if(url==='/api/health')return{ok:true,json:async()=>healthy};
  if(url==='/') {refreshed=true;return{ok:true,body:{cancel:async()=>{}}};}
  if(url==='/api/native3d/capabilities')return{ok:refreshed,status:refreshed?200:401};
  if(url==='/api/hardware-metrics')return{ok:true,json:async()=>hardware};
  throw Error('No Comfy startup');
}});
assert.equal(restored.sessionRefreshed,true);assert.equal(restored.native3dOnline,true);
assert.deepEqual(rotated,['/api/health','/api/native3d/capabilities','/','/api/native3d/capabilities','/api/hardware-metrics']);
const denied=await probeLocalConnection({fetchImpl:async url=>url==='/api/health'?{ok:true,json:async()=>healthy}:{ok:false,status:403}});
assert.equal(denied.native3dOnline,false);assert.match(denied.label,/会话连接失败/);
assert.deepEqual(localConnectionPresentation(denied),{connected:false,text:'3D服务未连接'});
const absent=await probeLocalConnection({fetchImpl:async()=>({ok:true,json:async()=>({...healthy,native3d:{service:false}})})});
assert.equal(absent.native3dOnline,false);assert.match(absent.label,/3D服务未就绪/);
assert.deepEqual(localConnectionPresentation({online:true}),{connected:true,text:'本地已连接'});
assert.deepEqual(localConnectionPresentation({online:false},true),{connected:false,text:'正在启动…'});
const standard=await probeLocalConnection({fetchImpl:async url=>url==='/api/health'?{ok:true,json:async()=>({ok:true})}:url==='/api/comfy/system_stats'?{ok:true,json:async()=>({devices:[]})}:{ok:true,json:async()=>({cpuPercent:11})}});
assert.equal(standard.online,true);assert.equal(standard.metrics.cpuPercent,11);
const comfyOffline=await probeLocalConnection({fetchImpl:async url=>{
  if(url==='/api/health')return{ok:true,json:async()=>({ok:true})};
  if(url==='/api/hardware-metrics')return{ok:true,json:async()=>hardware};
  return{ok:false,status:503};
}});
assert.equal(comfyOffline.online,false);assert.deepEqual(comfyOffline.metrics,hardware);
const noGpu=await probeLocalConnection({fetchImpl:async url=>{
  if(url==='/api/health')return{ok:true,json:async()=>healthy};
  if(url==='/api/native3d/capabilities')return{ok:true,status:200};
  return{ok:true,json:async()=>({cpuPercent:0,ramUsed:123,ramTotal:456,gpuPercent:NaN,vramUsed:-1})};
}});
assert.equal(noGpu.native3dOnline,true);assert.equal(noGpu.metrics.cpuPercent,0);
assert.equal(noGpu.metrics.vramUsed,null);assert.equal(noGpu.metrics.gpuPercent,null);
const monitorFailed=await probeLocalConnection({fetchImpl:async url=>{
  if(url==='/api/health')return{ok:true,json:async()=>healthy};
  if(url==='/api/native3d/capabilities')return{ok:true,status:200};
  throw Error('hardware monitor unavailable');
}});
assert.equal(monitorFailed.native3dOnline,true);assert.deepEqual(monitorFailed.metrics,EMPTY_METRICS);
console.log('NATIVE3D_CONNECTION_OK independent hardware, Comfy stays disabled, auth renewal, unavailable GPU and monitor isolation');
