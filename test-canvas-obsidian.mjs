import assert from 'node:assert/strict';
import test from 'node:test';
import { canvasEdgeLook, canvasNodeModality, canvasNodeStatus } from './src/canvas-obsidian.js';

test('node accents classify legacy, local and public nodes by content', () => {
  assert.equal(canvasNodeModality('generator', { mode: 'image' }), 'gold');
  assert.equal(canvasNodeModality('generator', { mode: 'characterSheet' }), 'violet');
  assert.equal(canvasNodeModality('generator', { mode: 'piH3' }), 'coral');
  assert.equal(canvasNodeModality('generator', { mode: 'customWorkflow', workflowDefinition: { outputs: [{ type: 'model' }] } }), 'jade');
  assert.equal(canvasNodeModality('media', { kind: 'audio' }), 'coral');
  assert.equal(canvasNodeModality('media', { kind: 'model' }), 'jade');
  assert.equal(canvasNodeModality('imageProcess'), 'violet');
});

test('mixed references use their connected media type', () => {
  const generator = { type: 'generator', data: { mode: 'reference' } };
  const image = { type: 'media', data: { kind: 'image' } };
  const video = { type: 'media', data: { kind: 'video' } };
  const audio = { type: 'media', data: { kind: 'audio' } };
  const imageReference = canvasEdgeLook(image, 'ref', generator, 'references');
  const videoReference = canvasEdgeLook(video, 'ref', generator, 'references');
  const audioReference = canvasEdgeLook(audio, 'ref', generator, 'references');
  assert.equal(imageReference.from, imageReference.to);
  assert.equal(videoReference.from, videoReference.to);
  assert.equal(audioReference.from, audioReference.to);
  assert.notEqual(videoReference.to, imageReference.to);
});

test('selection and activity describe endpoints independently of saved outputs', () => {
  const source = { type: 'generator', selected: true, data: { status: 'completed', resultUrl: 'old-result' } };
  const target = { type: 'generator', data: { status: 'queued' } };
  assert.equal(canvasEdgeLook(source, 'video', target, 'guide').linked, true);
  assert.equal(canvasEdgeLook(source, 'video', target, 'guide').activeEndpoint, false);
  target.data.status = 'running';
  assert.equal(canvasEdgeLook(source, 'video', target, 'guide').activeEndpoint, true);
  target.data.status = 'stale';
  assert.equal(canvasEdgeLook(source, 'video', target, 'guide').activeEndpoint, false);
  assert.equal(canvasNodeStatus('media', { kind: 'image', url: 'an-external-preview' }).label, '');
  assert.equal(canvasNodeStatus('media', { kind: 'image', url: 'saved-preview', assetPath: 'images/example.png' }).tone, 'done');
  assert.equal(canvasNodeStatus('note', { noteRole: 'videoDownload', downloadStatus: 'failed' }).tone, 'error');
});
