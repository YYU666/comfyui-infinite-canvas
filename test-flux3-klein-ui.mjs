import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from './test-browser.mjs';
import { FLUX3_KLEIN_MODEL as model } from './src/flux3-klein.js';

// Every request is intercepted. This never connects to a live project or GPU.
const origin = 'http://127.0.0.1:8799';
const dist = path.resolve(process.env.H3_TEST_DIST_DIR || 'dist');
const browser = await chromium.launch({ headless: true });
const errors = [];
try {
  for (const [mode, guard] of [['image'], ['qwenEdit'], ['qwenEdit', 'mask'], ['qwenEdit', 'crop'], ['qwenEdit', 'maskCrop']]) {
    let missingNode = mode === 'image' ? 'TextGenerate' : 'ReferenceMultiLatent';
    let project = { id: 'prj_klein_fixture', name: 'Klein isolated fixture', revision: 1, shots: [], canvas: {
      viewport: { x: 0, y: 0, zoom: 0.9 }, nodes: [
        { id: 'source', type: 'media', position: { x: 10, y: 50 }, data: { kind: 'image', title: 'Reference', remoteName: 'source.png', url: `${origin}/fixture.svg` } },
        { id: 'generator', type: 'generator', selected: true, position: { x: 430, y: 50 }, data: { mode, title: mode === 'image' ? '文生图' : '图生图', prompt: 'Keep 图1 and change the sky to blue.', ratio: '16:9', imageLora: 'none', qwenRefResolution: 1536, status: 'idle', seed: 42, randomSeed: false } },
      ], edges: mode === 'qwenEdit' ? [{ id: 'reference', source: 'source', sourceHandle: 'ref', target: 'generator', targetHandle: 'references' }] : [],
    } };
    if (guard === 'mask') {
      project.canvas.nodes.push({ id: 'mask', type: 'media', position: { x: 20, y: 300 }, data: { kind: 'image', mediaRole: 'mask', title: 'Synthetic mask' } });
      project.canvas.edges.push({ id: 'mask-input', source: 'mask', sourceHandle: 'mask', target: 'generator', targetHandle: 'mask' });
    }
    if (guard === 'crop') project.canvas.nodes[1].data.qwenSourceCrop = { x: 0, y: 0, width: 100, height: 100 };
    if (guard === 'maskCrop') project.canvas.nodes[1].data.qwenMaskCrop = true;
    const queued = [];
    const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
    await context.addInitScript(() => {
      window.fixtureTools = new Map();
      Object.defineProperty(document, 'modelContext', { value: { registerTool(tool, options) { window.fixtureTools.set(tool.name, tool); options?.signal?.addEventListener('abort', () => window.fixtureTools.delete(tool.name)); } } });
      window.EventSource = class { addEventListener() {} close() {} };
      window.WebSocket = class { addEventListener() {} close() {} };
    });
    await context.route('**/*', async (route) => {
      const request = route.request(), url = new URL(request.url());
      assert.equal(url.origin, origin, 'no request may escape the isolated fixture');
      const json = (value) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(value) });
      if (url.pathname === '/fixture.svg') return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#546879"/></svg>' });
      if (url.pathname === '/api/projects') return json({ projects: [project] });
      if (url.pathname === '/api/projects/trash') return json({ projects: [] });
      if (url.pathname === '/api/projects/open') return json(project);
      if (url.pathname === `/api/projects/${project.id}`) {
        if (request.method() === 'PUT') project = { ...project, ...request.postDataJSON(), revision: project.revision + 1 };
        return json(project);
      }
      if (url.pathname === '/api/health') return json({ ok: true });
      if (url.pathname === '/api/comfy/system_stats') return json({ devices: [] });
      if (url.pathname === '/api/settings') return json({ notifications: false, checkUpdatesOnLaunch: false });
      if (url.pathname === '/api/queue') {
        if (request.method() === 'POST') { queued.push(request.postDataJSON()); return json({ id: 'fixture-job', status: 'queued' }); }
        return json({ jobs: [] });
      }
      if (url.pathname.includes('/object_info/')) {
        const name = url.pathname.split('/').at(-1);
        if (name === missingNode) return json({});
        return json({ [name]: { input: { required: name === 'UNETLoader' ? { unet_name: [[model.unet]] }
          : name === 'CLIPLoader' ? { clip_name: [[model.clip, model.upsampler]], type: [['flux3']] }
            : { vae_name: [[model.vae]] } } } });
      }
      if (url.pathname.startsWith('/api/agent/canvas/')) return route.fulfill({ status: 503, contentType: 'application/json', body: '{"message":"native fixture only"}' });
      if (url.pathname.startsWith('/api/')) return json({});
      const file = path.join(dist, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
      return route.fulfill({ contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html', body: await readFile(file) });
    });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(origin); await page.locator('.project-open').click();
    const selector = page.getByLabel(mode === 'image' ? '生图模型' : 'Qwen 模型版本');
    await selector.waitFor();
    assert.equal(await selector.locator('option[value="flux3_klein"]').textContent(), 'FLUX 3 Image Klein INT8');
    if (guard) {
      assert.equal(await selector.locator('option[value="flux3_klein"]').evaluate((option) => option.disabled), true, `existing ${guard} disables Klein selection`);
      assert.equal(queued.length, 0);
      await context.close();
      continue;
    }
    await selector.selectOption('flux3_klein');
    await page.getByLabel('FLUX 3 输出尺寸').selectOption(mode === 'image' ? '4K' : '1MP');
    const toolbar = page.locator('.creator-toolbar[data-id="generator"]');
    assert.match(await toolbar.textContent(), /16 步/);
    assert.equal(await toolbar.getByLabel(mode === 'image' ? '图片风格' : '图生图真人化强度').count(), 0);
    if (mode === 'qwenEdit') {
      assert.equal(await page.locator('.react-flow__node[data-id="generator"]').getByRole('button', { name: '+ 添加遮罩', exact: true }).isDisabled(), true, 'Klein disables adding unsupported masks');
      await mkdir('.cache/flux3-klein', { recursive: true });
      await page.screenshot({ path: '.cache/flux3-klein/ui.jpg', type: 'jpeg', quality: 65 });
    }
    await page.evaluate(async () => window.fixtureTools.get('canvas_generate_node').execute({ nodeId: 'generator', wait: false }));
    await page.locator('.generator-error').filter({ hasText: missingNode }).waitFor();
    assert.equal(queued.length, 0, 'missing runtime nodes must never enqueue');
    missingNode = undefined;
    const result = await page.evaluate(async () => JSON.parse(await window.fixtureTools.get('canvas_generate_node').execute({ nodeId: 'generator', wait: false })));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(queued.length, 1);
    assert.equal(queued[0].workflow.model.inputs.unet_name, model.unet);
    assert.equal(queued[0].workflow.upsampler.inputs.clip_name, model.upsampler);
    if (mode === 'image') assert.equal(queued[0].workflow.latent.inputs.width, 4096);
    else {
      assert.equal(queued[0].workflow.reference_1.inputs.image, 'source.png');
      assert.equal(queued[0].workflow.output_size.inputs.megapixels, 1);
    }
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log('FLUX3_KLEIN_UI_OK both existing selectors, size controls, LoRA/mask/crop guards, native-tool generation routing; isolated requests only');
} finally { await browser.close(); }
