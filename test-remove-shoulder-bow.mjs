globalThis.window = { location: { hostname: '127.0.0.1' } };
const { buildIdentityEditWorkflow } = await import('./src/workbench-api.js');
const seed = Number(process.argv[2] || 78401);
const denoise = Number(process.argv[3] || 0.5);
const prompt = `Edit this exact full-body front-view photograph. The black satin camisole and black satin shorts are already correct. Preserve the entire image, exact face, body, pose, long black hairstyle, necklace, black outfit and gray background. Make only one change: completely remove the small pale blue fabric bow beside her left shoulder and upper left chest. It is unwanted old clothing, not a butterfly and not a hair accessory. Replace those few pale blue pixels naturally with the surrounding flowing black hair and black camisole strap. No pale blue object anywhere on the chest or shoulder, no bow, no other changes. Photorealistic studio photography.`;
const workflow = buildIdentityEditWorkflow({
  prompt, ratio: '9:16', seed, refPosition: 'aligned (trained)', refBoost: 4, groundingPx: 1280,
  references: [{ kind: 'image', slot: 'guide', name: 'workbench/heroine-front-black-stage1.png' }],
});
workflow.latent = { class_type: 'VAEEncode', inputs: { pixels: ['source', 0], vae: ['vae', 0] } };
workflow.sample.inputs.latent_image = ['latent', 0];
workflow.sample.inputs.denoise = denoise;
workflow.sample.inputs.steps = 16;
workflow.save.inputs.filename_prefix = 'image/H3_OutfitFrontClean';
const response = await fetch('http://127.0.0.1:8188/prompt', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ prompt: workflow, client_id: `remove-shoulder-bow-${Date.now()}` }),
});
const queued = await response.json();
if (!response.ok) throw new Error(JSON.stringify(queued));
console.log(JSON.stringify({ stage: 'queued', seed, denoise, ...queued }));
for (;;) {
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const history = await (await fetch(`http://127.0.0.1:8188/history/${queued.prompt_id}`)).json();
  const entry = history[queued.prompt_id];
  if (!entry) continue;
  if (entry.status?.status_str === 'error') throw new Error(JSON.stringify(entry.status));
  if (!entry.status?.completed) continue;
  const images = Object.values(entry.outputs || {}).flatMap((output) => output.images || []);
  console.log(JSON.stringify({ stage: 'done', images }, null, 2));
  break;
}
