import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { chromium } from './test-browser.mjs';
import { pngCrc } from './src/image-export.js';

const dist = path.resolve(process.env.H3_TEST_DIST_DIR || 'dist');
const origin = 'http://127.0.0.1:8799';
function chunk(type, data) {
  const size = Buffer.alloc(4); size.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(pngCrc(body));
  return Buffer.concat([size, body, crc]);
}
const pixels = chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0, 255])));
const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', Buffer.from([0,0,0,1,0,0,0,1,8,6,0,0,0])), chunk('tEXt', Buffer.from('parameters\0prompt=synthetic;seed=42;workflow={}')), pixels, chunk('IEND', Buffer.alloc(0))]);
let project = { id: 'prj_export_fixture', name: 'Synthetic PNG export', revision: 1, shots: [], canvas: { viewport: { x: 20, y: 30, zoom: 1 }, edges: [], nodes: [
  { id: 'image', type: 'media', position: { x: 40, y: 30 }, data: { title: '合成PNG', kind: 'image', name: 'synthetic.png', remoteName: 'synthetic.png', output: true, url: `${origin}/synthetic.png` } },
] } };
const browser = await chromium.launch({ headless: true });
const errors = [], mutations = [];
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  await context.addInitScript(() => {
    window.EventSource = class { addEventListener() {} close() {} };
    window.WebSocket = class { addEventListener() {} close() {} };
  });
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    assert.equal(url.origin, origin, 'all traffic stays in isolated synthetic fixture');
    const json = data => route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
    if (url.pathname === '/synthetic.png') return route.fulfill({ contentType: 'image/png', body: png });
    if (url.pathname === '/api/projects') return json({ projects: [project] });
    if (url.pathname === '/api/projects/trash') return json({ projects: [] });
    if (url.pathname === '/api/projects/open') return json(project);
    if (url.pathname === `/api/projects/${project.id}`) {
      if (req.method() === 'PUT') project = { ...project, ...req.postDataJSON(), revision: project.revision + 1 };
      return json(project);
    }
    if (url.pathname === '/api/settings') return json({ notifications: false, checkUpdatesOnLaunch: false });
    if (url.pathname.startsWith('/api/agent/canvas/')) return route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
    if (url.pathname.startsWith('/api/')) {
      if (!['GET', 'HEAD'].includes(req.method()) && url.pathname !== '/api/ui-ready') mutations.push(url.pathname);
      return json(url.pathname === '/api/queue' ? { jobs: [] } : {});
    }
    const file = path.join(dist, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
    return route.fulfill({ contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html', body: await readFile(file) });
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin); await page.locator('.project-open').click();
  const node = page.locator('.react-flow__node[data-id="image"]');
  await node.getByRole('button', { name: '导出图片', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '合成PNG大图预览' }); await dialog.waitFor();
  const toggle = dialog.getByRole('checkbox', { name: '去除元数据（PNG）' });
  assert.equal(await toggle.isChecked(), true);
  const download = async () => {
    const waiting = page.waitForEvent('download');
    await dialog.getByRole('button', { name: '导出图片', exact: true }).click();
    return readFile(await (await waiting).path());
  };
  const cleaned = await download();
  assert.equal(cleaned.includes(Buffer.from('parameters')), false);
  assert.ok(cleaned.includes(pixels), 'download keeps compressed pixels unchanged');
  await toggle.uncheck();
  assert.deepEqual(await download(), png, 'disabled option exports original exact bytes');
  assert.ok(project.canvas.nodes[0].data.url.endsWith('/synthetic.png'), 'source node remains unchanged');
  const qa = path.resolve('.cache/feature-dev/qa'); await mkdir(qa, { recursive: true });
  await toggle.check(); await dialog.screenshot({ path: path.join(qa, 'png-metadata-export.png') });
  await page.getByRole('button', { name: '关闭大图预览' }).click();
  assert.deepEqual(errors, []); assert.deepEqual(mutations, []);
  await context.close();
  console.log('PNG export UI passed: real download bytes stripped/off, original unchanged, no generation.');
} finally { await browser.close(); }
