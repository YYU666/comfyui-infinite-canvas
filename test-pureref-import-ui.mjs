import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, samePath } from './test-browser.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const python = process.env.H3_TEST_PYTHON || 'python';
const temporary = await mkdtemp(path.join(tmpdir(), 'h3-pureref-import-'));
const evidence = process.env.PUREREF_EVIDENCE || path.join(root, '.cache', 'qa', 'pureref-import');
await mkdir(evidence, { recursive: true });
const fixturePath = path.join(temporary, 'synthetic.pur');
const generated = spawnSync(python, ['-X', 'utf8', '-c', "import sys;sys.path.insert(0,'.');from pathlib import Path;from test_pureref_import import fixture,raster;Path(sys.argv[1]).write_bytes(fixture([(0,1,raster(),12,8),(1,1,raster('blue',kind='JPEG'),12,8),(2,2,None,12,8),(3,1,b'orphan',12,8)],[(0,0),(1,0),(2,1),(3,2)]))", fixturePath], { cwd: root, encoding: 'utf8' });
assert.equal(generated.status, 0, generated.stderr);
const raw = await readFile(process.env.PUREREF_UI_FIXTURE || fixturePath);
const runtime = path.join(temporary, 'runtime'), projects = path.join(temporary, 'projects');
const backend = spawn(python, ['-X', 'utf8', 'video_workbench_launcher.py'], { cwd: root, env: { ...process.env,
  QWEN_API_KEY: '', DASHSCOPE_API_KEY: '', MOONSHOT_API_KEY: '', KIMI_API_KEY: '', ARK_API_KEY: '', DOUBAO_API_KEY: '', DEEPSEEK_API_KEY: '',
  H3_WORKBENCH_RUNTIME_DIR: runtime, H3_PROJECTS_ROOT: projects, H3_WORKBENCH_DATA_DIR: path.join(temporary, 'data'), H3_COMFY_ROOT: path.join(temporary, 'comfy'),
  H3_COMFY_URL: 'http://127.0.0.1:1', H3_WORKBENCH_NO_BROWSER: '1', H3_WORKBENCH_TEST_MODE: '1',
  H3_WORKBENCH_DIST_DIR: path.resolve(process.env.H3_TEST_DIST_DIR || path.join(root, 'dist')), PYTHONUTF8: '1',
}, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '', base, token, browser;
for (const stream of [backend.stdout, backend.stderr]) stream.on('data', chunk => { logs = (logs + chunk).slice(-6000); });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, timeout = 25000) { const end = Date.now() + timeout; while (Date.now() < end) { const value = await read(); if (value) return value; await pause(100); } throw new Error('PureRef UI timed out'); }
async function api(route, payload, method = payload ? 'POST' : 'GET') {
  const response = await fetch(base + route, { method, headers: { 'X-H3-Token': token, ...(payload ? { 'Content-Type': 'application/json' } : {}) }, ...(payload ? { body: JSON.stringify(payload) } : {}) });
  const body = await response.json(); assert.ok(response.ok, JSON.stringify(body)); return body;
}
try {
  const instance = await until(async () => { try { return JSON.parse(await readFile(path.join(runtime, 'instance.json'), 'utf8')); } catch { if (backend.exitCode !== null) throw new Error(logs); return null; } });
  base = `http://127.0.0.1:${instance.port}`; token = instance.token;
  const health = await api('/api/health'); assert.equal(health.pid, backend.pid); assert.ok(samePath(health.projectsRoot, projects));
  const fixture = await api('/api/projects', { name: 'PureRef isolated synthetic QA', canvas: { nodes: [{ id: 'preserved-note', type: 'note', position: { x: 0, y: 0 }, data: { title: '保留原节点', text: 'synthetic only' } }], edges: [], viewport: { x: 20, y: 20, zoom: 1 } } });
  const create = headers => fetch(base + '/api/pureref/sessions', { method: 'POST', headers, body: JSON.stringify({projectId:fixture.id,size:raw.length}) });
  assert.equal((await create({ 'Content-Type': 'application/json' })).status, 401);
  assert.equal((await create({ 'X-H3-Token': token, Origin: 'https://untrusted.example', 'Content-Type':'application/json' })).status, 403);
  assert.equal((await create({ 'X-H3-Token': token, 'Content-Type':'text/plain' })).status, 415);
  const session = await (await create({ 'X-H3-Token': token, 'Content-Type':'application/json' })).json();
  const sessionHeaders = {'X-H3-Token':token,'X-PureRef-Session':session.capability};
  const endpoint = base + '/api/pureref/sessions/' + session.id;
  const sent = await fetch(endpoint+'/upload',{method:'PUT',headers:{...sessionHeaders,'Content-Type':'application/octet-stream','X-Upload-Offset':'0'},body:raw}); assert.equal(sent.status,200);
  assert.equal((await fetch(endpoint+'/finish',{method:'POST',headers:{...sessionHeaders,'Content-Type':'application/json'},body:'{}'})).status,202);
  const status = await until(async()=>{const value=await (await fetch(endpoint+'/status',{headers:sessionHeaders})).json(); if(value.phase==='error') throw new Error(value.message); return value.phase==='ready'?value:null;});
  const parsed = {...status,...await (await fetch(endpoint+'/resources?limit=64',{headers:sessionHeaders})).json()};
  assert.ok(parsed.images.length >= 2); assert.ok(!JSON.stringify(parsed).includes('PRIVATE-PATH'));
  await fetch(endpoint,{method:'DELETE',headers:sessionHeaders});
  const read = () => api(`/api/projects/${fixture.id}`);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1800, height: 1300 } });
  const errors = [], publishedCounts = []; let upstreamCalls = 0;
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://**', route => { upstreamCalls++; return route.abort(); });
  page.on('request', request => { if (request.method() === 'PUT' && request.url() === `${base}/api/projects/${fixture.id}`) publishedCounts.push(request.postDataJSON().canvas.nodes.filter(node => node.data.importedFrom?.format === 'PureRef').length); });
  await page.goto(base); await page.locator('.project-open').click(); await page.locator('.neo-canvas-wrap').waitFor();
  const choose = buffer => page.getByLabel('选择 PureRef 文件').setInputFiles({ name: 'synthetic-board.pur', mimeType: 'application/octet-stream', buffer });
  const dialog = page.getByRole('dialog', { name: '导入 PureRef 图片', exact: true });
  const imported = document => document.canvas.nodes.filter(node => node.data.importedFrom?.format === 'PureRef');
  await choose(Buffer.from('not a pur file')); await dialog.getByRole('alert').waitFor(); assert.equal(imported(await read()).length, 0); await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await choose(raw); await dialog.getByRole('button', { name: `导入 ${parsed.images.length} 张图片`, exact: true }).waitFor();
  await until(async () => await dialog.locator('.pureref-previews img').count() === Math.min(12, parsed.images.length)); assert.equal(imported(await read()).length, 0);
  await page.screenshot({ path: path.join(evidence, 'preview.png') });
  await dialog.getByRole('button', { name: '关闭', exact: true }).click(); assert.equal(imported(await read()).length, 0);
  // Uncommitted chunk retry and finish lost-ACK recovery preserve the session.
  let chunkAttempts=0, finishAttempts=0, currentCopyCommitted=false, releaseCurrentCopy;
  const currentCopyGate=new Promise(resolve=>{releaseCurrentCopy=resolve;});
  await page.route('**/api/pureref/sessions/*/upload',route=>++chunkAttempts===1?route.abort('failed'):route.continue());
  await page.route('**/api/pureref/sessions/*/finish',async route=>{if(++finishAttempts===1){await route.fetch();return route.abort('failed');}return route.continue();});
  await page.route('**/api/pureref/sessions/*/resources/*/copy',async route=>{
    const response=await route.fetch();currentCopyCommitted=true;await currentCopyGate;return route.fulfill({response});
  });
  await choose(raw);await dialog.getByRole('button',{name:`导入 ${parsed.images.length} 张图片`,exact:true}).click();
  await until(()=>currentCopyCommitted);await dialog.getByRole('button',{name:'取消导入',exact:true}).click();
  await dialog.getByText(/等待当前本地请求结束/).waitFor();releaseCurrentCopy();
  await until(async()=>/已取消/.test(await dialog.textContent()));assert.equal(imported(await read()).length,0);
  assert.equal(chunkAttempts,2);assert.equal(finishAttempts,2);
  await dialog.getByRole('button',{name:'关闭',exact:true}).click();
  await page.unroute('**/api/pureref/sessions/*/upload');await page.unroute('**/api/pureref/sessions/*/finish');await page.unroute('**/api/pureref/sessions/*/resources/*/copy');
  // The cancelled in-flight copy's revision was learned by the current writer:
  // an ordinary media save must succeed immediately, without refreshing revision.
  const cancelledDocument=await read();const cancelledAsset=cancelledDocument.assets[0];
  const cancelledOriginal=await fetch(base+`/api/projects/${fixture.id}/`+cancelledAsset.path,{headers:{'X-H3-Token':token}});
  await drop(Buffer.from(await cancelledOriginal.arrayBuffer()),'cancel-revision-image.png',cancelledAsset.mime);
  await until(async()=>(await read()).canvas.nodes.some(node=>node.data.name==='cancel-revision-image.png'&&node.data.assetPath));
  // A second upload failure cannot publish the first uploaded image as a node.
  let uploads = 0;
  await page.route('**/api/pureref/sessions/*/resources/*/copy', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    uploads++; if (uploads === 2) return route.fulfill({ status: 500, json: { code: 'SYNTHETIC_DISK_ERROR', message: '合成磁盘写入失败' } });
    return route.continue();
  });
  await choose(raw); await dialog.getByRole('button', { name: `导入 ${parsed.images.length} 张图片`, exact: true }).click();
  await dialog.getByRole('alert').waitFor(); assert.equal(imported(await read()).length, 0); await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await page.unroute('**/api/pureref/sessions/*/resources/*/copy');
  // Real browser drop dispatch (not a direct importer call).
  async function drop(buffer, name, mime, selector = '.neo-canvas-wrap') {
    const transfer = await page.evaluateHandle(({ data, name, mime }) => { const dt = new DataTransfer(); dt.items.add(new File([Uint8Array.from(atob(data), char => char.charCodeAt(0))], name, { type: mime })); return dt; }, { data: buffer.toString('base64'), name, mime });
    await page.locator(selector).first().dispatchEvent('drop', { dataTransfer: transfer, clientX: 400, clientY: 350 }); await transfer.dispose();
  }
  let lostCopyAck=false;const repeatedCopyRevisions=[];
  await page.route('**/api/pureref/sessions/*/resources/*/copy',async route=>{
    if(!lostCopyAck){lostCopyAck=true;repeatedCopyRevisions.push(route.request().headers()['if-match']);await route.fetch();return route.abort('failed');}
    if(repeatedCopyRevisions.length===1)repeatedCopyRevisions.push(route.request().headers()['if-match']);
    return route.continue();
  });
  await drop(raw, 'synthetic-board.pur', 'application/octet-stream');
  await dialog.getByRole('button', { name: `导入 ${parsed.images.length} 张图片`, exact: true }).click();
  await until(async () => /已导入并保存/.test(await dialog.textContent()));
  assert.equal(repeatedCopyRevisions.length,2);assert.equal(repeatedCopyRevisions[0],repeatedCopyRevisions[1]);await page.unroute('**/api/pureref/sessions/*/resources/*/copy');
  let saved = await read(); const added = imported(saved); assert.equal(added.length, parsed.images.length);
  assert.ok(saved.canvas.nodes.some(node => node.id === 'preserved-note'));
  assert.ok(publishedCounts.every(count => count === 0 || count === parsed.images.length), 'content writes never publish a partial batch');
  assert.ok(!JSON.stringify(saved).includes('PRIVATE-PATH')); assert.ok(added.every(node => node.type === 'media' && node.data.kind === 'image'));
  for (const image of parsed.images) {
    const node = added.find(node => node.data.name === image.name); assert.ok(node.data.assetPath.includes(image.sha256));
    const response = await fetch(base + `/api/projects/${fixture.id}/` + node.data.assetPath, { headers: { 'X-H3-Token': token } });
    assert.equal(createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex'), image.sha256);
  }
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await page.reload(); await page.locator(`.react-flow__node[data-id="${added[0].id}"]`).waitFor();
  assert.equal(imported(await read()).length, parsed.images.length);
  // Capture .pur even over a media child whose ordinary image-drop handler stops bubbling.
  await drop(raw, 'synthetic-board.pur', 'application/octet-stream', `.react-flow__node[data-id="${added[0].id}"] .media-preview`);
  await dialog.getByRole('button', { name: `导入 ${parsed.images.length} 张图片`, exact: true }).waitFor(); await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await page.locator(`.react-flow__node[data-id="${added[0].id}"]`).getByRole('button', { name: '电子主美 · 图解分析', exact: true }).click();
  saved = await until(async () => { const document = await read(); return document.canvas.edges.some(edge => edge.source === added[0].id && edge.targetHandle === 'artwork') ? document : null; });
  assert.ok(saved.canvas.nodes.some(node => node.type === 'artDirector'));
  const ordinary = await fetch(base + `/api/projects/${fixture.id}/` + added[0].data.assetPath, {headers:{'X-H3-Token':token}});
  await drop(Buffer.from(await ordinary.arrayBuffer()), 'normal-image.png', parsed.images[0].mime);
  await until(async () => (await read()).canvas.nodes.some(node => node.data.name === 'normal-image.png' && node.data.assetPath));
  await page.screenshot({ path: path.join(evidence, 'imported-canvas.png') });
  assert.deepEqual((await api('/api/queue')).jobs, []); assert.deepEqual(errors, []); assert.equal(upstreamCalls, 0);
  await writeFile(path.join(evidence, 'receipt.json'), JSON.stringify({ fixtureId: fixture.id, isolatedPort: instance.port, imported: added.length, duplicates: parsed.duplicates, skippedExternal: parsed.skippedExternal,
    failedUploadNoNodes: true, chunkUncommittedRetry: true, finishLostAck: true, copyLostAckSameRevision: true, cancelInFlightCopyNoNodesAndRevisionLearned: true, previewNoNodes: true, atomicPublication: true, originalBytes: true, reload: true, mediaChildDrop: true, ordinaryImageDrop: true, artDirectorConnection: true, tokenOriginMimeGuards: true, paidCalls: 0, userProjectTouched: false }, null, 2));
  console.log('PUREREF_UI_OK actualParser originalBytes preview failureAtomicity drop mediaChildDrop persistedReload ordinaryImageDrop artDirectorConnection paidCalls=0 evidence=' + evidence);
} catch (error) {
  await writeFile(path.join(evidence, 'failure.txt'), logs + '\n' + error.stack); throw error;
} finally {
  if (browser) await browser.close();
  if (base) { try { await api('/api/shutdown', {}); } catch {} }
  if (backend.exitCode === null) { await Promise.race([new Promise(resolve => backend.on('exit', resolve)), pause(5000)]); if (backend.exitCode === null) backend.kill(); }
}
