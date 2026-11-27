import assert from 'node:assert/strict';
import { analyzePrimaryButton, isGeneratedGLB, nativeModelConnection } from './src/native3d.js';
import { modelPreviewActions, persistGeneratedModelFiles } from './src/model-result.js';
import { extractBakeTextureNode } from './src/native3d-bake-preview.js';
import { lodStageLabel, nativeNextStepPlan, nextStepActions } from './src/native3d-next-step.js';

const whiteMesh = {
  type: 'media',
  data: {
    kind: 'model', output: true, type: 'output', filename: 'white.glb', name: 'white.glb',
    url: '/api/comfy/view?filename=white.glb&type=output',
  },
};
assert.equal(isGeneratedGLB(whiteMesh), true);
const connected = analyzePrimaryButton({ operation: 'analyze' }, { model: whiteMesh });
assert.equal(connected.label, '分析模型');
assert.equal(connected.action, 'run');
assert.equal(analyzePrimaryButton({ operation: 'analyze', assetPath: 'assets/' + 'a'.repeat(64) + '.glb' }, {}).action, 'run');
assert.equal(analyzePrimaryButton({ operation: 'analyze' }, {}).action, 'import');
assert.equal(analyzePrimaryButton({ operation: 'source_lod' }, { model: whiteMesh }), null);

const legacy = modelPreviewActions({ title: '图生白模 · 成品 1', name: 'temp.glb', url: '/api/comfy/view?filename=temp.glb&type=output' });
assert.equal(legacy.persist, true);
assert.equal(legacy.viewLabel, '写入项目并预览');
const stored = modelPreviewActions({ assetPath: 'assets/' + 'b'.repeat(64) + '.glb', url: '/api/comfy/view?filename=temp.glb&type=output' });
assert.equal(stored.view, true);
assert.equal(stored.persist, false);

const hash = 'c'.repeat(64);
const saved = await persistGeneratedModelFiles([
  { kind: 'image', filename: 'preview.png', url: '/preview.png' },
  { kind: 'model', filename: 'second.glb', url: '/api/comfy/view?filename=second.glb&type=output' },
  { kind: 'model', filename: 'third.glb', url: '/api/comfy/view?filename=third.glb&type=output' },
], async (file) => ({ assetPath: `assets/${hash}.glb`, bytes: file.filename.length, localFile: true }));
assert.equal(saved[0].assetPath, undefined);
assert.equal(saved[1].kind, 'model');
assert.equal(saved[1].assetPath, `assets/${hash}.glb`);
assert.equal(saved[1].bytes, 'second.glb'.length);
assert.equal(saved[2].assetPath, `assets/${hash}.glb`);
assert.equal(saved[2].bytes, 'third.glb'.length);

function lodNode(level, lodCount) {
  return {
    type: 'native3d',
    data: {
      operation: 'analyze', status: 'completed', nativeLODLevel: level,
      nativeParameters: { lodCount },
      metadata: { operation: 'source_lod', geometry: { status: 'accepted', selectedLodLevel: level, settings: { lodCount } } },
    },
  };
}
const high = nextStepActions(lodNode(0, 3));
assert.equal(high.find((item) => item.action === 'next_lod').label, `继续${lodStageLabel(1, 3)}`);
assert.match(high.find((item) => item.action === 'next_lod').label, /Medium（中模）/);
assert.equal(nextStepActions(lodNode(2, 3)).some((item) => item.action === 'next_lod'), false);
assert.match(nextStepActions(lodNode(3, 5)).find((item) => item.action === 'next_lod').label, /LOD4/);
assert.equal(nextStepActions(lodNode(1, undefined)).some((item) => item.action === 'next_lod'), true);
const deferredLod = lodNode(0, 3);
deferredLod.data.metadata.geometry.childLodsDeferredUntilUV = true;
assert.equal(nextStepActions(deferredLod).some((item) => item.action === 'next_lod'), false);
assert.equal(nextStepActions(deferredLod).some((item) => item.action === 'uv_plan'), true);

