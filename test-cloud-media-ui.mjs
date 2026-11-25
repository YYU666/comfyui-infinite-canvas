import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { chromium } from './test-browser.mjs';

const directory = await mkdtemp(path.join(tmpdir(), 'canvas-cloud-media-'));
const runtime = path.join(directory, 'runtime');
const instance = path.join(runtime, 'instance.json');
const key = 'synthetic-cloud-key';
const providerLog = path.join(directory, 'provider.jsonl');
const artifacts = process.env.H3_CLOUD_TEST_ARTIFACTS;
const source = path.resolve(process.env.H3_TEST_DIST_DIR || 'dist');
const workbenchEnv = {
  ...process.env,
  H3_COMFY_AUTOSTART: '0',
  H3_COMFY_ROOT: path.join(directory, 'no-comfy'),
  H3_PROJECTS_ROOT: path.join(directory, 'projects'),
  H3_WORKBENCH_RUNTIME_DIR: runtime,
  H3_WORKBENCH_DATA_DIR: path.join(directory, 'data'),
  H3_WORKBENCH_DIST_DIR: source,
  H3_WORKBENCH_PORT: '0',
  H3_WORKBENCH_NO_BROWSER: '1',
  H3_WORKBENCH_NATIVE3D_ONLY: '0',
  HOME: path.join(directory, 'home'),
  USERPROFILE: path.join(directory, 'home'),
  LOCALAPPDATA: path.join(directory, 'home'),
  PYTHONNOUSERSITE: '1',
};
let browser;
let child;
let base;
let token;
const external = [];
const pageErrors = [];
const logs = [];
const generationNode = (page, name) => page.locator(`.cloud-media-node:has(input[aria-label="节点名称"][value="${name}"])`);
const digest = data => createHash('sha256').update(data).digest('hex');

async function waitFor(check) {
  for (let retry = 0; retry < 200; retry++) {
    const value = await check();
    if (value) return value;
    await pause(50);
  }
  throw new Error('Condition did not become true in 10 seconds');
}

async function api(route, method = 'GET', body) {
  const response = await fetch(base + route, { method, headers: { 'X-H3-Token': token, 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return response;
}

async function start() {
  child = spawn(process.env.H3_TEST_PYTHON || 'python', ['-B', 'test_cloud_media.py', '--browser-fixture', directory],
    { env: workbenchEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => logs.push(chunk.toString()));
  child.stderr.on('data', chunk => logs.push(chunk.toString()));
  const record = await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(logs.join(''));
    const record = await readFile(instance, 'utf-8').then(JSON.parse).catch(() => null);
    if (record?.pid === child.pid) return record;
  });
  base = `http://127.0.0.1:${record.port}`;
  token = record.token;
  const health = await waitFor(() => fetch(base + '/api/health').then(r => r.json()).catch(() => null));
  assert.equal(health.comfy.enabled, false);
  assert.equal(health.comfy.owned, false);
  assert.equal((await api('/api/cloud-media/providers')).status, 200);
  assert.equal((await fetch(base + '/api/cloud-media/providers')).status, 401);
  assert.equal((await fetch(base + '/api/cloud-media/providers', { headers: { 'X-H3-Token': token, Origin: 'https://untrusted.example' } })).status, 403);
  return health;
}

async function stop() {
  if (!child || child.exitCode !== null) return;
  const proc = child;
  const exited = new Promise(resolve => proc.once('exit', resolve));
  try {
    const response = await api('/api/shutdown', 'POST', {});
    assert.ok(response.ok, await response.text());
    await waitFor(() => proc.exitCode !== null);
    assert.equal(proc.exitCode, 0);
  } finally {
    if (proc.exitCode === null) proc.kill();
    await exited;
  }
}

async function gotoProject() {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1050 }, serviceWorkers: 'block' });
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin === base) return route.continue();
    external.push(new URL(route.request().url()).origin);
    return route.abort();
  });
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(base);
  const card = page.locator('.project-entry').filter({ hasText: 'Cloud media fixture' }).getByRole('button', { name: '打开', exact: true });
  await card.click();
  page.setDefaultTimeout(12_000);
  await page.locator('[data-id="reference"]').waitFor();
  return { context, page };
}

async function createNode(page, title) {
  await page.getByTitle('添加元素', { exact: true }).click();
  const menu = page.getByRole('menu', { name: '添加节点' });
  await menu.getByRole('button', { name: new RegExp(title) }).click();
  const node = generationNode(page, title);
  await node.waitFor();
  return node;
}

async function configure(node) {
  await node.locator('summary').click();
  const baseField = node.getByLabel('HTTPS API 地址', { exact: true });
  if (await baseField.count()) await baseField.fill('https://image-gateway.example/v1');
  await node.getByLabel('API 密钥', { exact: true }).fill(key);
  await node.getByRole('button', { name: '保存本次会话配置', exact: true }).click();
  await node.getByText('配置供应商 · 已配置', { exact: true }).waitFor();
}

