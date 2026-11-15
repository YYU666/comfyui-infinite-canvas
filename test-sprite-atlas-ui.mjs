// Standalone component/hook fixture. No canvas application, project server,
// ComfyUI endpoint, user browser profile, or production service is used.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from './test-browser.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(root, '.cache', 'sprite-component-test');
await mkdir(fixture, { recursive: true });
await writeFile(path.join(fixture, 'index.html'), '<html><body style="background:#111"><div id="root"></div><script type="module" src="./entry.jsx"></script></body></html>');
await writeFile(path.join(fixture, 'entry.jsx'), `
import React, {useState,useRef,useCallback} from 'react';
import {createRoot} from 'react-dom/client';
import SpriteAtlasNode from '/src/SpriteAtlasNode.jsx';
import {useSpriteAtlas} from '/src/sprite-atlas-canvas.js';
function Fixture(){
 const [nodes,setNodes]=useState([{id:'sprite',type:'spriteAtlas',data:{title:'3D 角色转多方向图集',status:'idle'}}]);
 const [readOnly,setReadOnly]=useState(false),[version,setVersion]=useState(0);
 const nodesRef=useRef(nodes);nodesRef.current=nodes;
 const project={id:'prj_fixture',readOnly},projectRef=useRef(project);projectRef.current=project;
 const revisionRef=useRef(1),switchingRef=useRef(false),localImageJobsRef=useRef(new Map());
 const updateNode=useCallback((id,patch)=>setNodes(ns=>ns.map(n=>n.id===id?{...n,data:{...n.data,...patch}}:n)),[]);
 const persistProject=useCallback(async()=>{revisionRef.current+=1;},[]);
 const actions=useSpriteAtlas({project,projectRef,revisionRef,switchingRef,nodes,nodesRef,updateNode,persistProject,localImageJobsRef,setLocalImageJobsVersion:setVersion});
 return <><button onClick={()=>setReadOnly(v=>!v)}>测试只读</button><button onClick={()=>actions.runSpriteAtlas('sprite')}>测试直接运行</button><span id="readonly">{String(readOnly)}</span><SpriteAtlasNode id="sprite" data={nodes[0].data} actions={{...actions,updateNode,readOnly,isImageProcessBusy:id=>localImageJobsRef.current.has(id)}} title={<h2>3D 角色转多方向图集</h2>}/><pre id="state">{JSON.stringify(nodes[0].data)}</pre><span id="version">{version}</span></>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
`);
const server = await createServer({ root, configFile: false, plugins: [react()], server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
let browser;
try {
  await server.listen();
  const address = server.httpServer.address();
  assert.ok(![8188, 8189, 8790, 8791].includes(address.port));
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1000, height: 1100 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  let jobs = 0, outcome = 'running', submitted, cancellations = 0;
  const apiRequests = [];
  await page.route('**/api/sprite-atlas/**', async route => {
    const request = route.request(), url = new URL(request.url()); apiRequests.push(url.pathname);
    if (url.pathname.endsWith('/status')) return route.fulfill({ json: { available: true, backend: 'blender-cpu' } });
    if (url.pathname.endsWith('/cancel')) { cancellations++; return route.fulfill({ json: { status: 'cancelled' } }); }
    if (request.method() === 'POST') {
      submitted = request.postDataJSON(); jobs++;
      return route.fulfill({ status: 202, json: { id: 'spa_' + String(jobs).padStart(32, '0'), status: 'queued' } });
    }
    if (url.pathname.includes('/files/')) return route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64') });
    const id = url.pathname.split('/').at(-1);
    const files = Object.fromEntries(Object.entries({ albedo: 'albedo.png', normal: 'normal.png', metadata: 'atlas.json' }).map(([key, name]) => [key, '/api/sprite-atlas/jobs/' + id + '/files/' + name]));
    return route.fulfill({ json: { id, status: outcome, ...(outcome === 'done' ? { files } : {}), ...(outcome === 'error' ? { error: 'fixture import failure' } : {}) } });
  });
  await page.goto(`http://127.0.0.1:${address.port}/.cache/sprite-component-test/index.html`);
  await page.getByText('Blender 已就绪', { exact: true }).waitFor();
  const render = () => page.getByRole('button', { name: '渲染精灵图集', exact: true });
  const state = async () => JSON.parse(await page.locator('#state').textContent());
  assert.equal(await render().isDisabled(), true);
  await page.getByLabel('角色文件路径').fill('C:/synthetic/角色.glb');
  await page.getByLabel('精灵方向数').selectOption('16');
  await page.getByLabel('精灵单帧尺寸').fill('64');
  await render().click();
  await page.getByRole('button', { name: '取消渲染' }).waitFor();
  assert.equal(submitted.options.directions, 16); assert.equal(submitted.options.frameSize, 64);
  assert.equal(submitted.inputPath, 'C:/synthetic/角色.glb'); assert.equal(submitted.nodeId, 'sprite');
  await page.getByRole('button', { name: '测试只读', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: '取消渲染' }).isDisabled(), true);
  await page.getByRole('button', { name: '测试直接运行' }).click(); assert.equal(jobs, 1);
  await page.getByRole('button', { name: '测试只读', exact: true }).click();
  outcome = 'done';
  await page.getByText('当前参数的图集', { exact: true }).waitFor();
  const firstFiles = (await state()).spriteFiles;
  assert.ok(firstFiles.albedo.endsWith('/files/albedo.png'));
  assert.equal(await page.getByRole('link', { name: '下载 PNG' }).count(), 2);
  await page.screenshot({ path: path.join(fixture, 'standalone-component.png') });
  await page.getByLabel('精灵单帧尺寸').fill('96');
  await page.getByText('上次成功结果 · 参数已改变', { exact: true }).waitFor();
  outcome = 'error'; await render().click();
  await page.getByRole('alert').filter({ hasText: 'fixture import failure' }).waitFor();
  assert.deepEqual((await state()).spriteFiles, firstFiles, 'failed retry preserves prior real output');
  assert.equal(await page.getByLabel('角色文件路径').inputValue(), 'C:/synthetic/角色.glb');
  outcome = 'running'; await render().click();
  await page.getByRole('button', { name: '取消渲染' }).click();
  await page.getByRole('alert').filter({ hasText: '精灵图渲染已取消' }).waitFor();
  assert.equal(cancellations, 1); assert.equal((await state()).status, 'cancelled');
  await page.getByRole('button', { name: '测试只读', exact: true }).click();
  await page.getByRole('button', { name: '测试直接运行' }).click(); assert.equal(jobs, 3);
  assert.equal(await page.getByLabel('角色文件路径').isDisabled(), true);
  assert.equal(await render().isDisabled(), true);
  assert.ok(apiRequests.every(url => url.startsWith('/api/sprite-atlas/')));
  assert.deepEqual(errors, []);
  console.log('SPRITE_ATLAS_COMPONENT_OK standalone fixture parameters output links stale failure preservation readonly cancellation; no canvas/Comfy service');
} finally {
  await browser?.close(); await server.close();
}
