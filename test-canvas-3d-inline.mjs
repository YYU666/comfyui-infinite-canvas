import assert from 'node:assert/strict';
import { compactInlineImages, extractInlineOutput, inlineImageView, inlineSingleResult } from './src/image-inline-output.js';
import { planCanvasConnection } from './src/canvas-connections.js';
import { visibleLayoutNodes } from './src/canvas-layout.js';
import { modelResultSummary, persistedModelFields, readGeneratedModelFile } from './src/model-result.js';
import { NATIVE3D_PRESETS } from './src/native3d.js';
import { isWhiteMeshStep, WHITE_MESH_STEP_LABEL } from './src/white-mesh-step.js';

const hash = (char) => 'assets/' + char.repeat(64) + '.glb';
const media = (id, kind, extra = {}) => ({ id, type: 'media', data: { kind, output: true, url: `/${id}`, ...extra } });
const generator = (id, extra = {}) => ({ id, type: 'generator', data: { mode: 'image', status: 'done', resultUrl: '/current.png', ...extra } });

const imageCard = media('shot', 'image', { title: '参考图 · 成品 1', sourceGeneratorId: 'render', url: '/current.png' });
const legacy = inlineImageView([generator('render'), imageCard], [{ id: 'preview', source: 'render', target: 'shot', sourceHandle: 'image', targetHandle: 'preview' }]);
assert.equal(legacy.nodes.find((node) => node.id === 'shot').hidden, undefined, 'existing 成品 cards stay visible');
assert.equal(legacy.nodes.find((node) => node.id === 'shot').data.url, '/current.png');

const singleImage = inlineSingleResult('render', imageCard, 1);
assert.equal(singleImage.inlined, true);
assert.equal(singleImage.mediaNode.data.inlineImageOwnerId, 'render');
assert.equal(singleImage.mediaNode.data.url, imageCard.data.url, 'inline binding keeps the media identity');
assert.equal(inlineSingleResult('render', imageCard, 2).inlined, false, 'multiple files stay separate cards');
assert.equal(inlineSingleResult('render', media('clip', 'video'), 1).inlined, true);
assert.equal(inlineSingleResult('render', media('mesh', 'model'), 1).inlined, true);

const video = media('clip', 'video', { inlineImageOwnerId: 'video-gen', sourceGeneratorId: 'video-gen', url: '/clip.mp4' });
const model = media('mesh', 'model', {
  inlineImageOwnerId: 'mesh-gen', sourceGeneratorId: 'mesh-gen', name: 'white.glb', filename: 'white.glb',
  type: 'output', url: '/api/comfy/view?filename=white.glb&type=output', assetPath: hash('a'), whiteMesh: true,
});
const historical = media('mesh-old', 'model', {
  inlineImageOwnerId: 'mesh-gen', sourceGeneratorId: 'mesh-gen', url: '/api/comfy/view?filename=old.glb&type=output', assetPath: hash('b'),
});
const nodes = [
  generator('video-gen', { mode: 'reference', resultUrl: '/clip.mp4', inlineImageOutputId: 'clip' }),
  video,
  generator('mesh-gen', { mode: 'customWorkflow', resultUrl: model.data.url, inlineImageOutputId: 'mesh', workflowDefinition: { geometryOnly: true, inputs: [{ id: 'image', type: 'image' }], outputs: [{ id: 'model', type: 'model' }] } }),
  model, historical,
  { id: 'lod', type: 'native3d', data: { operation: 'source_lod' } },
];
const edges = [
  { id: 'video-down', source: 'clip', target: 'later', sourceHandle: 'ref', targetHandle: 'guide' },
  { id: 'locked', source: 'mesh-old', target: 'lod', sourceHandle: 'model', targetHandle: 'model' },
  { id: 'current-model', source: 'mesh', target: 'repair', sourceHandle: 'model', targetHandle: 'model' },
];
const view = inlineImageView(nodes, edges);
assert.deepEqual(view.nodes.filter((node) => node.hidden).map((node) => node.id).sort(), ['clip', 'mesh', 'mesh-old']);
assert.equal(view.edges.find((edge) => edge.id === 'video-down').sourceHandle, 'video');
assert.equal(view.edges.find((edge) => edge.id === 'current-model').source, 'mesh-gen');
assert.equal(view.edges.find((edge) => edge.id === 'current-model').sourceHandle, 'model');
assert.equal(view.edges.find((edge) => edge.id === 'locked').label, '已锁定历史结果');
assert.equal(edges.find((edge) => edge.id === 'locked').source, 'mesh-old', 'persisted edges keep the bound result');
assert.equal(visibleLayoutNodes(nodes).some((node) => node.id === 'mesh'), false);
assert.equal(visibleLayoutNodes([model]).some((node) => node.id === 'mesh'), true, 'orphaned model cards remain visible');

