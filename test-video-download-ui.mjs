import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from './test-browser.mjs';

// Synthetic browser fixture: every request is intercepted; no live inference/service.
const dist = path.resolve(process.env.H3_TEST_DIST_DIR || 'dist');
const origin = 'http://127.0.0.1:8799';
const browser = await chromium.launch({ headless: true });
const failures = [], queued = [];
const makeProject = (readOnly = false) => ({ id: 'prj_download_fixture', name: 'Download fixture', revision: 1, readOnly, shots: [], canvas: {
  viewport: {x: 0, y: 0, zoom: 1},
  nodes: [
    {id:'download1',type:'note',position:{x:40,y:80},data:{title:'Download one',noteRole:'videoDownload'}},
    {id:'download2',type:'note',position:{x:400,y:80},data:{title:'Download two',noteRole:'videoDownload'}},
    {id:'welcome',type:'note',position:{x:40,y:420},data:{title:'Legacy URL import'}},
    {id:'generator',type:'generator',position:{x:750,y:80},data:{title:'Video generator',mode:'reference',status:'idle'}},
  ], edges: [],
} });
async function fixture(readOnly = false) {
  let project = makeProject(readOnly);
  const downloads = [], writes = [];
  let releaseDownload, releaseSave;
  let delaySave = false;
  const waitFor = async (predicate) => { for(let i=0;i<100;i++){if(predicate())return; await new Promise(r=>setTimeout(r,25));} throw new Error('Fixture condition timed out'); };
  const context = await browser.newContext({ viewport: { width: 1360, height: 1040 } });
  await context.addInitScript(() => {
    window.fixtureTools = new Map();
    Object.defineProperty(document, 'modelContext', { value: { registerTool(tool, options) { window.fixtureTools.set(tool.name, tool); options?.signal?.addEventListener('abort', () => window.fixtureTools.delete(tool.name)); } } });
    window.EventSource = class { addEventListener() {} close() {} };
    window.WebSocket = class { addEventListener() {} close() {} };
  });
  await context.route('**/*', async (route) => {
    const request = route.request(), url = new URL(request.url());
    assert.equal(url.origin, origin, 'no external request may escape fixture');
    const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (url.pathname.startsWith('/fixture-')) return route.fulfill({ contentType: 'image/svg+xml', body: `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="${url.pathname.includes('1') ? '#526477' : url.pathname.includes('2') ? '#6e6960' : '#807169'}"/><path d="M0 150L110 60L220 120L320 25V180H0" fill="#aaa79b"/></svg>` });
    if (url.pathname === '/api/projects') return json({ projects: [project] });
    if (url.pathname === '/api/projects/trash') return json({ projects: [] });
    if (url.pathname === '/api/projects/open') return readOnly && !request.postDataJSON()?.readOnly ? json({ error: 'locked' }, 423) : json(project);
    if (url.pathname === `/api/projects/${project.id}`) {
      if (request.method() === 'PUT') {
        writes.push(request.postDataJSON());
        if (delaySave) await new Promise(resolve => { releaseSave = resolve; });
        project = { ...project, ...request.postDataJSON(), revision: project.revision + 1 };
      }
      return json(project);
    }
    if (url.pathname.startsWith('/api/agent/canvas/')) return json({ message: 'native fixture only' }, 503);
    if (url.pathname === '/api/import-video') {
      downloads.push(request.postDataJSON());
      await new Promise(resolve => { releaseDownload = resolve; });
      return json({ name: 'download-fixture.mp4', title: 'Downloaded fixture video', sourceUrl: request.postDataJSON().url });
    }
    if (url.pathname === '/api/settings') return json({ notifications: false, checkUpdatesOnLaunch: false });
    if (url.pathname === '/api/queue') {
      if (request.method() === 'POST') { queued.push(request.postDataJSON()); return json({ id: 'job-fixture', status: 'queued' }); }
      return json({ jobs: [] });
    }
    if (url.pathname === '/api/comfy/system_stats') return json({ devices: [] });
    if (url.pathname.startsWith('/api/')) return json({});
    const file = path.join(dist, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
    return route.fulfill({ contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html', body: await readFile(file) });
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => failures.push(error.message));
  await page.goto(origin); await page.locator('.project-open').click();
  await page.locator('#video-url-download1').waitFor();
  const call = (name, args = {}) => page.evaluate(async ({ name, args }) => JSON.parse(await window.fixtureTools.get(name).execute(args)), { name, args });
  return { page, context, call, downloads, writes, saved: () => project,
    waitFor, delaySave: () => {delaySave=true;}, releaseSave: async () => {await waitFor(()=>Boolean(releaseSave)); delaySave=false;releaseSave();},
    releaseDownload: async () => {await waitFor(()=>Boolean(releaseDownload));releaseDownload();} };
}
try {
  const f = await fixture(); const {page,call,context}=f;
  const first=page.getByTestId('rf__node-download1');
  await first.getByPlaceholder('粘贴抖音 / 小红书分享文字或链接').fill('https://example.com/one');
  await first.getByRole('button',{name:'加载视频链接'}).click();
  await f.waitFor(()=>f.downloads.length===1);
  assert.equal((await call('canvas_create_project',{name:'must not switch'})).ok,false,'download blocks project switch');
  assert.equal(await page.evaluate(()=>{const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);return event.defaultPrevented;}),true,'download participates in unload guard');
  const second=page.getByTestId('rf__node-download2');
  await second.getByPlaceholder('粘贴抖音 / 小红书分享文字或链接').fill('https://example.com/two');
  await second.getByRole('button',{name:'加载视频链接'}).click();
  await second.getByText('另一段视频正在下载或保存，请完成后再导入。').waitFor();
  assert.equal(f.downloads.length,1,'concurrent import does not download a second file');
  f.delaySave(); await f.releaseDownload();
  await f.waitFor(()=>f.writes.length>0);
  assert.equal(await first.getByRole('button',{name:'加载视频链接'}).isDisabled(),true,'success waits for canvas save');
  assert.equal((await call('canvas_create_project',{name:'still must not switch'})).ok,false);
  await f.releaseSave();
  await f.waitFor(()=>f.saved().canvas.nodes.some(n=>n.data.title==='Downloaded fixture video'));
  await page.waitForFunction(()=>document.querySelector('#video-url-download1').value==='');
  assert.equal(f.saved().canvas.nodes.filter(n=>n.data.kind==='video').length,1);
  await page.reload(); await page.waitForFunction(()=>window.fixtureTools.has('canvas_get_state'));
  assert.ok((await call('canvas_get_state')).nodes.some(n=>n.title==='Downloaded fixture video'),'download survives reload');
  await context.close();

  const deletion=await fixture();
  await deletion.page.locator('#video-url-download1').fill('https://example.com/deleted');
  await deletion.page.getByTestId('rf__node-download1').getByRole('button',{name:'加载视频链接'}).click();
  await deletion.waitFor(()=>deletion.downloads.length===1);
  const deleted=deletion.call('canvas_delete_node',{nodeId:'download1'});
  await deletion.page.getByTestId('rf__node-download1').waitFor({state:'detached'});
  await deletion.releaseDownload(); await deleted; await deletion.page.waitForTimeout(100);
  assert.equal((await deletion.call('canvas_get_state')).nodes.some(n=>n.kind==='video'),false,'deleted origin cannot receive async output');
  await deletion.context.close();

  const capacity=await fixture();
  const sources=[];
  for(let i=0;i<3;i++) {
    const created=await capacity.call('canvas_create_node',{preset:'video_asset',title:`Existing ${i}`});
    assert.equal(created.ok,true);
    const state=await capacity.call('canvas_get_state');sources.push(state.nodes.find(n=>n.title===`Existing ${i}`).id);
  }
  await capacity.call('canvas_focus_node',{nodeId:'welcome'}); await capacity.page.waitForTimeout(500);
  await capacity.page.locator('#video-url-input').fill('https://example.com/capacity');
  await capacity.page.getByTestId('rf__node-welcome').getByRole('button',{name:'加载视频链接'}).click();
  await capacity.waitFor(()=>capacity.downloads.length===1);
  const connects=sources.map(sourceId=>capacity.call('canvas_connect_nodes',{sourceId,targetId:'generator'}));
  await capacity.page.waitForFunction(async()=> {
    const state=JSON.parse(await window.fixtureTools.get('canvas_get_state').execute({}));
    return state.edges.filter(e=>e.target==='generator').length===3;
  });
  await capacity.releaseDownload(); await Promise.all(connects); await capacity.page.waitForTimeout(100);
  assert.equal((await capacity.call('canvas_get_state')).nodes.filter(n=>n.kind==='video').length,3,'capacity rechecked after download');
  assert.match(await capacity.page.getByTestId('rf__node-welcome').innerText(),/最多连接 3/);
  await capacity.context.close();
  assert.equal(queued.length,0); assert.deepEqual(failures,[]);
  console.log('VIDEO_DOWNLOAD_UI_OK save barrier, project-switch/unload guard, serial import, reload persistence, deleted target and capacity recheck');
} finally { await browser.close(); }
