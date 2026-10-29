import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '../test-browser.mjs';

const scripts = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(scripts);
const python = process.env.H3_TEST_PYTHON || process.env.PYTHON || 'python';
const temporary = await mkdtemp(path.join(tmpdir(), 'h3-docs-screenshot-'));
const runtime = path.join(temporary, 'runtime');
const projects = path.join(temporary, 'projects');
const output = path.join(root, 'docs', 'images', 'workbench-overview.png');
const env = {
  ...process.env,
  H3_WORKBENCH_RUNTIME_DIR: runtime,
  H3_PROJECTS_ROOT: projects,
  H3_WORKBENCH_DATA_DIR: path.join(temporary, 'data'),
  H3_WORKBENCH_NO_BROWSER: '1',
  H3_WORKBENCH_TEST_MODE: '1',
};
const backend = spawn(python, ['video_workbench_launcher.py'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
backend.stdout.resume();
let backendErrors = '';
backend.stderr.on('data', (chunk) => { backendErrors = `${backendErrors}${chunk}`.slice(-12000); });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let browser;
let base;

try {
  let instance;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      instance = JSON.parse(await readFile(path.join(runtime, 'instance.json'), 'utf8'));
      break;
    } catch {
      if (backend.exitCode !== null) throw new Error(`backend exited ${backend.exitCode}: ${backendErrors}`);
      await sleep(100);
    }
  }
  assert.equal(instance?.pid, backend.pid, 'screenshot must use the isolated backend');
  base = `http://127.0.0.1:${instance.port}`;
  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(health.pid, backend.pid);
  assert.equal(path.resolve(health.projectsRoot), path.resolve(projects));

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  await context.addInitScript(() => {
    window.__canvasTools = {};
    document.modelContext = { registerTool(tool) { window.__canvasTools[tool.name] = tool; } };
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(base);
  await page.locator('.launcher-new').click();
  await page.getByLabel('项目名称').fill('本地视频创作 · 示例项目');
  await page.locator('.modal-actions button[type=submit]').click();
  await page.locator('.neo-app').waitFor();
  await page.waitForFunction(() => Boolean(window.__canvasTools.canvas_create_node));

  const create = async (preset, values) => page.evaluate(async ({ preset, values }) => {
    const result = JSON.parse(await window.__canvasTools.canvas_create_node.execute({ preset, ...values }));
    if (!result.ok) throw new Error(result.error || '创建合成节点失败');
    return result.node.id;
  }, { preset, values });
  const note = await create('note', {
    title: '合成演示数据',
    text: '此截图仅用于项目文档。\n节点与提示词均为合成内容，未连接真实模型，也不代表生成结果。',
    x: -80,
    y: -40,
  });
  const prompt = await create('prompt_optimizer', {
    title: '镜头提示词',
    prompt: '雨夜旧街，镜头缓慢跟随角色，湿地反射霓虹灯光。',
    x: 400,
    y: -80,
  });
  const reference = await create('reference_video', {
    title: '全能参考',
    prompt: '保持角色身份与服装一致，延续参考素材的场景氛围。',
    x: 400,
    y: 260,
  });
  const frames = await create('frames_video', {
    title: '首尾帧生成视频',
    prompt: '角色从画面左侧走向右侧，镜头平稳移动。',
    x: 930,
    y: -80,
  });
  const edit = await create('qwen_edit', {
    title: 'Qwen 2.1 图生图',
    prompt: '保留人物身份、姿势、景别与构图，仅调整指定区域。',
    x: 930,
    y: 390,
  });
  assert(note && prompt && reference && frames && edit);
  await page.evaluate(async ({ prompt, reference, frames }) => {
    await window.__canvasTools.canvas_connect_nodes.execute({ sourceId: prompt, targetId: frames, targetHandle: 'prompt' });
    await window.__canvasTools.canvas_connect_nodes.execute({ sourceId: reference, targetId: frames, targetHandle: 'references' });
  }, { prompt, reference, frames });
  await page.waitForFunction(() => document.querySelectorAll('.react-flow__node').length === 5);
  await sleep(1800);
  await page.locator('button[title="适应画布"]').click();
  await sleep(900);
  assert.deepEqual(pageErrors, []);
  await mkdir(path.dirname(output), { recursive: true });
  await page.screenshot({ path: output, fullPage: false });
  console.log(JSON.stringify({ ok: true, output, syntheticOnly: true, realGeneration: false }));
} finally {
  if (browser) await browser.close();
  if (base) {
    spawnSync(python, ['stop.py'], { cwd: root, env, timeout: 15000 });
    for (let count = 0; count < 50 && backend.exitCode === null; count += 1) await sleep(100);
  }
  if (backend.exitCode === null) backend.kill();
  for (let count = 0; count < 50 && backend.exitCode === null; count += 1) await sleep(100);
  let removed = false;
  for (let count = 0; count < 30 && !removed; count += 1) {
    try { await rm(temporary, { recursive: true, force: true }); removed = true; }
    catch (error) { if (error.code !== 'EBUSY' || count === 29) throw error; await sleep(200); }
  }
}
