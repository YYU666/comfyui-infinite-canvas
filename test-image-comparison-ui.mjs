import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { chromium } from './test-browser.mjs';
import { pngCrc } from './src/image-export.js';
import { describeImageStage, inspectionStage, parameterDifference, zoomImageView } from './src/image-comparison.js';

function png(width, height) {
  const chunk = (type, data) => {
    const size = Buffer.alloc(4); size.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(pngCrc(body));
    return Buffer.concat([size, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.alloc((width * 3 + 1) * height, 90).map((value, i) => i % (width * 3 + 1) ? value : 0))), chunk('IEND', Buffer.alloc(0))]);
}

const fixtureGraph = {
  model: { class_type: 'UNETLoader', inputs: { unet_name: 'fixture.safetensors' } },
  src: { class_type: 'LoadImage', inputs: { image: 'workbench/original.png' } },
  cropped: { class_type: 'ImageCrop', inputs: { x: 20, y: 0, width: 180, height: 220, image: ['src', 0] } },
  enc: { class_type: 'TextEncodeQwenImage21', inputs: { prompt: 'actual expanded prompt', negative_prompt: '', resolution: 768, 'images.image_1': ['cropped', 0] } },
  sample: { class_type: 'KSampler', inputs: { seed: 0, steps: 40, sampler_name: 'euler', scheduler: 'simple' } },
};
const synthetic = {
  jobId: 'job_comparison', nodeId: 'generator', projectId: 'prj_comparison', defaultStage: 'workflow',
  stages: [{ id: 'workflow', promptId: 'prompt-comparison', provenance: 'execution', graph: fixtureGraph }],
};
const planned = {
  ...synthetic, jobId: 'job_plan', nodeId: 'older',
  stages: [{ id: 'workflow', promptId: 'prompt-plan', provenance: 'persisted-plan',
    graph: { ...fixtureGraph, src: { class_type: 'LoadImage', inputs: { image: 'must-not-open.png' } },
      sample: { ...fixtureGraph.sample, inputs: { ...fixtureGraph.sample.inputs, seed: 99 } } } }],
};
const validated = describeImageStage(synthetic.stages[0]);
assert.deepEqual(validated.fields.seed, [0]);
assert.equal(validated.inputs[0].url, '/api/comfy/view?filename=original.png&subfolder=workbench&type=input');
assert.equal(inspectionStage(synthetic, { projectId: 'wrong', promptId: 'prompt-comparison' }), null);
assert.equal(inspectionStage(synthetic, { projectId: synthetic.projectId, promptId: 'another' }), null);
assert.equal(parameterDifference([0], []), 'unknown');
assert.deepEqual(zoomImageView({ scale: 1, x: 40, y: 30 }, 2, 10, -10), { scale: 2, x: 45, y: 25 });