async function submit(node, prompt) {
  await node.getByLabel('提示词', { exact: true }).fill(prompt);
  const button = node.getByRole('button', { name: '提交云端生成', exact: true });
  assert.equal(await button.isDisabled(), true);
  await node.getByRole('checkbox', { name: /允许向所选供应商/ }).check();
  await button.click();
}

async function wireVideoReference(page, node, output) {
  const from = page.locator(`[data-id="${output.id}"] .react-flow__handle.source[data-handleid="ref"]`);
  const to = node.locator('.react-flow__handle.target[data-handleid="first"]');
  await from.waitFor();
  await to.waitFor();
  // Allow the fit animation to settle before measuring pointer coordinates.
  await pause(450);
  const [sourceBox, targetBox] = await Promise.all([from.boundingBox(), to.boundingBox()]);
  assert.ok(sourceBox && targetBox);
  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 20 });
  await page.mouse.up();
  await node.getByText(`首帧 · ${output.data.title}`, { exact: true }).waitFor();
}

async function checkExport(project, image, video) {
  const response = await api(`/api/projects/${project}/export`, 'POST', {});
  assert.equal(response.status, 200);
  const archive = (await response.json()).path;
  const python = process.env.H3_TEST_PYTHON || 'python';
  const result = execFileSync(python, ['-B', '-c', [
    'import hashlib, json, sys, zipfile',
    'with zipfile.ZipFile(sys.argv[1]) as archive:',
    '    print(json.dumps([archive.namelist(), archive.read("project.json").decode(),',
    '        *[hashlib.sha256(archive.read(leaf)).hexdigest() for leaf in sys.argv[2:]]]))',
  ].join('\n'), archive, image.path, video.path], { encoding: 'utf8' });
  const [members, document, imageHash, videoHash] = JSON.parse(result);
  assert.ok(members.every(name => name === 'project.json' || name.startsWith('assets/') || name.startsWith('outputs/')));
  assert.ok(!document.includes(key) && !document.includes('signature='));
  assert.deepEqual([imageHash, videoHash], [image.sha256, video.sha256]);
  if (artifacts) await copyFile(archive, path.join(artifacts, 'cloud-media-fixture.zip'));
}

async function actualProject(id) {
  const response = await api(`/api/projects/${id}`);
  assert.equal(response.status, 200);
  return response.json();
}

async function assertMediaSaved(id, kind) {
  return waitFor(async () => {
    const document = await actualProject(id);
    const output = document.canvas.nodes.find(node => node.type === 'media' && node.data.output && node.data.kind === kind);
    if (!output) return;
    const entry = document.assets.find(asset => asset.path === output.data.assetPath);
    assert.ok(entry);
    assert.ok(document.canvas.edges.find(edge => edge.source === output.data.sourceCloudId && edge.target === output.id));
    const blob = await api(`/api/projects/${id}/${entry.path}`);
    assert.equal(blob.status, 200);
    assert.equal(digest(Buffer.from(await blob.arrayBuffer())), entry.sha256);
    assert.ok(!JSON.stringify(document).includes(key));
    assert.ok(!JSON.stringify(document).includes('signature='));
    return { output, entry, revision: document.revision };
  });
}

async function assertPlayable(page, output) {
  const video = page.locator(`[data-id="${output.id}"] video`).first();
  await video.waitFor({ state: 'attached' });
  const fact = await video.evaluate(async element => {
    element.muted = true;
    await element.play();
    return { width: element.videoWidth, height: element.videoHeight, duration: element.duration };
  });
  assert.deepEqual(fact, { width: 128, height: 72, duration: 1 });
}

