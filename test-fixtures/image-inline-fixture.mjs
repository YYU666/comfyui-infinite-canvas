export function imageInlineFixture() {
  const generator = (id, promptId, queueJobId, x, y) => ({ id, type: 'generator', position: { x, y }, data: {
    title: id, mode: 'image', imageModel: 'moss', status: 'done', promptId, queueJobId,
    resultUrl: `/api/comfy/view?filename=${id}-current.png&type=output`, runs: [{ promptId, status: 'done' }],
  } });
  const output = (id, owner, promptId, queueJobId, x, y) => ({ id, type: 'media', position: { x, y }, data: {
    title: id, kind: 'image', output: true, sourceGeneratorId: owner, sourcePromptId: promptId, sourceQueueJobId: queueJobId,
    url: `/api/comfy/view?filename=${id}.png&type=output`, filename: `${id}.png`, type: 'output',
  } });
  const nodes = [generator('g1', 'p-current', 'q-current', 0, 80),
    output('current', 'g1', 'p-current', 'q-current', 500, 80),
    output('historical', 'g1', 'p-old', 'q-old', 500, 750),
    output('old-multi-a', 'g1', 'p-multi', 'q-multi', 2000, 80),
    output('old-multi-b', 'g1', null, 'q-multi', 2500, 80),
    generator('consumer', null, null, 1000, 80),
    generator('multi', 'p-multi-now', 'q-multi-now', 3000, 80),
    output('multi-a', 'multi', 'p-multi-now', 'q-multi-now', 3500, 80),
    output('multi-b', 'multi', null, 'q-multi-now', 4000, 80)];
  const edges = nodes.filter(node => node.data.output).map(node => ({ id: `preview-${node.id}`, source: node.data.sourceGeneratorId, target: node.id, sourceHandle: 'image', targetHandle: 'preview' }));
  edges.push({ id: 'historical-reference', source: 'historical', sourceHandle: 'ref', target: 'consumer', targetHandle: 'references', data: { userLabel: 'keep old image' } });
  return { nodes, edges, viewport: { x: 80, y: 30, zoom: 0.55 } };
}