const existing = process.env.H3_IMAGE_COMPARE_FIXTURE;
const actual = existing ? JSON.parse(await readFile(path.join(existing, 'record.json'), 'utf8')) : synthetic;
const promptId = actual.stages.find((stage) => stage.provenance === 'execution').promptId;
const record = describeImageStage(actual.stages.find((stage) => stage.promptId === promptId));
const files = {
  reference: existing ? await readFile(path.join(existing, 'source.png')) : png(220, 240),
  result: existing ? await readFile(path.join(existing, 'result.png')) : png(160, 200),
};
const origin = 'http://image-compare-fixture.test';
const dist = path.resolve(process.env.H3_TEST_DIST_DIR || 'dist');
const fixtureProject = { id: actual.projectId, name: 'Image comparison fixture', revision: 1, shots: [], canvas: {
  viewport: { x: 0, y: 0, zoom: 1 }, edges: [], nodes: [
    { id: 'result', type: 'media', position: { x: 100, y: 150 }, data: { kind: 'image', title: '比较结果', output: true,
        url: '/api/comfy/view?filename=output.png&type=output', name: 'output.png',
        sourceGeneratorId: actual.nodeId, sourceQueueJobId: actual.jobId, sourcePromptId: promptId } },
    { id: 'old', type: 'media', position: { x: 580, y: 150 }, data: { kind: 'image', title: '只有计划的旧结果', output: true,
        url: '/api/comfy/view?filename=old.png&type=output', name: 'old.png',
        sourceGeneratorId: planned.nodeId, sourceQueueJobId: planned.jobId, sourcePromptId: planned.stages[0].promptId } },
    { id: 'missing', type: 'media', position: { x: 1080, y: 150 }, data: { kind: 'image', title: '缺执行历史的旧结果', output: true,
        url: '/api/comfy/view?filename=missing.png&type=output', name: 'missing.png',
        sourceQueueJobId: 'job_absent', sourcePromptId: 'prompt-absent' } },
  ],
} };

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1350, height: 900 }, serviceWorkers: 'block' });
  const inspections = [], originalRequests = [], mutations = [], errors = [];
  await context.addInitScript(() => {
    window.EventSource = class { addEventListener() {} close() {} };
    window.WebSocket = class { addEventListener() {} close() {} };
  });
  await context.route('**/*', (route) => {
    const req = route.request();
    const url = new URL(req.url());
    assert.equal(url.origin, origin, 'fixture cannot reach running workbench');
    const json = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    if (!['GET', 'HEAD'].includes(req.method()) && !['/api/projects/open', '/api/ui-ready'].includes(url.pathname)
      && !url.pathname.startsWith('/api/agent/canvas/')) mutations.push(url.pathname);
    if (url.pathname === '/api/projects') return json({ projects: [fixtureProject] });
    if (url.pathname === '/api/projects/trash') return json({ projects: [] });
    if (url.pathname === '/api/projects/open' || url.pathname === '/api/projects/' + fixtureProject.id) return json(fixtureProject);
    if (url.pathname === '/api/settings') return json({ notifications: false, updates: { autoCheck: false } });
    if (url.pathname === '/api/queue') return json({ jobs: [] });
    if (url.pathname === '/api/queue/inspect') {
      inspections.push(Object.fromEntries(url.searchParams));
      if (url.searchParams.get('jobId') === actual.jobId) return json(actual);
      if (url.searchParams.get('jobId') === planned.jobId) return json({ ...planned, projectId: fixtureProject.id });
      return json({ message: 'history gone' }, 404);
    }
    if (url.pathname === '/api/thumbnails') return route.fulfill({ contentType: 'image/png', body: files.result });
    if (url.pathname === '/api/comfy/view') {
      if (url.searchParams.get('type') === 'input') {
        originalRequests.push(url.pathname + url.search);
        if (url.pathname + url.search !== record.inputs[0].url) return json({}, 404);
        return route.fulfill({ contentType: 'image/png', body: files.reference });
      }
      return route.fulfill({ contentType: 'image/png', body: files.result });
    }
    if (url.pathname.startsWith('/api/agent/canvas/')) return json({}, 503);
    if (url.pathname.startsWith('/api/')) return json({});
    const file = path.resolve(dist, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
    assert.ok(file.startsWith(dist + path.sep));
    return readFile(file).then((body) => route.fulfill({ body, contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' }));
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  await page.locator('.project-open').click();
  await page.locator('.react-flow__node[data-id="result"]').getByRole('button', { name: '导出图片', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '比较结果大图预览' });
  await dialog.waitFor();
  assert.deepEqual(inspections, [], 'ordinary viewing never loads execution history');
  await dialog.getByRole('button', { name: '图像对照' }).click();
  await dialog.getByText(/左图使用记录裁切/).waitFor();
  const panes = dialog.locator('.image-compare-pixels');
  await page.waitForFunction(() => document.querySelectorAll('.image-compare-pixels img').length === 2 &&
    [...document.querySelectorAll('.image-compare-pixels img')].every((img) => img.complete && img.naturalWidth));
  await dialog.getByRole('button', { name: '1:1 像素' }).click();
  assert.match(await dialog.locator('output').textContent(), /^100\.0%/);
  const layout = () => panes.evaluateAll(items => items.map(item => item.style.transform));
  const before = await layout();
  assert.equal(before[0], before[1]);
  const viewport = await dialog.locator('.image-compare-viewport').first().boundingBox();
  await page.mouse.move(viewport.x + viewport.width / 2, viewport.y + viewport.height / 2);
  await page.mouse.wheel(0, -160);
  await page.waitForFunction(() => !document.querySelector('.image-compare-tools output').textContent.startsWith('100.0%'));
  const zoomed = await layout();
  assert.equal(zoomed[0], zoomed[1]);
  await page.mouse.down();
  await page.mouse.move(viewport.x + viewport.width / 2 + 38, viewport.y + viewport.height / 2 + 20);
  await page.mouse.up();
  const dragged = await layout();
  assert.equal(dragged[0], dragged[1]);
  assert.notEqual(dragged[0], zoomed[0]);
  assert.equal(inspections[0].promptId, promptId);
  assert.deepEqual(originalRequests, [record.inputs[0].url]);
  const expectedSeed = String(record.fields.seed[0]);
  assert.equal(await dialog.getByRole('row', { name: /种子/ }).locator('td').last().textContent(), expectedSeed);
  await dialog.getByRole('combobox', { name: '左侧图片' }).selectOption('old');
  await dialog.getByRole('columnheader', { name: /已存计划/ }).waitFor();
  assert.equal(await dialog.getByRole('row', { name: /种子/ }).getAttribute('data-difference'), 'different');
  await dialog.getByRole('combobox', { name: '左侧图片' }).selectOption('missing');
  await dialog.getByRole('columnheader', { name: /对应的执行记录缺失/ }).waitFor();
  assert.equal(await dialog.getByRole('row', { name: /种子/ }).getAttribute('data-difference'), 'unknown');
  assert.equal(originalRequests.includes('/api/comfy/view?filename=must-not-open.png&subfolder=&type=input'), false);
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  assert.deepEqual(errors, []);
  assert.deepEqual(mutations, []);
  console.log('Image comparison passed: original pixels, shared wheel/pan/1:1, exact run, differences and missing history. Fixture: ' + (existing ? 'existing Qwen result' : 'synthetic'));
} finally { await browser.close(); }
