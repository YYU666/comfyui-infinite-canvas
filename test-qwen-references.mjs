import assert from 'node:assert/strict';
import { bindQwenPrompt, compileQwenPrompt, displayQwenPrompt, qwenCanvasReferences, remapQwenReferences, orderQwenReferences } from './src/qwen-references.js';
import { copyCanvasSelection, pasteCanvasSelection } from './src/canvas-clipboard.js';
globalThis.window = { location: { hostname: '127.0.0.1' } };
const { buildQwen21EditWorkflow } = await import('./src/workbench-api.js');
const { shareSource } = await import('./src/workflow-sharing.js');
const refs = Array.from({ length: 10 }, (_, i) => ({ id: `image${i + 1}`, kind: 'image', slot: 'references', name: `${i + 1}.png` }));
for (const n of [1, 2, 3, 10]) {
  const input = refs.slice(0, n);
  const prompt = input.map((_, i) => `图${i + 1}`).join(' ');
  const bound = bindQwenPrompt(prompt, input);
  assert.equal(bindQwenPrompt(bound, input), bound, 'binding is idempotent even with image1 ID');
  const graph = buildQwen21EditWorkflow({ references: input, prompt: bound, seed: 42 });
  assert.equal(Object.keys(graph.encode.inputs).filter((key) => key.startsWith('images.image_')).length, n);
  assert.equal(graph.encode.inputs.prompt, input.map((_, i) => `<image${i + 1}>`).join(' '));
  assert.equal(Object.values(graph).filter((node) => node.class_type === 'LoadImage').length, n);
}
assert.throws(() => buildQwen21EditWorkflow({ references: [...refs, { ...refs[0], id: 'eleven' }], prompt: 'edit' }), /最多/);
assert.throws(() => buildQwen21EditWorkflow({ references: [refs[0], refs[0]], prompt: 'edit' }), /重复/);
assert.throws(() => buildQwen21EditWorkflow({ references: [{ ...refs[0], kind: 'video' }], prompt: 'edit' }), /图片/);
const three = refs.slice(0, 3);
const prompt = bindQwenPrompt('图1结构，Image 2 氛围，<image3>笔触，<Picture 2>色彩', three);
assert.equal(compileQwenPrompt(prompt, [three[2], three[0], three[1]]), '<image2>结构，<image3> 氛围，<image1>笔触，<image3>色彩');
assert.throws(() => compileQwenPrompt(prompt, three.slice(0, 2)), /已断开/);
assert.match(displayQwenPrompt(prompt, three.slice(0, 2)), /已断开/);
assert.equal(displayQwenPrompt(prompt, three), '图1结构，图2 氛围，图3笔触，图2色彩');
assert.throws(() => compileQwenPrompt('图4', three), /图4未连接/);
assert.equal(displayQwenPrompt('[[qref:%]]', three), '【无效的图片引用】');
assert.throws(() => compileQwenPrompt('[[qref:%]]', three), /格式无效/);
assert.throws(() => compileQwenPrompt('[[qref:broken', three), /格式无效/);
assert.doesNotThrow(() => remapQwenReferences({ mode: 'qwenEdit', prompt: '[[qref:%]]', qwenReferenceOrder: {} }, new Map()));
assert.deepEqual(orderQwenReferences(three, null), three);
const data = { mode: 'qwenEdit', prompt, qwenReferenceOrder: three.map((ref) => ref.id) };
const copied = remapQwenReferences(data, new Map(three.map((ref) => [ref.id, `copy-${ref.id}`])));
assert.deepEqual(copied.qwenReferenceOrder, three.map((ref) => `copy-${ref.id}`));
assert.equal(compileQwenPrompt(copied.prompt, three.map((ref) => ({ ...ref, id: `copy-${ref.id}` }))), compileQwenPrompt(prompt, three));
const media = three.map((ref) => ({ id: ref.id, type: 'media', data: { kind: ref.kind, slot: ref.slot, title: 'Private title' } }));
const generator = { id: 'generator', data: { mode: 'qwenEdit' } };
assert.deepEqual(qwenCanvasReferences(generator, media, [
  { source: 'image2', target: 'generator', targetHandle: 'identity' },
  { source: 'image1', target: 'generator', targetHandle: 'guide' },
]).map((ref) => ref.id), ['image1', 'image2']);
const shared = shareSource({ data }, media);
assert.equal(Object.values(shared.workflow).filter((node) => node.class_type === 'LoadImage').length, 3);
assert.equal(shared.workflow.encode.inputs.prompt, compileQwenPrompt(prompt, three));
assert.doesNotMatch(JSON.stringify(shared), /qref:|Private title|copy-image/);
assert.throws(() => shareSource({ data }, media.slice(0, 2)), /已断开/);
const group = [...media, { id: 'qwen', type: 'generator', data }].map((node, i) => ({ ...node, selected: true, position: { x: i * 400, y: 0 } }));
const edges = media.map((node, i) => ({ id: `edge${i}`, source: node.id, target: 'qwen', targetHandle: 'references' }));
let nextId = 0;
const pasted = pasteCanvasSelection(copyCanvasSelection(group, edges), group, (kind) => `copy-${kind}-${nextId++}`);
const pastedQwen = pasted.nodes.find((node) => node.type === 'generator');
assert.equal(compileQwenPrompt(pastedQwen.data.prompt, qwenCanvasReferences(pastedQwen, pasted.nodes, pasted.edges)), compileQwenPrompt(prompt, three));
assert.doesNotMatch(pastedQwen.data.prompt, /qref:image[123]/);
const turbo = buildQwen21EditWorkflow({ references: three, prompt, qwenModel: 'turbo', seed: 99 });
assert.equal(turbo.sigmas.inputs.sigmas.split(',').length, 9);
console.log('QWEN_REFERENCES_OK 1/2/3/10, legacy order, stable binding, removal, malformed imports, clipboard mapping, private-free sharing, Turbo');