try {
  await mkdir(workbenchEnv.HOME);
  await mkdir(runtime);
  await mkdir(workbenchEnv.H3_COMFY_ROOT);
  await mkdir(path.join(workbenchEnv.H3_COMFY_ROOT, 'ComfyUI'));
  await writeFile(path.join(runtime, 'config.json'), JSON.stringify({ updates: { autoCheck: false } }));
  if (artifacts) await mkdir(artifacts, { recursive: true });
  await start();
  browser = await chromium.launch({ headless: true, chromiumSandbox: true });
  const listing = await (await api('/api/projects')).json();
  const project = listing.projects.find(row => row.name === 'Cloud media fixture').id;
  const other = listing.projects.find(row => row.name === 'Independent project').id;
  const initialOther = await actualProject(other);
  let { page, context } = await gotoProject();

  const image = await createNode(page, '云端图片生成');
  await image.getByLabel('图像模型 ID', { exact: true }).fill('fixture-image');
  await image.getByLabel('提示词', { exact: true }).fill('browser image fixture');
  const gen = image.getByRole('button', { name: '提交云端生成', exact: true });
  await image.getByRole('checkbox').check();
  assert.equal(await gen.isDisabled(), true);
  await configure(image);
  await submit(image, 'browser image fixture');
  await image.getByRole('status').filter({ hasText: '媒体已准备好' }).waitFor();
  await image.getByRole('button', { name: '加入画布', exact: true }).click();
  await image.getByRole('button', { name: '已加入画布', exact: true }).waitFor();
  const imageSaved = await assertMediaSaved(project, 'image');
  const original = (await actualProject(project)).canvas.nodes.find(node => node.id === 'reference');
  assert.notEqual(imageSaved.entry.path, original.data.assetPath);
  await page.locator(`[data-id="${imageSaved.output.id}"] img`).first().waitFor();
  if (artifacts) await page.screenshot({ path: path.join(artifacts, 'image-adopted.png') });

  const video = await createNode(page, '云端视频生成');
  await wireVideoReference(page, video, imageSaved.output);
  await configure(video);
  await submit(video, 'browser video fixture');
  await video.getByRole('status').filter({ hasText: 'ark-fixture' }).waitFor();
  const pending = await actualProject(project);
  const videoAttempt = pending.canvas.nodes.find(node => node.type === 'cloudMedia' && node.data.cloudKind === 'video').data.cloudAttempt;
  assert.equal((await api(`/api/cloud-media/${other}/${videoAttempt}`)).status, 404);
  await context.close();
  await stop();

  // An entirely new launcher and browser profile reopen the actual saved project.
  await start();
  ({ page, context } = await gotoProject());
  await page.getByTitle('适应画布', { exact: true }).click();
  const reopened = generationNode(page, '云端视频生成');
  await reopened.getByRole('status').filter({ hasText: 'ark-fixture' }).waitFor();
  const query = reopened.getByRole('button', { name: '查询原任务', exact: true });
  await query.click();
  await reopened.getByRole('alert').filter({ hasText: '重新配置提交任务时的供应商' }).waitFor();
  await configure(reopened);
  for (const state of ['已排队', '生成中', '媒体已准备好']) {
    await query.click();
    await reopened.getByRole('status').filter({ hasText: state }).waitFor();
  }
  await reopened.getByRole('button', { name: '加入画布', exact: true }).click();
  await reopened.getByRole('button', { name: '已加入画布', exact: true }).waitFor();
  const videoSaved = await assertMediaSaved(project, 'video');
  assert.equal(videoSaved.entry.sha256, digest(await readFile(path.join(directory, 'fixture.mp4'))));
  await assertPlayable(page, videoSaved.output);
  if (artifacts) await page.screenshot({ path: path.join(artifacts, 'video-adopted.png') });
  await context.close();

  ({ page, context } = await gotoProject());
  await page.getByTitle('适应画布', { exact: true }).click();
  const outputCard = page.locator(`[data-id="${videoSaved.output.id}"]`);
  await outputCard.locator('.neo-node-title').click({ position: { x: 8, y: 10 } });
  await page.getByTitle('快速定位当前选择或全部内容', { exact: true }).click();
  await assertPlayable(page, videoSaved.output);
  await checkExport(project, imageSaved.entry, videoSaved.entry);
  assert.deepEqual(await assertMediaSaved(project, 'image'), { ...imageSaved, revision: videoSaved.revision });
  assert.deepEqual(await actualProject(other), initialOther);
  const events = (await readFile(providerLog, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.filter(e => e.method === 'POST').map(e => e.path), ['/v1/images/generations', '/api/v3/contents/generations/tasks']);
  assert.equal(events.find(e => e.method === 'POST' && e.path.includes('contents/generations/tasks')).data.content[1].role, 'first_frame');
  assert.ok(events.filter(e => e.path.includes('ark-fixture')).every(e => e.bearer));
  assert.equal(events.filter(e => e.path.includes('ark-fixture')).length, 3);
  assert.equal(events.filter(e => e.path.startsWith('/media/')).length, 1);
  assert.ok(events.filter(e => e.path.startsWith('/media/')).every(e => !e.authorizationPresent));
  assert.deepEqual(external, []);
  assert.deepEqual(pageErrors, []);
  if (artifacts) {
    await page.screenshot({ path: path.join(artifacts, 'cold-reopen.png') });
    await copyFile(providerLog, path.join(artifacts, 'wire.jsonl'));
  }
  console.log(`Cloud media browser E2E passed: project ${project}, image revision ${imageSaved.revision}, video revision ${videoSaved.revision}; 2 POST, 3 original-task GET, 1 unsigned media GET`);
} catch (error) {
  if (artifacts && browser) {
    const current = browser.contexts().flatMap(context => context.pages()).at(-1);
    if (current) await current.screenshot({ path: path.join(artifacts, 'failure.png') }).catch(() => {});
  }
  console.error(logs.slice(-18).join(''));
  throw error;
} finally {
  await browser?.close();
  await stop();
  await rm(directory, { recursive: true, force: true });
}
