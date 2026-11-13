import assert from 'node:assert/strict';
import { migrateCanvas } from './src/canvas-migration.js';
import {
  absentPromptPatches, absentQueueJobPatches, canvasHasActiveTask, classifyExportJob, comfyQueuePromptIds,
  exportJobRequest, exportLookupPatch, patchNodes, promptEventTargets, promptExecutingPatch, promptProgressPatch,
} from './src/canvas-task-state.js';

const node = (id, type, data = {}) => ({ id, type, position: { x: 0, y: 0 }, data });
const jobId = (prefix) => `${prefix}_${'a'.repeat(32)}`;

const stuck = migrateCanvas({
  nodes: [
    node('media', 'media', { kind: 'image', title: '成片', status: 'running', stage: '正在基础采样', progress: 40 }),
    node('note', 'note', { title: '场记', text: '保留这段文字', status: 'running', stage: '正在基础采样' }),
    node('edit', 'videoEdit', {
      title: '剪辑', status: 'running', stage: '正在基础采样', videoEditJobId: jobId('ved'),
      error: '后台导出任务已不存在（工作台可能已重启），请重新导出。',
    }),
    node('chroma', 'videoChromaKey', { title: '扣像', status: 'running', stage: '正在基础采样' }),
    node('remap', 'videoTimeRemap', { title: '变速', status: 'running', stage: '正在导出', rhythmJobId: jobId('vry') }),
    node('gen', 'generator', { title: '视频生成', status: 'running', stage: '正在基础采样', queueJobId: 'job-live', promptId: 'prompt-live' }),
    node('orphan', 'generator', { title: '半成品', status: 'uploading', stage: '正在准备素材' }),
    node('direct', 'generator', { title: '直提', status: 'running', promptId: 'prompt-direct' }),
    node('widget', 'extensionWidget', { opaque: { version: 7 }, status: 'running' }),
    node('prompt', 'prompt', { title: '优化', status: 'optimizing', stage: '正在基础采样', idea: '保留' }),
  ],
  edges: [],
});

const byId = Object.fromEntries(stuck.nodes.map((item) => [item.id, item]));
assert.equal(byId.media.data.status, 'idle');
assert.equal(byId.media.data.stage, '');
assert.equal(byId.media.data.title, '成片');
assert.equal(byId.note.data.status, 'idle');
assert.equal(byId.note.data.text, '保留这段文字');
assert.equal(byId.edit.data.status, 'error');
assert.equal(byId.edit.data.stage, '导出失败');
assert.match(byId.edit.data.error, /请重新导出/);
assert.equal(byId.chroma.data.status, 'error');
assert.match(byId.chroma.data.error, /请重新导出/);
assert.equal(byId.remap.data.status, 'running', 'an export with a job id stays active until that job is checked');
assert.equal(byId.gen.data.status, 'running');
assert.equal(byId.gen.data.queueJobId, 'job-live');
assert.equal(byId.orphan.data.status, 'error');
assert.match(byId.orphan.data.error, /请重新运行/);
assert.equal(byId.direct.data.status, 'running');
assert.equal(byId.widget.data.status, 'running', 'unknown extension nodes are not rewritten');
assert.equal(byId.prompt.data.status, 'idle');
assert.equal(byId.prompt.data.idea, '保留');
assert.equal(canvasHasActiveTask(stuck.nodes), true, 'a live generator and a not-yet-checked export still lock the launcher');
assert.equal(canvasHasActiveTask([byId.media, byId.note, byId.edit, byId.chroma, byId.widget]), false);

const board = [
  node('media', 'media', { title: '素材' }),
  node('note', 'note', { title: '备注', text: 'x' }),
  node('edit', 'videoEdit', { title: '剪辑' }),
  node('gen', 'generator', { title: '生成', promptId: 'prompt-1', status: 'running' }),
  node('other', 'generator', { title: '另一条', promptId: 'prompt-2', status: 'queued' }),
];
assert.deepEqual(promptEventTargets(board, undefined).map((item) => item.id), []);
assert.deepEqual(promptEventTargets(board, null).map((item) => item.id), []);
assert.deepEqual(promptEventTargets(board, '').map((item) => item.id), []);
assert.deepEqual(promptEventTargets(board, 'prompt-1').map((item) => item.id), ['gen']);
assert.deepEqual(promptEventTargets([...board, node('copy', 'media', { promptId: 'prompt-1' }), node('edit-copy', 'videoEdit', { promptId: 'prompt-1' })], 'prompt-1').map((item) => item.id), ['gen']);
assert.equal(promptExecutingPatch({ node: 'sample', prompt_id: undefined }).stage, '正在基础采样');
assert.equal(promptExecutingPatch({ node: null, prompt_id: 'prompt-1' }).status, 'finishing');
assert.match(promptProgressPatch({ value: 3, max: 8, node: 'sample' }).stage, /基础采样 3\/8/);
assert.equal(promptEventTargets(board, undefined).length, 0, 'a sampling event without a prompt id does not select the note or media');

