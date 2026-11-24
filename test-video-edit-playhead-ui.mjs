// Isolated browser test. No workbench server, external URL, or user project.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from './test-browser.mjs';
import { defaultVideoEditDocument } from './src/video-edit-document.js';
import { PROJECT_SESSION_KEY } from './src/project-session.js';

const origin = 'http://video-playhead-fixture.test';
const projectId = 'prj_video_playhead';
const asset = `assets/${'b'.repeat(64)}.webm`;
const result = `assets/${'c'.repeat(64)}.mp4`;
const dist = path.resolve(process.env.H3_TEST_DIST_DIR || 'dist');
const media = await readFile(new URL('./fixtures/video-edit-playhead.webm', import.meta.url));
const timebase = { num: 1, den: 24 };
const original = defaultVideoEditDocument();
original.clips[0] = { ...original.clips[0], id: 'x'.repeat(64), sourceInPts: 0, sourceOutPts: 96, timebase };
let project = { id: projectId, name: 'Synthetic two-color source', revision: 1, shots: [], canvas: {
  viewport: { x: 20, y: 40, zoom: 0.5 },
  nodes: [
    { id: 'src', type: 'media', position: { x: 10, y: 80 }, data: { kind: 'video', title: 'Teal to orange', localFile: true, assetPath: asset } },
    { id: 'edit', type: 'videoEdit', position: { x: 500, y: 80 }, data: { title: '剪辑试件', status: 'idle', editDocument: original,
      editResultAssetPath: result, editResultDocument: JSON.stringify(original) } },
  ], edges: [{ id: 'edge', source: 'src', sourceHandle: 'ref', target: 'edit', targetHandle: 'v1' }],
} };

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1350, height: 950 }, serviceWorkers: 'block' });
  await context.addInitScript(({ key, id }) => {
    sessionStorage.setItem(key, JSON.stringify({ version: 1, id, readOnly: false }));
    window.EventSource = class { addEventListener() {} close() {} };
    window.WebSocket = class { addEventListener() {} close() {} };
  }, { key: PROJECT_SESSION_KEY, id: projectId });
  const errors = [];
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    assert.equal(url.origin, origin);
    const json = (value, status = 200) => route.fulfill({ status, json: value });
    if (url.pathname === '/api/projects') return json({ projects: [project] });
    if (url.pathname === '/api/projects/open') return json(project);
    if (url.pathname === `/api/projects/${projectId}`) {
      if (request.method() === 'PUT') project = { ...project, ...request.postDataJSON(), revision: project.revision + 1 };
      return json(project);
    }
    if (url.pathname === '/api/health') return json({ ok: true, comfy: { state: 'ready' } });
    if (url.pathname === '/api/settings') return json({ notifications: false, checkUpdatesOnLaunch: false });
    if (url.pathname === '/api/queue') return json({ jobs: [] });
    if (url.pathname === '/api/video-edit/probe') return json({ frameCount: 96, frameTimebase: timebase, fps: { num: 24, den: 1 }, width: 64, height: 48 });
    if (url.pathname.endsWith(`/${asset}`)) {
      const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers().range || '');
      if (!range) return route.fulfill({ body: media, contentType: 'video/webm' });
      const first = +range[1], last = range[2] ? Math.min(+range[2], media.length - 1) : media.length - 1;
      return route.fulfill({ status: 206, contentType: 'video/webm', body: media.subarray(first, last + 1),
        headers: { 'Content-Range': `bytes ${first}-${last}/${media.length}`, 'Accept-Ranges': 'bytes' } });
    }
    if (url.pathname.startsWith('/api/')) return json({}, 404);
    const name = url.pathname === '/' ? '/index.html' : url.pathname;
    const contentType = name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : undefined;
    try { return route.fulfill({ path: path.join(dist, name), contentType }); }
    catch { return route.fulfill({ status: 404 }); }
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(origin);
  const node = page.locator('.react-flow__node[data-id="edit"]');
  await node.waitFor();
  assert.equal(await node.locator('.video-edit-result video').count(), 0, 'overview must not mount a result decoder');
  await node.locator('[data-video-edit-open]').click();
  const panel = page.getByRole('dialog', { name: '视频编辑', exact: true });
  await panel.waitFor();
  const playhead = panel.getByRole('slider', { name: '播放头' });
  const video = panel.getByLabel('源片段预览');
  const split = panel.getByRole('button', { name: '在播放头分割' });
  assert.equal(await split.isEnabled(), false, 'the in-point cannot be split');
  await video.waitFor();
  await playhead.fill('60');
  await panel.getByText('00:00:02:12 · 60 / 96 帧', { exact: true }).waitFor();
  await page.waitForFunction(() => {
    const node = document.querySelector('video[aria-label="源片段预览"]');
    if (!node || node.seeking || node.readyState < 2 || Math.abs(node.currentTime - 2.5) > .03) return false;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(node, 0, 0, 1, 1);
    const [r, , b] = ctx.getImageData(0, 0, 1, 1).data;
    return r > 180 && b < 65; // The second half of the decoded source is orange.
  });
  await split.click();
  await panel.getByText(/已在第 60 帧分割，镜头增加到 2 个/).waitFor();
  assert.equal(await panel.locator('.video-edit-clip').count(), 2);
  assert.equal(await panel.locator('.video-edit-clip.selected').innerText(), '2. v1\n36 帧');
  assert.equal(await playhead.inputValue(), '60');
  await node.getByText('参数已更新 · 待导出').waitFor({ state: 'attached' });
  for (let i = 0; i < 40 && !project.canvas.nodes.find(({ id }) => id === 'edit').data.editDocument.clips[1]; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const savedClips = project.canvas.nodes.find(({ id }) => id === 'edit').data.editDocument.clips;
  assert.deepEqual(savedClips.map(({ sourceInPts, sourceOutPts }) => [sourceInPts, sourceOutPts]), [[0, 60], [60, 96]]);
  assert.equal(new Set(savedClips.map(({ id }) => id)).size, 2);
  assert.ok(savedClips.every(({ id }) => id.length <= 64));
  await playhead.fill('24');
  assert.equal(await panel.locator('.video-edit-clip.selected').innerText(), '1. v1\n60 帧');
  await page.waitForFunction(() => Math.abs(document.querySelector('video[aria-label="源片段预览"]').currentTime - 1) < .03);
  await panel.getByTitle('撤销 (Ctrl+Z)').click();
  await panel.getByText(/96 帧 · 1 个镜头/).waitFor();
  await page.setViewportSize({ width: 720, height: 900 });
  await playhead.scrollIntoViewIfNeeded();
  const box = await playhead.boundingBox();
  assert.ok(box && box.x >= 0 && box.x + box.width <= 720);
  await playhead.press('Escape');
  await panel.waitFor({ state: 'detached' });
  assert.ok(await page.locator(':focus').evaluate((element) => element.hasAttribute('data-video-edit-open')));
  assert.deepEqual(errors, []);
  console.log('Overview, decoded seek, split, project save, stale status, undo and narrow viewport passed.');
} finally {
  await browser.close();
}
