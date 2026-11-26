import assert from 'node:assert/strict';
import { createServer, transformWithEsbuild } from 'vite';
import { chromium } from './test-browser.mjs';

// Actual production nodes, mounted in an isolated controlled ReactFlow. No app backend.
const fixture = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {ReactFlow,useNodesState} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {CustomWorkflowNode,BuiltinGeneratorNode,NodeContext} from '/src/CanvasWorkbench.jsx';
import ImageProcessNode from '/src/ImageProcessNode.jsx';
const image='/api/comfy/view?filename=fixture.png&type=output';
window.calls=[];
const actions={getReferences:()=>[],getMentionItems:()=>[],getQwenMask:()=>null,viewTier:'full',openImagePreview:x=>window.calls.push(x),updateNode:()=>{},serverOnline:true,getImageProcessState:()=>({signature:'fixture',refs:[],settings:{}})};
const types={custom:CustomWorkflowNode,builtin:BuiltinGeneratorNode,process:p=><ImageProcessNode {...p} actions={actions}/>};
function App({kind,video}) {
 const [nodes,setNodes,onNodesChange]=useNodesState([{id:'fixture',type:kind,position:{x:80,y:50},data:{title:'fixture',status:'done',mode:kind==='process'?'colorAdjust':video?'reference':'image',resultUrl:image,processedUrl:image,processedAssetPath:'fixture.png',processedSignature:'fixture',workflowDefinition:{inputs:[],outputs:[{type:video?'video':'image'}],parameters:{properties:{seed:{type:'integer',default:42}}}}}}]);
 window.position=()=>nodes[0].position;
 return <NodeContext.Provider value={actions}><ReactFlow nodes={nodes} nodeTypes={types} onNodesChange={onNodesChange} zoomOnDoubleClick={false}/></NodeContext.Provider>;
}
const root=createRoot(document.getElementById('root'));window.show=(kind='custom',video=false)=>{window.calls=[];root.render(<App key={kind+video} kind={kind} video={video}/>)};window.show();`;
const server=await createServer({configFile:false,server:{host:'127.0.0.1',port:0},plugins:[{
 name:'isolated-result-drag',
 transform(code,id){if(id.replaceAll('\\','/').endsWith('/src/CanvasWorkbench.jsx'))return code+'\nexport {CustomWorkflowNode,BuiltinGeneratorNode,NodeContext};';},
 configureServer(s){s.middlewares.use('/result-drag-test',(req,res)=>{res.setHeader('Content-Type','text/html');res.end('<style>html,body,#root{margin:0;width:100%;height:100%}</style><div id="root"></div><script type="module" src="/drag-fixture.jsx"></script>');});},
 resolveId(id){if(id==='/drag-fixture.jsx')return '\0drag-fixture.jsx';},
 async load(id){if(id==='\0drag-fixture.jsx')return(await transformWithEsbuild(fixture,'drag-fixture.jsx',{loader:'jsx',jsx:'automatic'})).code;}
}]});
let browser;
try {
 await server.listen();browser=await chromium.launch({headless:true});
 const page=await browser.newPage({viewport:{width:1600,height:1200}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/**',r=>r.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="red"/></svg>'}));
 await page.goto('http://127.0.0.1:'+server.httpServer.address().port+'/result-drag-test');
 async function drag(locator,dx=70,dy=45,lower=false){await locator.waitFor({state:'visible'});const box=await locator.boundingBox();assert.ok(box);const x=box.x+box.width/2,y=box.y+box.height*(lower?0.95:0.5);await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+dx,y+dy,{steps:12});await page.mouse.up();await page.waitForTimeout(80);}
 for(const kind of ['custom','builtin','process']) {
  await page.evaluate(kind=>show(kind),kind);await page.waitForSelector('.result-compact');
  const preview=page.locator(kind==='process'?'.image-process-preview':'.generator-preview');
  await page.waitForFunction(()=>document.querySelector('.result-compact img')?.naturalWidth>1);
  assert.equal(await preview.locator('img').getAttribute('draggable'),'false');
  const before=await page.evaluate(()=>position());await drag(preview);const after=await page.evaluate(()=>position());
  assert.ok(after.x-before.x>60&&after.y-before.y>35,kind+' image must move ReactFlow node');
  assert.equal(await page.evaluate(()=>calls.length),0);
  await preview.dblclick();assert.equal(await page.evaluate(()=>calls.length),1,kind+' double click opens once');
  assert.equal(await page.evaluate(()=>calls[0].url),'/api/comfy/view?filename=fixture.png&type=output');
  const toggle=page.getByRole('button',{name:'调整设置'});const stationary=await page.evaluate(()=>position());
  await drag(toggle,10,8);assert.deepEqual(await page.evaluate(()=>position()),stationary,kind+' settings button must not drag');
  if(await toggle.getAttribute('aria-expanded')==='false')await toggle.click();
  await page.waitForFunction(()=>document.querySelector('.result-settings-toggle')?.getAttribute('aria-expanded')==='true');
  await page.locator('.result-compact').waitFor({state:'hidden'});
  const control=page.locator(kind==='custom'?'.custom-workflow-params input':kind==='process'?'.image-process-controls input':'.neo-node-title input').first();
  await control.waitFor({state:'visible'});
  assert.equal(await control.isVisible(),true,kind+' expanded control must be visible');
  await drag(control,10,8);assert.deepEqual(await page.evaluate(()=>position()),stationary,kind+' input must not drag');
 }
 for(const kind of ['custom','builtin']){
  await page.evaluate(kind=>show(kind,true),kind);await page.waitForSelector('video');
  const before=await page.evaluate(()=>position());await drag(page.locator('video'),30,0,true);
  assert.deepEqual(await page.evaluate(()=>position()),before,kind+' video controls must not drag');
  await page.locator('video').dblclick({position:{x:15,y:15},force:true});assert.equal(await page.evaluate(()=>calls.length),0);
 }
 assert.deepEqual(errors,[]);console.log('RESULT_NODE_DRAG_OK custom/builtin/process image drag, single preview, settings/input isolation, video control isolation');
} finally {await browser?.close();server.httpServer?.closeAllConnections();await server.close();}