assert.equal(canvasHasActiveTask([], { localImageJobs: 1 }), true);
assert.equal(canvasHasActiveTask([], { videoImportBusy: true }), true);
assert.equal(canvasHasActiveTask([node('img', 'imageProcess', { status: 'running' })]), true);
assert.equal(canvasHasActiveTask([node('img', 'imageProcess', { status: 'idle' })]), false);
assert.equal(canvasHasActiveTask([node('edit', 'videoEdit', { status: 'running', videoEditJobId: jobId('ved') })]), true);

const loaded = new Set(['job-live']);
const seen = new Set();
assert.equal(absentQueueJobPatches(stuck.nodes, [], { loadedJobIds: loaded, seenJobIds: seen }).length, 1);
assert.equal(absentQueueJobPatches(stuck.nodes, [{ id: 'job-live', status: 'running' }], { loadedJobIds: loaded, seenJobIds: seen }).length, 0);
assert.equal(absentQueueJobPatches([node('fresh', 'generator', { status: 'running', queueJobId: 'job-new' })], [], { loadedJobIds: loaded, seenJobIds: seen }).length, 0, 'a job started after open is not cleared by an older empty snapshot');
seen.add('job-new');
const disappeared = absentQueueJobPatches([node('fresh', 'generator', { status: 'running', queueJobId: 'job-new', stage: '正在基础采样' })], [], { loadedJobIds: loaded, seenJobIds: seen });
assert.equal(disappeared[0].patch.status, 'error');
assert.equal(disappeared[0].patch.stage, '任务已中断');
assert.equal(absentQueueJobPatches(stuck.nodes, null, { loadedJobIds: loaded }).length, 0);

assert.deepEqual([...comfyQueuePromptIds({ queue_running: [[0, 'prompt-live']], queue_pending: [{ prompt_id: 'prompt-wait' }] })], ['prompt-live', 'prompt-wait']);
assert.equal(absentPromptPatches([byId.direct], { livePromptIds: new Set(['prompt-direct']), historyIds: new Set() }).length, 0);
assert.equal(absentPromptPatches([byId.direct], { livePromptIds: new Set(), historyIds: new Set(['prompt-direct']) }).length, 0, 'history still owns completion');
assert.equal(absentPromptPatches([byId.direct], { livePromptIds: null, historyIds: new Set() }).length, 0, 'a failed queue read does not invent a missing job');
assert.equal(absentPromptPatches([byId.direct], { livePromptIds: new Set(), historyIds: new Set() })[0].patch.status, 'error');
assert.equal(absentPromptPatches([byId.gen], { livePromptIds: new Set(), historyIds: new Set() }).length, 0, 'queue-owned generators are reconciled from the queue snapshot');

const remapRequest = exportJobRequest(byId.remap);
assert.equal(remapRequest.url, `/api/video-rhythm/jobs/${jobId('vry')}`);
assert.equal(exportJobRequest(byId.chroma), null);
assert.equal(exportLookupPatch(byId.remap, classifyExportJob(404, null)).status, 'error');
assert.match(exportLookupPatch(byId.remap, classifyExportJob(404, null)).error, /请重新导出/);
assert.equal(exportLookupPatch(byId.remap, classifyExportJob(200, { status: 'running', stage: '正在导出' })), null);
assert.equal(exportLookupPatch(byId.remap, classifyExportJob(503, null)), null);
assert.equal(exportLookupPatch(byId.remap, classifyExportJob(200, { status: 'completed' })).status, 'error');
const doneRemap = { ...byId.remap, data: { ...byId.remap.data, rhythmResultAssetPath: 'assets/out.mp4' } };
assert.equal(exportLookupPatch(doneRemap, classifyExportJob(200, { status: 'completed' })).status, 'done');
assert.equal(exportLookupPatch(byId.remap, classifyExportJob(200, { status: 'cancelled', stage: '已取消' })).status, 'cancelled');
assert.equal(patchNodes([byId.remap], [{ id: 'remap', patch: { status: 'error' } }])[0].data.status, 'error');
assert.equal(patchNodes([byId.remap], [{ id: 'remap', patch: { status: 'error' } }])[0].data.rhythmJobId, jobId('vry'));

console.log('CANVAS_TASK_STATE_OK launcher ignores stamped media promptEvents=generator-only staleExport=error liveExport=running');
