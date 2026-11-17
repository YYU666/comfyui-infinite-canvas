import assert from 'node:assert/strict';
import { imageProcessSnapshot } from './src/image-process-graph.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { chromium } from './test-browser.mjs';

import { PROJECT_SESSION_KEY } from './src/project-session.js';

// Synthetic origin only: no live project, service, GPU, or user media is accessed.
const origin = 'http://thumbnail-fixture.test';
const dist = path.resolve(process.env.H3_TEST_DIST_DIR || 'dist');
function png(width, height) {
  const crc = (buffer) => { let n = 0xffffffff; for (const byte of buffer) { n ^= byte; for (let bit = 0; bit < 8; bit++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; } return (n ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const label = Buffer.from(type), length = Buffer.alloc(4), checksum = Buffer.alloc(4); length.writeUInt32BE(data.length); checksum.writeUInt32BE(crc(Buffer.concat([label, data]))); return Buffer.concat([length, label, data, checksum]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.alloc((width * 3 + 1) * height))), chunk('IEND', Buffer.alloc(0))]);
}
const original = png(1600, 900), thumbnail = png(640, 360);
let project = { id: 'prj_thumbnail_fixture', name: 'Thumbnail fixture', revision: 1, shots: [], canvas: {
  viewport: { x: 0, y: 0, zoom: 1 }, nodes: [
    { id: 'source', type: 'media', position: { x: 40, y: 120 }, data: { title: 'Original source', kind: 'image', localFile: true, assetPath: 'assets/source.png', name: 'source.png' } },
    { id: 'output', type: 'media', position: { x: 550, y: 120 }, data: { title: 'Comfy output', kind: 'image', output: true, url: '/api/comfy/view?filename=generated.png&type=output', name: 'generated.png' } },
    { id: 'third', type: 'media', position: { x: 40, y: 760 }, data: { title: 'Queued cold preview', kind: 'image', localFile: true, assetPath: 'assets/third.png' } },
    { id: 'generator', type: 'generator', position: { x: 1080, y: 580 }, data: { title: 'Synthetic generator', mode: 'qwenEdit', qwenVersion: 'flux3_klein', prompt: 'Keep 图1 then 图2.', ratio: '16:9', seed: 42, randomSeed: false } },
    { id: 'finished', type: 'generator', position: { x: 1080, y: 100 }, data: {title:'Finished portrait',mode:'qwenEdit',status:'done',resultUrl:'/api/comfy/view?filename=portrait.png&type=output'} },
    { id: 'video-result', type:'generator',position:{x:48000,y:120},data:{title:'Finished video',mode:'customWorkflow',status:'done',resultUrl:'/api/comfy/view?filename=video.mp4&type=output', workflowDefinition:{inputs:[{id:"face",label:"Face reference",type:"image"},{id:"body",label:"Body reference",type:"image"}],outputs:[{type:'video'}],parameters:{properties:{}}}}},
    {id:'clip',type:'media',position:{x:47500,y:900},data:{title:'Video input',kind:'video',url:'/api/comfy/view?filename=clip.mp4&type=output'}},
    {id:'ref-generator',type:'generator',position:{x:48000,y:900},data:{title:'Video reference generator',mode:'reference',prompt:'Reference video',ratio:'9:16'}},
    ...Array.from({ length: 99 }, (_, index) => ({ id: `far-${index}`, type: 'media', position: { x: 8000 + index * 400, y: 120 }, data: { title: `Offscreen ${index}`, kind: 'image', localFile: true, assetPath: `assets/far-${index}.png` } })),
  ], edges: [
    {id:'video-reference',source:'clip',sourceHandle:'ref',target:'ref-generator',targetHandle:'references'},
    { id: 'first', source: 'source', sourceHandle: 'ref', target: 'generator', targetHandle: 'references' },
    { id: 'second', source: 'output', sourceHandle: 'ref', target: 'generator', targetHandle: 'references' },
  ],
} };
const processed = { id:'processed', type:'imageProcess', position:{x:51000,y:200}, data:{title:'Completed adjustment',mode:'colorAdjust',status:'done',brightness:10,processedAssetPath:'assets/processed.png',processedUrl:`/api/projects/${project.id}/assets/processed.png`} };
project.canvas.nodes.push(processed);
project.canvas.edges.push({id:'source-processed',source:'source',sourceHandle:'ref',target:'processed',targetHandle:'guide'});
processed.data.processedSignature=imageProcessSnapshot(processed.id,project.canvas.nodes,project.canvas.edges).signature;
// Each completed mode has separate offscreen originals so a prior preview or
// browser cache cannot hide a histogram/mask read while its settings are closed.
function completedProcess(id, x, settings, slots) {
  const node = { id, type: 'imageProcess', position: { x, y: 200 }, data: {
    title: `Completed ${id}`, mode: 'colorAdjust', status: 'done', ...settings,
    processedAssetPath: `assets/${id}-result.png`, processedUrl: `/api/projects/${project.id}/assets/${id}-result.png`,
  } };
  project.canvas.nodes.push(node);
  for (const slot of slots) {
    const sourceId = `${id}-${slot}`;
    project.canvas.nodes.push({ id: sourceId, type: 'media', position: { x: -10000, y: -10000 }, data: {
      kind: 'image', title: sourceId, localFile: true, assetPath: `assets/${sourceId}.png`,
    } });
    project.canvas.edges.push({ id: `${sourceId}-input`, source: sourceId, sourceHandle: 'ref', target: id, targetHandle: slot });
  }
  node.data.processedSignature = imageProcessSnapshot(id, project.canvas.nodes, project.canvas.edges).signature;
}
completedProcess('processed-levels', 53000, { adjustmentType: 'levels' }, ['guide']);
completedProcess('processed-curves', 55000, { adjustmentType: 'curves' }, ['guide']);
completedProcess('processed-blend', 57000, { mode: 'imageBlend' }, ['base', 'overlay', 'mask']);
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1800, height: 1100 }, serviceWorkers: 'block' });
const thumbnails = [], originals = [], uploads = [], queued = [], errors = [];
let thumbnailFailure = false;
let thumbnailActive = 0, thumbnailPeak = 0;
await context.addInitScript(({ key, id }) => {
  sessionStorage.setItem(key, JSON.stringify({ version: 1, id, readOnly: false }));
  window.fixtureTools = new Map();
  Object.defineProperty(document, 'modelContext', { value: { registerTool(tool, options) { window.fixtureTools.set(tool.name, tool); options?.signal?.addEventListener('abort', () => window.fixtureTools.delete(tool.name)); } } });
  window.EventSource = class { addEventListener() {} close() {} };
  window.WebSocket = class { addEventListener() {} close() {} };
}, { key: PROJECT_SESSION_KEY, id: project.id });
await context.route('**/*', async (route) => {
  const request = route.request(), url = new URL(request.url());
  assert.equal(url.origin, origin, 'all requests stay on isolated fixture');
  const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  if (url.pathname === '/api/thumbnails') {
    thumbnails.push(url.search);
    thumbnailPeak = Math.max(thumbnailPeak, ++thumbnailActive);
    await new Promise((resolve) => setTimeout(resolve, 500)); // Cold derivative work occupies a slot.
    thumbnailActive--;
    return thumbnailFailure ? json({ message: 'fixture cache unavailable' }, 503) : route.fulfill({ contentType: 'image/png', body: thumbnail });
  }
  if ((url.pathname.startsWith('/api/projects/') && url.pathname.includes('/assets/')) || url.pathname === '/api/comfy/view') {
    originals.push(url.pathname + url.search);
    return route.fulfill({ contentType: 'image/png', body: original });
  }
  if (url.pathname === '/api/projects') return json({ projects: [project] });
  if (url.pathname === '/api/projects/trash') return json({ projects: [] });
  if (url.pathname === '/api/projects/open') return json(project);
  if (url.pathname === `/api/projects/${project.id}`) {
    if (request.method() === 'PUT') project = { ...project, ...request.postDataJSON(), revision: project.revision + 1 };
    return json(project);
  }
  if (url.pathname === '/api/comfy/upload/image') {
    uploads.push(request.postDataBuffer());
    return json({ name: `reference-${uploads.length}.png`, subfolder: 'workbench' });
  }
  if (url.pathname === '/api/queue') {
    if (request.method() === 'POST') { queued.push(request.postDataJSON()); return json({ id: 'synthetic-job', status: 'queued' }); }
    return json({ jobs: [] });
  }
  if (url.pathname.includes('/object_info/')) {
    const name = url.pathname.split('/').at(-1);
    return json({ [name]: { input: { required: name === 'UNETLoader' ? { unet_name: [['fixture']] }
      : name === 'CLIPLoader' ? { clip_name: [['fixture']], type: [['flux3']] } : { vae_name: [['fixture']] } } } });
  }
  if (url.pathname === '/api/health') return json({ ok: true });
  if (url.pathname === '/api/comfy/system_stats') return json({ devices: [] });
  if (url.pathname === '/api/settings') return json({ notifications: false, updates: { autoCheck: false } });
  if (url.pathname.startsWith('/api/agent/canvas/')) return json({ message: 'fixture native tools only' }, 503);
  if (url.pathname.startsWith('/api/')) return json({});
  const file = path.resolve(dist, `.${url.pathname === '/' ? '/index.html' : url.pathname}`);
  assert.ok(file.startsWith(`${dist}${path.sep}`));
  return route.fulfill({ contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html', body: await readFile(file) });
});
const page = await context.newPage();
page.on('pageerror', (error) => errors.push(error.message));
const focus = (id) => page.evaluate(async (nodeId) => window.fixtureTools.get('canvas_focus_node').execute({ nodeId }), id);
try {
  await page.goto(origin);
  await page.waitForFunction(() => [...document.querySelectorAll('.media-preview img, .generator-preview img')].filter(i=>i.naturalWidth===640).length===4);
  if (process.env.H3_TEST_BASELINE) {
    await focus('video-result');
    await page.waitForFunction(()=>document.querySelector('[data-id="video-result"] video'));
    await page.locator('.zoom-button').click();
    for(let i=0;i<4;i++){await page.getByTitle('缩小',{exact:true}).click();await page.waitForTimeout(200);}
    await page.waitForFunction(()=>document.querySelector('.canvas-view-compact'));
    console.log(JSON.stringify({baselineCompactVideos:await page.locator('[data-id="video-result"] video').count()}));
    await page.getByRole('button',{name:'适应画布',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.canvas-view-placeholder'));
    await page.waitForTimeout(7000);
    console.log(JSON.stringify({baseline:true,overviewVideos:await page.locator('.react-flow video').count(),overviewDecodedImages:await page.locator('.react-flow img').evaluateAll(imgs=>imgs.filter(i=>i.naturalWidth>1).length),thumbnailRequests:thumbnails.length}));
    process.exitCode=0;
  } else {
  const mediaSize = await page.locator('[data-id="source"] .media-shell').evaluate(el=>({w:el.offsetWidth,h:el.offsetHeight,p:el.querySelector('.media-preview').offsetHeight}));
  const resultSize = await page.locator('[data-id="finished"] .generator-shell').evaluate(el=>({w:el.offsetWidth,h:el.offsetHeight,p:el.querySelector('.generator-preview').offsetHeight}));
  assert.deepEqual(mediaSize,{w:440,h:550,p:440});
  assert.deepEqual(resultSize,mediaSize,'reference and completed result match');
  assert.equal(originals.length,0,'previews never load original images');
  await page.locator('[data-id="source"] .media-preview').evaluate(el=>el.style.transform='translateX(-10000px)');
  await page.waitForFunction(()=>document.querySelector('[data-id="source"] .media-preview img')?.naturalWidth===1);
  assert.equal(await page.locator('[data-id="source"]').count(),1,'image node stays mounted while offscreen bitmap is released');
  await page.locator('[data-id="source"] .media-preview').evaluate(el=>el.style.transform='');
  await page.waitForFunction(()=>document.querySelector('[data-id="source"] .media-preview img')?.naturalWidth===640);

  await page.locator('[data-id="source"] .media-preview').dblclick();
  await page.waitForFunction(()=>document.querySelector('.image-lightbox img')?.naturalWidth===1600);
  assert.equal(originals.length,1,'original remains available in lightbox');
  await page.keyboard.press('Escape');
  await focus('video-result');
  await page.waitForFunction(()=>document.querySelector('[data-id="video-result"] video')?.getAttribute('preload')==='metadata');
  assert.equal(await page.locator('[data-id="video-result"] video').count(),1,'visible full-size custom video mounts a player');
  const ports = await page.locator('[data-id="video-result"] .custom-workflow-port .react-flow__handle').evaluateAll(items => items.map(el => ({title:el.title,y:el.getBoundingClientRect().y})));
  assert.equal(ports.length,2);
  assert.ok(Math.abs(ports[0].y-ports[1].y)>50,'completed custom inputs keep distinct selectable positions');
  assert.deepEqual(ports.map(p=>p.title),['Face reference','Body reference']);
  await page.locator('[data-id="video-result"] .generator-preview').evaluate(el=>el.style.transform='translateX(-10000px)');
  await page.waitForFunction(()=>!document.querySelector('[data-id="video-result"] video'));
  await page.locator('[data-id="video-result"] .generator-preview').evaluate(el=>el.style.transform='');
  await page.waitForFunction(()=>document.querySelector('[data-id="video-result"] video'));

  await page.locator('.zoom-button').click();
  for(let i=0;i<4;i++){await page.getByTitle('缩小',{exact:true}).click();await page.waitForTimeout(200);}
  await page.waitForFunction(()=>document.querySelector('.canvas-view-compact'));
  assert.equal(await page.locator('[data-id="video-result"] video').count(),0,'compact custom result does not mount video decoder');
  const compactSize=await page.locator('[data-id="video-result"] .generator-shell').evaluate(el=>({w:el.offsetWidth,h:el.offsetHeight}));
  assert.deepEqual(compactSize,{w:440,h:550},'zooming out keeps the row footprint stable');

  await page.getByRole('button',{name:'适应画布',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.canvas-view-placeholder'));
  await page.waitForTimeout(800);
  assert.equal(await page.locator('.react-flow video').count(),0,'placeholder overview mounts zero video players');
  assert.equal(await page.locator('.react-flow img').evaluateAll(imgs=>imgs.filter(i=>i.naturalWidth>1).length),0,'placeholder overview releases decoded image previews');
  const placeholderRequests=thumbnails.length;
  await page.waitForTimeout(1000);
  assert.equal(thumbnails.length,placeholderRequests,'overview does not start thumbnail requests');
  await focus('finished');
  await page.waitForFunction(()=>document.querySelector('[data-id="finished"] .generator-preview img')?.naturalWidth===640);
  assert.equal(await page.locator('.react-flow video').count(),0,'leaving video viewport unmounts its player');
  await focus('ref-generator');
  await page.locator('[data-id="ref-generator"] .generator-preview').click();
  await page.waitForFunction(()=>document.querySelector('.reference-chip.video .canvas-video-preview'));
  const chip = await page.locator('.reference-chip.video .canvas-video-preview').evaluate(el=>({w:el.offsetWidth,h:el.offsetHeight,parent:el.parentElement.offsetWidth}));
  assert.equal(chip.w,21);assert.equal(chip.h,21);assert.ok(chip.parent<=170,'video chip leaves room for title and remove button');
  for (const [id, slots] of [
    ['processed-levels', ['guide']], ['processed-curves', ['guide']], ['processed-blend', ['base', 'overlay', 'mask']],
  ]) {
    const originalCount = originals.length;
    await focus(id);
    const node = page.locator(`[data-id="${id}"]`);
    await page.waitForFunction(nodeId => document.querySelector(`[data-id="${nodeId}"] .result-compact .image-process-preview img`)?.naturalWidth === 640, id);
    await page.waitForTimeout(200);
    assert.equal(originals.length, originalCount, `${id}: compact settings do not read histogram, preview or mask originals`);
    assert.equal(await node.locator('.image-process-controls').count(), 0, `${id}: compact controls are unmounted`);
    const ports = await node.locator('.react-flow__handle.target').evaluateAll(handles => handles.map(handle => ({ id: handle.dataset.handleid, y: handle.getBoundingClientRect().y })));
    assert.deepEqual(ports.map(port => port.id), slots, `${id}: compact target port identities remain available`);
    assert.equal(new Set(ports.map(port => port.y)).size, slots.length, `${id}: compact target ports remain distinct`);
    assert.equal(await node.locator('.react-flow__handle.source[data-handleid="ref"]').count(), 1);
    await node.getByRole('button', { name: '调整设置', exact: true }).click();
    await node.locator('.image-process-controls').waitFor();
    await page.waitForFunction(nodeId => document.querySelector(`[data-id="${nodeId}"] .image-process-preview img`)?.src.startsWith('blob:'), id);
    for (const slot of slots) assert.ok(originals.slice(originalCount).some(url => url.endsWith(`/${id}-${slot}.png`)), `${id}: ${slot} original becomes available when settings open`);
    await node.getByRole('button', { name: '调整设置', exact: true }).click();
    await page.waitForFunction(nodeId => document.querySelector(`[data-id="${nodeId}"] .result-compact .image-process-preview img`)?.naturalWidth === 640, id);
    assert.equal(await node.locator('.image-process-controls').count(), 0);
    const collapsedCount = originals.length;
    await page.waitForTimeout(300);
    assert.equal(originals.length, collapsedCount, `${id}: closing settings starts no further original reads`);
  }
  const originalCount=originals.length;
  await focus('processed');
  await page.waitForFunction(()=>document.querySelector('[data-id="processed"] .result-compact .image-process-preview img')?.naturalWidth===640);
  assert.equal(originals.length,originalCount,'completed adjustments do not rerender original bitmaps');
  assert.equal(await page.locator('[data-id="processed"] .image-process-controls').isVisible(),false);
  await page.locator('[data-id="processed"] .image-process-preview').dblclick();
  await page.waitForFunction(()=>document.querySelector('.image-lightbox img')?.naturalWidth===1600);
  assert.ok(originals.at(-1).includes('processed.png'),'double click opens the saved result original');
  await page.keyboard.press('Escape');
  await page.locator('[data-id="processed"]').getByRole('button',{name:'调整设置',exact:true}).click();
  await page.locator('[data-id="processed"]').getByLabel('亮度数值').waitFor();
  await page.waitForFunction(()=>document.querySelector('[data-id="processed"] .image-process-preview img')?.src.startsWith('blob:'));
  await page.locator('[data-id="processed"]').getByLabel('亮度数值').fill('11');
  assert.equal(await page.locator('[data-id="processed"] .result-settings-toggle').count(),0,'stale parameters remain expanded until output is regenerated');
  const client=await context.newCDPSession(page);await client.send('Performance.enable');
  const metrics=await client.send('Performance.getMetrics');
  console.log(JSON.stringify({pass:true,standardCard:mediaSize,overviewVideos:0,overviewDecodedImages:0,thumbnailPeak,thumbnailRequests:thumbnails.length,lightboxOriginals:1,heap:metrics.metrics.find(m=>m.name==='JSHeapUsedSize')?.value}));
  assert.deepEqual(errors,[]);
  }
} finally {await context.close();await browser.close();}