const glb = 'assets/' + 'd'.repeat(64) + '.glb';
const job = 'n3d_' + 'e'.repeat(32);
const texture = (name, fill) => ({ name: `${name}.png`, role: 'texture', assetPath: `assets/${fill.repeat(64)}.png` });
const bake = {
  id: 'bake-node', type: 'native3d', position: { x: 0, y: 0 },
  data: {
    operation: 'bake', status: 'completed', nativeJobId: job, nativeDeliveredJobId: job, resultAssetPath: glb,
    metadata: { operation: 'bake' },
    nativeArtifacts: [
      { name: 'model.glb', role: 'model', assetPath: glb },
      texture('basecolor', '1'), texture('normal', '2'), texture('roughness', '3'),
      texture('metallic', '4'), texture('ao', '5'), texture('orm', '6'),
    ],
  },
};
const extracted = extractBakeTextureNode({ node: bake, channel: 'orm', projectId: 'prj', id: 'tex-orm', position: { x: 10, y: 10 } });
assert.equal(extracted.nodes.length, 1);
assert.equal(extracted.nodes[0].type, 'media');
assert.equal(extracted.nodes[0].data.kind, 'image');
assert.equal(extracted.nodes[0].data.name, 'orm.png');
assert.equal(extracted.nodes.filter((node) => node.data.kind === 'image').length, 1);

const highSha = 'a'.repeat(64);
const lowSha = 'b'.repeat(64);
const meshHash = 'c'.repeat(64);
const lodJob = 'n3d_' + 'd'.repeat(32);
const highPath = `assets/${highSha}.glb`;
const lowPath = `assets/${lowSha}.glb`;
const white = { id: 'model-white', type: 'media', position: { x: 0, y: 0 }, data: { kind: 'model', output: true, assetPath: highPath, name: 'white.glb' } };
const stage = { stage: 'lod0', status: 'accepted', eligibleForDownstream: true, filename: 'lod0.glb', mesh_hash: meshHash, file_sha256: lowSha, geometry: { status: 'accepted', intersectionComplete: true, intersection_pairs_count: 0, mesh_hash: meshHash } };
const lodResult = { id: 'lod-result', type: 'native3d', position: { x: 400, y: 0 }, data: { operation: 'analyze', status: 'completed', sourceJobId: lodJob, sourceNodeId: 'lod-processor', assetPath: lowPath, nativeLODLevel: 0, metadata: { operation: 'source_lod', geometry: { status: 'accepted', selectedLodLevel: 0, selectedStage: 'lod0', settings: { lodCount: 3 } } } } };
const lodJobRecord = { id: lodJob, projectId: 'prj', status: 'succeeded', operation: 'source_lod', parameters: {}, source: { assetPath: highPath, sha256: highSha, highAssetPath: highPath, highSha256: highSha }, result: { metadata: { geometry: { status: 'accepted', selectedLodLevel: 0, selectedStage: 'lod0', sourceFileSha256: highSha, settings: { lodCount: 3 }, stages: [stage] } }, files: [{ name: 'lod0.glb', role: 'export', sha256: lowSha }] } };
const planned = nativeNextStepPlan({ source: lodResult, nodes: [white, lodResult], edges: [{ id: 'wire', source: 'model-white', target: 'lod-processor', sourceHandle: 'model', targetHandle: 'model' }], job: lodJobRecord, projectId: 'prj', action: 'uv_plan', seed: 1, id: 'uv-plan' });
assert.equal(planned.node.data.operation, 'uv_plan');
assert.equal(planned.edges.find((edge) => edge.targetHandle === 'high').source, 'model-white');
const analyzed = { id: 'analyzed-high', type: 'native3d', position: { x: 0, y: 80 }, data: { operation: 'analyze', status: 'completed', assetPath: highPath, originalAssetPath: highPath, name: 'white.glb', kind: 'model' } };
const throughAnalyze = nativeNextStepPlan({ source: lodResult, nodes: [analyzed, lodResult], edges: [{ id: 'high-wire', source: 'analyzed-high', target: 'lod-processor', sourceHandle: 'model', targetHandle: 'high' }], job: lodJobRecord, projectId: 'prj', action: 'uv_plan', seed: 2, id: 'uv-plan-analyzed' });
assert.equal(throughAnalyze.edges.find((edge) => edge.targetHandle === 'high').source, 'analyzed-high');
const bakeTarget = { id: 'bake', type: 'native3d', data: { operation: 'bake' } };
const bakeHigh = nativeModelConnection({ source: white.id, target: bakeTarget.id, sourceHandle: 'model', targetHandle: 'high' }, white, bakeTarget, []);
assert.equal(bakeHigh.connection.targetHandle, 'high');
assert.equal(bakeHigh.connection.source, 'model-white');
const imported = { id: 'import', type: 'native3d', data: { operation: 'analyze', status: 'completed', assetPath: highPath } };
const topology = { id: 'topo', type: 'native3d', data: { operation: 'source_lod' } };
const historical = nativeModelConnection({ source: imported.id, target: topology.id, sourceHandle: 'model', targetHandle: 'model' }, imported, topology, []);
assert.equal(historical.connection.source, 'import');
assert.equal(historical.connection.targetHandle, 'model');

console.log('canvas 3d phase2 ok');
