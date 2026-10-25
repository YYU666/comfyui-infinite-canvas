import { chromium } from 'playwright-core';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const optimized = `subject_definitions:
<Subject 1> is the dancer in <Picture 1>.
<Subject 2> is the choreography from <Video 1>.

summary:
[reference generation] <Subject 1> performs <Subject 2>.

retention_analysis:
<Subject 1> (appears in [Shot 1]): fully_preserved - identity is retained.
<Subject 2> (appears in [Shot 1]): attribute_transfer - only movement is transferred.

detailed_description:
Live-action, cinematic. [Shot 1] <Subject 1> performs the choreography of <Subject 2> and turns toward camera.

overall_soundscape:
Soft rain and footsteps.

non_diegetic_music:
N/A`;
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
let requestPayload;
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
await page.route('**/api/optimize-prompt', async route => {
  requestPayload = route.request().postDataJSON();
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ prompt: optimized, model: 'deepseek-flash' }) });
});
await page.goto('http://127.0.0.1:8790', { waitUntil: 'networkidle' });
await page.evaluate(() => {
  localStorage.clear();
  localStorage.setItem('h3-canvas-snap-v1', 'false');
  localStorage.setItem('h3-infinite-canvas-v2', JSON.stringify({
    nodes: [
      { id: 'image', type: 'media', position: { x: 30, y: 40 }, data: { kind: 'image', title: '主角', url: '', name: '' } },
      { id: 'video', type: 'media', position: { x: 30, y: 280 }, data: { kind: 'video', title: '舞蹈参考', url: '', name: '' } },
      { id: 'optimizer', type: 'prompt', position: { x: 420, y: 400 }, data: { title: 'H3 提示词优化', idea: '', optimizedPrompt: '', status: 'idle' } },
      { id: 'gen', type: 'generator', position: { x: 900, y: 100 }, selected: true, data: { title: '全能参考', mode: 'reference', prompt: '', ratio: '9:16', duration: 15, turbo: true, status: 'idle', runs: [] } },
    ],
    edges: [
      { id: 'image-gen', source: 'image', target: 'gen', sourceHandle: 'ref', targetHandle: 'references' },
      { id: 'video-gen', source: 'video', target: 'gen', sourceHandle: 'ref', targetHandle: 'references' },
      { id: 'optimizer-gen', source: 'optimizer', target: 'gen', sourceHandle: 'prompt', targetHandle: 'prompt' },
    ],
    viewport: { x: 0, y: 0, zoom: 0.75 },
  }));
});
await page.reload({ waitUntil: 'networkidle' });
await page.locator('[data-id="optimizer"] .optimizer-idea').fill('让图片主角参考视频跳舞，最后回头，不要配乐。');
await page.locator('[data-id="optimizer"] .optimizer-run').click();
await page.locator('[data-id="optimizer"] .optimizer-result').waitFor({ state: 'visible' });
await page.waitForTimeout(500);
assert.equal(requestPayload.mode, 'reference');
assert.equal(requestPayload.duration, 15);
assert.equal(requestPayload.ratio, '9:16');
assert.deepEqual(requestPayload.references.map(item => item.tag), ['<Picture 1>', '<Video 1>']);
assert.ok(requestPayload.idea.includes('不要配乐'));
let saved = await page.evaluate(() => JSON.parse(localStorage.getItem('h3-infinite-canvas-v2')));
let generator = saved.nodes.find(node => node.id === 'gen');
assert.ok(generator.data.prompt.includes('@主角'), 'Picture tag converts back to the existing image mention');
assert.ok(generator.data.prompt.includes('@舞蹈参考'), 'Video tag converts back to the existing video mention');
assert.ok(!generator.data.prompt.includes('<Picture 1>'), 'Generator does not show raw Picture tags');
assert.ok(saved.edges.some(edge => edge.source === 'optimizer' && edge.target === 'gen' && edge.targetHandle === 'prompt'));
await page.locator('[data-id="gen"] .generator-preview').click();
const editor = page.getByRole('textbox', { name: '视频提示词' });
assert.equal(await editor.locator('.prompt-mention').count(), 2, 'Optimized references render as thumbnail chips');
assert.ok(!(await editor.textContent()).includes('@主角'), 'Optimized prompt does not expose long raw mention tokens');
await page.screenshot({ path: '../prompt-optimizer-test.png', fullPage: true });

await page.reload({ waitUntil: 'networkidle' });
await page.locator('[data-id="optimizer"] .optimizer-connection.connected').waitFor({ state: 'visible' });
saved = await page.evaluate(() => JSON.parse(localStorage.getItem('h3-infinite-canvas-v2')));
assert.ok(saved.edges.some(edge => edge.id === 'optimizer-gen' && edge.targetHandle === 'prompt'), 'Prompt connection survives reload');
assert.ok(saved.nodes.find(node => node.id === 'optimizer').data.optimizedPrompt.includes('@主角'));
await browser.close();

globalThis.window = { location: { hostname: '127.0.0.1' } };
const { compileReferencePrompt } = await import('./src/workbench-api.js');
const references = [{ kind: 'image', title: '主角' }, { kind: 'video', title: '舞蹈参考' }];
const compiled = compileReferencePrompt(generator.data.prompt, references);
assert.ok(compiled.includes('<Picture 1>') && compiled.includes('<Video 1>'), 'H3 compiler restores official reference labels');
assert.ok(!compiled.includes('@主角') && !compiled.includes('@舞蹈参考'));
const report = { connectedNode: true, correctPayload: true, autoFilled: true, thumbnailMentions: true, reloadRestore: true, compilerRoundTrip: true, errors };
fs.writeFileSync('../prompt_optimizer_test_report.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (errors.length) process.exit(2);
