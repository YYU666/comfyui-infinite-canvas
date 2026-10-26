import fs from 'node:fs/promises';
globalThis.window = { location: { hostname: '127.0.0.1' } };
const api = await import('./src/workbench-api.js');
const statePath = new URL('../comparison/local-image-research/real-test-state.json', import.meta.url);
const readState = async () => JSON.parse(await fs.readFile(statePath, 'utf8').catch(() => '{}'));
const writeState = (state) => fs.writeFile(statePath, JSON.stringify(state, null, 2));
const action = process.argv[2];
const state = await readState();

async function submit(kind, workflow) {
  const startedAt = new Date().toISOString();
  const result = await api.queuePrompt(workflow, api.createClientId());
  state[kind] = { promptId: result.prompt_id, startedAt };
  await writeState(state);
  console.log(JSON.stringify({ kind, ...state[kind] }));
}

if (action === 'person') {
  await submit('person', api.buildImageWorkflow({
    prompt: '写实全身人像摄影，一位年轻成年东亚女性，黑色长直发，自然清透的面部特征，穿剪裁利落的酒红色短夹克、白色高领针织衫、深色高腰长裤和简洁皮鞋，完整全身从头顶到鞋底都在画面内，双手自然放松，站在有纵深的现代城市街道，柔和日光，真实皮肤纹理，服装材质清晰，50mm 镜头，自然透视，人物参考设定图，无文字，无水印',
    ratio: '9:16', seed: 20261026, imageLora: 'none',
  }));
} else if (action === 'scene') {
  await submit('scene', api.buildImageWorkflow({
    prompt: 'A completely empty contemporary art gallery interior at dusk, cinematic architectural photography, polished concrete floor reflecting warm linear ceiling lights, floor-to-ceiling windows, deep perspective, minimalist walls and benches, realistic materials, quiet atmosphere, 35mm lens, a clean background plate for video, no text, no watermark',
    ratio: '16:9', seed: 20261028, imageLora: 'none',
  }));
} else if (action === 'hd') {
  const file = state.person?.file;
  if (!file) throw new Error('Run status after the person image finishes first.');
  const url = api.viewUrl(file);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Unable to read generated person: ${response.status}`);
  const form = new FormData();
  form.append('image', new Blob([await response.arrayBuffer()], { type: 'image/png' }), file.filename);
  form.append('type', 'input');
  form.append('subfolder', 'workbench');
  form.append('overwrite', 'true');
  const uploaded = await api.comfyFetch('/upload/image', { method: 'POST', body: form });
  const name = uploaded.subfolder ? `${uploaded.subfolder}/${uploaded.name}` : uploaded.name;
  await submit('hd', api.buildImageHdWorkflow({ seed: 42, imageScale: 1.5, references: [{ kind: 'image', slot: 'guide', name }] }));
} else if (action === 'status') {
  const history = await api.getHistory(100);
  for (const kind of ['person', 'scene', 'hd']) {
    const item = state[kind];
    if (!item?.promptId) continue;
    const entry = history[item.promptId];
    const files = api.extractImages(entry);
    if (files.length) {
      item.file = { filename: files[0].filename, subfolder: files[0].subfolder, type: files[0].type };
      item.finishedAt = entry.status?.completed ? new Date().toISOString() : item.finishedAt;
      item.status = entry.status;
      item.messages = entry.status?.messages;
      await writeState(state);
    }
    console.log(JSON.stringify({ kind, promptId: item.promptId, completed: entry?.status?.completed, status: entry?.status?.status_str, file: item.file, messages: entry?.status?.messages?.filter((message) => ['execution_start', 'execution_success', 'execution_error'].includes(message[0])) }));
  }
} else {
  throw new Error('Usage: node real-image-test.mjs person|scene|hd|status');
}
