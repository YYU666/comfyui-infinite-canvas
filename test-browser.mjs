import assert from 'node:assert/strict';
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { chromium as playwrightChromium } from 'playwright-core';
import { IMAGE_MODEL_BY_ID } from './src/image-model-catalog.js';

// Compare paths by canonical filesystem identity. Windows may expose the same
// temporary directory through long and 8.3 short names, including paths whose
// final directories have not been created yet.
const canonicalPath = (target) => {
  let ancestor = resolve(target);
  const missing = [];
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) return resolve(target);
    missing.unshift(basename(ancestor));
    ancestor = parent;
  }
  return resolve(realpathSync.native(ancestor), ...missing);
};
export const samePath = (left, right) => canonicalPath(left) === canonicalPath(right);

export const fixturePageEpoch = 'browser-fixture-page';

export function fixtureMuseObjectInfo(pathname) {
  const model = IMAGE_MODEL_BY_ID.krea2;
  const files = loader => model.files.filter(entry => entry.loader === loader).map(entry => entry.name);
  const definitions = Object.fromEntries(model.nodes.map(name => [name, { input: { required: {} } }]));
  definitions.UNETLoader.input.required = { unet_name: [files('unet')] };
  definitions.CLIPLoader.input.required = { clip_name: [files('clip')], type: [[model.clipType]] };
  definitions.VAELoader.input.required = { vae_name: [files('vae')] };
  definitions.LoraLoaderModelOnly = { input: { required: { lora_name: [Object.values(model.loras)] } } };
  if (pathname === '/object_info') return definitions;
  const name = pathname.split('/').at(-1);
  return definitions[name] ? { [name]: definitions[name] } : {};
}

export function fixtureQueueExecution(submission, project) {
  const node = project.canvas.nodes.find(item => item.id === submission.nodeId);
  assert.equal(submission.projectId, project.id);
  assert.equal(submission.revision, project.revision);
  assert.equal(submission.page.epoch, fixturePageEpoch);
  assert.ok(submission.page.sessionId);
  assert.equal(node?.data.visibleRun?.requestId, submission.requestId);
  return JSON.parse(submission.executionJson);
}

export async function fixtureCurrentPageCommand(api, projectId, tool, args) {
  const pause = () => new Promise(resolve => setTimeout(resolve, 100));
  let current;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try { current = await api(`/api/agent/canvas/current?projectId=${projectId}`); break; }
    catch (error) { if (!/NO_VISIBLE_CANVAS|AMBIGUOUS_CANVAS/.test(error.message)) throw error; }
    await pause();
  }
  assert.ok(current, 'fixture current page became writable');
  const opId = `fixture-command-${crypto.randomUUID()}`;
  await api('/api/agent/canvas/commands', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...current, opId, tool, args }) });
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const command = await api(`/api/agent/canvas/commands/${opId}`);
    if (command.status === 'done') {
      assert.equal(command.result.ok, true, JSON.stringify(command.result));
      return command.result;
    }
    await pause();
  }
  throw new Error('fixture current-page receipt timed out');
}

// Tests use Playwright's managed Chromium by default. CHROME_PATH is an
// explicit escape hatch for a locally installed browser; no machine-specific
// executable path is required by the test suite.
export const chromium = {
  launch(options = {}) {
    const { executablePath: _ignored, ...launchOptions } = options;
    const executablePath = process.env.CHROME_PATH?.trim() || undefined;
    return playwrightChromium.launch({
      ...launchOptions,
      ...(executablePath ? { executablePath } : {}),
    });
  },
};