const extracted = extractInlineOutput(nodes, 'mesh-gen');
assert.equal(extracted.extracted, true);
assert.equal(extracted.nodes.find((node) => node.id === 'mesh').data.inlineImageOwnerId, undefined);
assert.equal(extracted.nodes.find((node) => node.id === 'mesh').data.assetPath, model.data.assetPath);
assert.equal(extracted.nodes.find((node) => node.id === 'mesh-gen').data.inlineImageOutputId, undefined);
assert.equal(extracted.nodes.find((node) => node.id === 'mesh-old').data.inlineImageOwnerId, 'mesh-gen', 'extracting the current result leaves older bindings');
assert.equal(extractInlineOutput(nodes, 'missing').extracted, false);

const owner = (id, kind, promptId) => generator(id, { resultUrl: `/${id}`, promptId, queueJobId: `q-${id}` });
const output = (id, ownerId, kind, promptId) => media(id, kind, { sourceGeneratorId: ownerId, sourcePromptId: promptId, sourceQueueJobId: `q-${ownerId}`, url: `/${id}` });
for (const kind of ['video', 'model']) {
  const graph = [owner(kind, kind, 'p1'), output('only', kind, kind, 'p1')];
  const compacted = compactInlineImages(graph, [{ source: kind, target: 'only', targetHandle: 'preview' }], [kind]);
  assert.equal(compacted.compacted[0].outputId, 'only');
  assert.equal(compacted.nodes.find((node) => node.id === 'only').data.inlineImageOwnerId, kind);
  assert.equal(graph[1].data.inlineImageOwnerId, undefined, 'compact does not mutate the saved graph');
}
const ambiguous = [owner('multi', 'image', 'p1'), output('a', 'multi', 'image', 'p1'), output('b', 'multi', 'image', 'p1')];
assert.equal(compactInlineImages(ambiguous, [], ['multi']).compacted.length, 0);

const reference = generator('reference', { resultUrl: '/chest.png', status: 'done' });
const referenceImage = media('chest', 'image', { sourceGeneratorId: 'reference', url: '/chest.png', inlineImageOwnerId: 'reference' });
const whiteMesh = { id: 'white', type: 'native3d', data: { operation: 'image_to_3d', title: WHITE_MESH_STEP_LABEL } };
const imageLink = planCanvasConnection({ source: 'reference', target: 'white', sourceHandle: 'image', targetHandle: 'image' }, [reference, referenceImage, whiteMesh], []);
assert.equal(imageLink.connection.source, 'chest');
assert.equal(imageLink.connection.sourceHandle, 'ref');
assert.equal(imageLink.connection.targetHandle, 'image');
assert.ok(planCanvasConnection({ source: 'reference', target: 'white', sourceHandle: 'image', targetHandle: 'model' }, [reference, referenceImage, whiteMesh], []).error);

