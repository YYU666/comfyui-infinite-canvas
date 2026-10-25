import fs from 'node:fs';
import assert from 'node:assert/strict';
import { File } from 'node:buffer';

globalThis.window = { location: { hostname: '127.0.0.1' } };
const api = await import('../video-workbench/src/workbench-api.js');
const image = new File([fs.readFileSync('../test-frame.png')], 'reference-image.png', { type: 'image/png' });
const audio = new File([fs.readFileSync('../test-reference-audio.wav')], 'reference-audio.wav', { type: 'audio/wav' });
const video = new File([fs.readFileSync('../test-reference-video.mp4')], 'reference-video.mp4', { type: 'video/mp4' });
const [imageName, audioName, videoName] = await Promise.all([
  api.uploadMedia(image, 'image'), api.uploadMedia(audio, 'audio'), api.uploadMedia(video, 'video'),
]);
const references = [
  { kind: 'image', title: '主角', name: imageName },
  { kind: 'video', title: '动作参考', name: videoName },
  { kind: 'audio', title: '声音参考', name: audioName },
];
const workflow = api.buildReferenceWorkflow({ prompt: '@主角 模仿 @动作参考 的动作，声音参考 @声音参考', references, ratio: '16:9', duration: 5, seed: 42, turbo: true });
assert.deepEqual(workflow['7'].inputs.ref_images.ref_image_0, ['100', 0]);
assert.deepEqual(workflow['7'].inputs.ref_videos.ref_video_0, ['201', 0]);
assert.deepEqual(workflow['7'].inputs.ref_video_audios.ref_video_audio_0, ['201', 1]);
assert.deepEqual(workflow['7'].inputs.ref_audios.ref_audio_0, ['102', 0]);
assert.equal(workflow['7'].inputs.prompt, '<Picture 1> 模仿 <Video 1> 的动作，声音参考 <Audio 1>');
const queued = await api.queuePrompt(workflow, 'h3-reference-api-test');
await new Promise(resolve => setTimeout(resolve, 2200));
const resultHistory = await api.comfyFetch(`/history/${queued.prompt_id}`);
const entry = resultHistory?.[queued.prompt_id];
const status = entry?.status || {};
assert.notEqual(status.status_str, 'error', `Immediate execution error: ${JSON.stringify(status.messages || status)}`);
await api.cancelPrompt(queued.prompt_id);
await new Promise(resolve => setTimeout(resolve, 800));
await api.comfyFetch('/interrupt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
const queue = await api.comfyFetch('/queue');
const report = {
  promptStatus: 200, promptId: queued.prompt_id, compiledPrompt: workflow['7'].inputs.prompt,
  imageInput: workflow['7'].inputs.ref_images, videoInput: workflow['7'].inputs.ref_videos,
  videoAudioInput: workflow['7'].inputs.ref_video_audios, audioInput: workflow['7'].inputs.ref_audios,
  immediateExecutionStatus: status.status_str || 'running/loading without error',
  queueRunningAfterCancel: queue.queue_running.length, queuePendingAfterCancel: queue.queue_pending.length,
};
fs.writeFileSync('../reference_api_test_report.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (queue.queue_running.length || queue.queue_pending.length) process.exit(3);
