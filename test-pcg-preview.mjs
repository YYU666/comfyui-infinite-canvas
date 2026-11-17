// Server-rendered component fixture only; no browser, canvas page or live service.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReactFlowProvider } from '@xyflow/react';
import { pcgNodeData } from './src/pcg-registry.js';

const fixture = resolve('.cache/pcg-preview');
await mkdir(fixture, { recursive: true });
const output = resolve(fixture, 'component.mjs');
await build({ entryPoints: ['src/PcgNode.jsx'], outfile: output, bundle: true,
  platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' });
const { default: PcgNode } = await import(pathToFileURL(output).href);
const render = (data, state = {}) => renderToStaticMarkup(
  React.createElement(ReactFlowProvider, null, React.createElement(PcgNode, { data, state })));
const data = pcgNodeData('refmuse.pcg.diagnostic');
const task = { jobId: 'pcg_fixture', runId: 'run-fixture', revision: 1,
  descriptorId: data.descriptorId, descriptorVersion: 1, operationVersion: 1,
  status: 'succeeded', progress: 1, result: { report: { label: '<safe-report>', workerPid: 123 } } };
const current = render(data, { task });
assert.match(current, /实际诊断报告/);
assert.match(current, /pcg_fixture/);
assert.match(current, /&lt;safe-report&gt;/);
assert.doesNotMatch(current, /<canvas|<script|<input|<button/);
assert.match(render(data, { task: { ...task, stale: true } }), /过期任务/);
assert.match(render(data, { task: { ...task, status: 'failed', result: null,
  error: { code: 'WORKER_PROTOCOL', message: 'Invalid response' } } }), /WORKER_PROTOCOL/);
assert.match(render(pcgNodeData('refmuse.pcg.geometry_stub')), /EXECUTOR_UNAVAILABLE/);
assert.match(render({ ...data, descriptorVersion: 999 }), /VERSION_UNSUPPORTED/);
console.log('PCG_PREVIEW_OK read-only escaped report, task identity, stale, failure, unavailable and version states');
