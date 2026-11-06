import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadLocalNodeTools } from './scripts/local-node-tools-config.mjs';
import { availableNodePresets } from './src/local-node-tools.js';
import { NODE_PRESETS } from './src/canvas-mcp.js';

const root = await mkdtemp(path.join(tmpdir(), 'h3-local-tools-'));
try {
  const manifest = path.join(root, 'presets.json');
  // Production must not even read malformed/private configuration.
  await writeFile(manifest, 'private malformed local file');
  for (const mode of ['production', 'development', 'test']) assert.deepEqual(loadLocalNodeTools(mode, manifest), []);
  assert.throws(() => loadLocalNodeTools('local-tools', manifest));
  const entries = [{ preset: 'identity_edit', label: 'Local fixture', description: 'Unverified fixture' }];
  await writeFile(manifest, JSON.stringify(entries));
  assert.deepEqual(loadLocalNodeTools('local-tools', manifest), entries);
  const publicPresets = availableNodePresets(NODE_PRESETS, []);
  for (const id of ['identity_edit', 'character_swap', 'character_sheet', 'outfit_edit', 'outfit_qwen21_turbo', 'outfit_qwen21_turbo_7b', 'outfit_muse_v4', 'local_realism', 'prompt_optimizer']) assert.equal(Object.hasOwn(publicPresets, id), false);
  for (const id of ['qwen_edit', 'image_upscale', 'reference_video', 'frames_video', 'video_download']) assert.ok(publicPresets[id]);
  for (const [id, mode] of [['color_adjust', 'colorAdjust'], ['color_hsl', 'colorAdjust'], ['color_levels', 'colorAdjust'], ['color_curves', 'colorAdjust'], ['image_blend', 'imageBlend'], ['rgba_pack', 'channelPack']]) {
    assert.equal(publicPresets[id][0], 'imageProcess');
    assert.equal(publicPresets[id][1].mode, mode);
  }
  assert.ok(availableNodePresets(NODE_PRESETS, entries).identity_edit);
  assert.equal(availableNodePresets(NODE_PRESETS, entries).character_sheet, undefined);
  await writeFile(manifest, JSON.stringify([...entries, ...entries]));
  assert.throws(() => loadLocalNodeTools('local-tools', manifest), /重复/);
  // Legacy definitions remain readable for saved canvases.
  assert.equal(NODE_PRESETS.character_sheet[1].mode, 'characterSheet');
  console.log('LOCAL_TOOLS_OK production isolation, explicit local registration, legacy compatibility');
} finally { await rm(root, { recursive: true, force: true }); }
