import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

// Exercise the component's real frame callback/effects without requiring a DOM or GPU.
const compiled=await build({entryPoints:['src/PcgViewportPanel.jsx'],bundle:true,write:false,format:'esm',platform:'node',jsx:'transform',plugins:[{
  name:'panel-lifecycle-doubles',setup(builder){
    builder.onResolve({filter:/^react$/},()=>({path:'react',namespace:'panel-test'}));
    builder.onResolve({filter:/renderer\.js$/},()=>({path:'renderer',namespace:'panel-test'}));
    builder.onLoad({filter:/.*/,namespace:'panel-test'},({path})=>({contents:path==='react'?`
      const h=globalThis.__pcgPanelTest;
      export function useRef(value){return {current:value};}
      export function useState(value){const index=h.states.length;h.states.push(value);return [value,next=>{h.states[index]=typeof next==='function'?next(h.states[index]):next;}];}
      export function useEffect(effect){h.effects.push(effect);}
      export default {createElement(type,props,...children){if(props?.ref)props.ref.current=type==='section'?{parentElement:{clientWidth:1000,clientHeight:700}}:{};return {type,props,children};}};
    `:`export function createViewer(_canvas,options){const h=globalThis.__pcgPanelTest;h.frame=options.onFrame;return {dispose(){},getState(){return {metrics:{},resources:{liveBuffers:0}};}};}`}));
    builder.onLoad({filter:/\.css$/},()=>({contents:'',loader:'js'}));
  },
}]});

test('panel republishes released counters after early draw loss and restores unchanged desired',async()=>{
  const h={effects:[],states:[]};globalThis.__pcgPanelTest=h;
  const previousWindow=globalThis.window,previousFetch=globalThis.fetch;
  globalThis.window={location:{origin:'http://127.0.0.1:18790'}};
  let fetchSignal;globalThis.fetch=(_url,options)=>{fetchSignal=options.signal;return new Promise(()=>{});};
  const cleanups=[];
  try{
    const {default:Panel}=await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
    const handle={projectId:'p',nodeId:'n',revision:1,descriptorVersion:1,operationVersion:1,runId:'r',jobId:'pcg_'+'a'.repeat(32),inputHash:'b'.repeat(64)};
    const artifactId='pcga_'+'c'.repeat(64),desired={artifactId,sha256:'d'.repeat(64),bytes:512,format:'glb',role:'model',graphRevision:1,generation:7,handle,url:`/api/pcg/artifacts/${artifactId}?${new URLSearchParams(handle)}`};
    const reports=[];
    Panel({state:{open:true,projectId:'p',nodeId:'n',generation:7,desired},onRendered:report=>reports.push(report)});
    for(const effect of h.effects){const cleanup=effect();if(cleanup)cleanups.push(cleanup);}
    assert.ok(fetchSignal&&!fetchSignal.aborted);
    const early={contextLost:false,error:{code:'CONTEXT_LOST',message:'draw detected loss'},metrics:{instanceCount:42,gpuBytes:10776},resources:{liveBuffers:5,liveBytes:10776}};
    h.frame(early);
    assert.equal(fetchSignal.aborted,true);assert.equal(reports.at(-1).resources.liveBuffers,5);assert.equal(reports.at(-1).rendered,false);assert.equal(reports.at(-1).identity.artifactId,artifactId);assert.equal(reports.at(-1).identity.generation,7);
    const released={contextLost:true,error:{code:'CONTEXT_LOST',message:'DOM context loss'},metrics:{instanceCount:0,gpuBytes:0},resources:{liveBuffers:0,liveBytes:0}};
    h.frame(released);
    assert.equal(reports.length,2);assert.equal(reports.at(-1).status,'context-lost');assert.equal(reports.at(-1).resources.liveBuffers,0);assert.equal(reports.at(-1).metrics.gpuBytes,0);assert.equal(reports.at(-1).identity.artifactId,artifactId);assert.equal(h.states[1].identity,null);
    const reloadBefore=h.states[3];h.frame({contextLost:false,error:null,loadedIdentity:null,sceneFrameCount:0,cameraFramed:false,metrics:{},resources:{}});
    assert.equal(h.states[3],reloadBefore+1);assert.equal(h.states[1].status,'ready');assert.equal(h.states[1].identity,null);assert.equal(reports.length,2);
  }finally{
    for(const cleanup of cleanups.reverse())cleanup();
    globalThis.window=previousWindow;globalThis.fetch=previousFetch;delete globalThis.__pcgPanelTest;
  }
});