const currentModel = { ...model, data: { ...model.data, sourceGeneratorId: 'i23d', inlineImageOwnerId: 'i23d' } };
const previousModel = { ...historical, data: { ...historical.data, sourceGeneratorId: 'i23d', inlineImageOwnerId: 'i23d' } };
const workflow = generator('i23d', {
  mode: 'customWorkflow', status: 'done', resultUrl: currentModel.data.url,
  workflowDefinition: { geometryOnly: true, name: '图生白模', inputs: [{ id: 'image', type: 'image' }], outputs: [{ id: 'model', type: 'model' }] },
});
const repair = { id: 'repair', type: 'native3d', data: { operation: 'repair_lod' } };
const analyze = { id: 'analyze', type: 'native3d', data: { operation: 'analyze', status: 'idle' } };
const deliveredAnalyze = { id: 'delivered', type: 'native3d', data: { operation: 'analyze', sourceJobId: 'n3d_' + '1'.repeat(32) } };
const graph = [workflow, currentModel, previousModel, repair, analyze, deliveredAnalyze, nodes.find((node) => node.id === 'lod')];
for (const target of ['repair', 'analyze', 'lod']) {
  const linked = planCanvasConnection({ source: 'i23d', target, sourceHandle: 'model', targetHandle: 'model' }, graph, []);
  assert.equal(linked.error, undefined, target);
  assert.equal(linked.connection.source, 'mesh');
  assert.equal(linked.connection.sourceHandle, 'model');
}
const bound = { id: 'bound', source: 'mesh-old', target: 'lod', sourceHandle: 'model', targetHandle: 'model' };
const rerun = planCanvasConnection({ source: 'i23d', target: 'repair', sourceHandle: 'model', targetHandle: 'model' }, graph, [bound]);
assert.equal(rerun.connection.source, 'mesh', 'a new connection uses the current saved model');
assert.equal(bound.source, 'mesh-old', 'an upstream rerun does not replace an already bound result');
assert.ok(planCanvasConnection({ source: 'i23d', target: 'delivered', sourceHandle: 'model', targetHandle: 'model' }, graph, []).error);
assert.ok(planCanvasConnection({ source: 'mesh', target: 'lod', sourceHandle: 'model', targetHandle: 'model' }, graph, []).connection);

assert.equal(NATIVE3D_PRESETS.model_image_to_3d[1].title, WHITE_MESH_STEP_LABEL);
assert.equal(isWhiteMeshStep(whiteMesh.data), true);
assert.equal(isWhiteMeshStep(workflow.data), true);
assert.equal(isWhiteMeshStep({ mode: 'customWorkflow', title: '贴图流程', workflowDefinition: { outputs: [{ type: 'model' }, { type: 'image' }], inputs: [{ type: 'image' }] } }), false);
assert.equal(modelResultSummary(model.data).whiteMesh, true);
assert.equal(modelResultSummary(model.data).persisted, true);
assert.match(modelResultSummary({ name: 'shade.glb', bytes: 2048, metadata: { triangles: 120000, vertices: 60000 } }).stats, /120[,.\u00a0]?000 面/);
assert.equal(modelResultSummary({ url: '/api/comfy/view?filename=temp.glb' }).persisted, false);
assert.throws(() => persistedModelFields('assets/not-a-hash.glb', 10));
assert.equal(persistedModelFields(hash('c'), 12).assetPath, hash('c'));

function glbFile(materialCount = 0) {
  const json = Buffer.from(JSON.stringify({ materials: Array.from({ length: materialCount }, () => ({})), meshes: [{ primitives: [{}] }] }));
  const head = Buffer.alloc(20);
  head.write('glTF');
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(20 + json.length, 8);
  head.writeUInt32LE(json.length, 12);
  head.writeUInt32LE(0x4e4f534a, 16);
  return new Blob([head, json]);
}
const saved = await readGeneratedModelFile('/api/comfy/view?filename=white.glb&type=output', 'white.glb', async () => new Response(glbFile(), { status: 200 }));
assert.equal(saved.name, 'white.glb');
assert.equal(saved.type, 'model/gltf-binary');
await assert.rejects(readGeneratedModelFile('/api/comfy/view?filename=note.png', 'note.png', async () => new Response(new Blob(['nope']), { status: 200 })), /GLB/);

console.log('CANVAS_3D_INLINE_OK single-file inline, model preview summary, persisted GLB, white-mesh label, generator-to-step connections');
