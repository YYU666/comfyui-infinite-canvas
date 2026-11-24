import assert from 'node:assert/strict';
import { buildWorkflow, buildReferenceWorkflow, buildCharacterSwapWorkflow, buildHdRefineWorkflow, extractVideos } from './src/workbench-api.js';
import * as selection from './src/canvas-output-selection.js';

// Only local fixture names and fake Comfy history. Any network access fails.
globalThis.fetch = () => { throw new Error('H3 recipe fixture must not contact a service.'); };
const shared = { prompt: 'Synthetic source', ratio: '16:9', duration: 5, seed: 42, turbo: true };
const recipes = {
  frames: { ...shared, firstFrame: 'workbench/start.png', lastFrame: 'workbench/end.png' },
  reference: { ...shared, prompt: '@人物 模仿 @视频，用 @录音', references: [
    { kind: 'image', title: '人物', name: 'workbench/subject.png' },
    { kind: 'video', title: '视频', name: 'workbench/guide.mp4' },
    { kind: 'audio', title: '录音', name: 'workbench/voice.wav' },
  ] },
  swap: { ...shared, references: [
    { kind: 'video', slot: 'guide', name: 'workbench/guide.mp4' },
    { kind: 'image', slot: 'identity', name: 'workbench/subject.png' },
  ] },
  refine: { ...shared, resolution: '720P', references: [
    { kind: 'video', slot: 'guide', name: 'workbench/first-pass.mp4' },
  ] },
};
const build = ({ frames, reference, swap, refine }) => ({
  frames: buildWorkflow(frames),
  reference: buildReferenceWorkflow(reference),
  swap: buildCharacterSwapWorkflow(swap),
  refine: buildHdRefineWorkflow(refine),
});
const reopened = build(JSON.parse(JSON.stringify(recipes)));
assert.deepEqual(reopened, build(recipes));
assert.deepEqual([reopened.frames['17'].inputs.image, reopened.frames['18'].inputs.image], ['workbench/start.png', 'workbench/end.png']);
const ref = reopened.reference['7'].inputs;
assert.equal(ref.prompt, '<Picture 1> 模仿 <Video 1>，用 <Audio 1>');
assert.equal(reopened.reference[ref['ref_images.ref_image_0'][0]].inputs.image, 'workbench/subject.png');
assert.equal(reopened.reference[ref['ref_videos.ref_video_0'][0]].class_type, 'GetVideoComponents');
assert.equal(reopened.reference['101'].inputs.file, 'workbench/guide.mp4');
assert.equal(reopened.reference[ref['ref_audios.ref_audio_0'][0]].inputs.audio, 'workbench/voice.wav');
assert.equal(reopened.swap.source.inputs.file, 'workbench/guide.mp4');
assert.equal(reopened.swap.reference.inputs.image, 'workbench/subject.png');
assert.equal(reopened.refine.source.inputs.file, 'workbench/first-pass.mp4');
assert.deepEqual(reopened.refine.video.inputs.audio, ['components', 1]);
const history = extractVideos({ outputs: {
  guide: { videos: [{ filename: 'first-pass.mp4', subfolder: 'workbench', type: 'input' }] },
  result: { videos: [{ filename: 'H3_HD_Refine_00001_.mp4', subfolder: 'video', type: 'output' }] },
} });
assert.equal(history.length, 2);
assert.equal(history[0].type, 'input');
assert.equal(history[1].filename, 'H3_HD_Refine_00001_.mp4');
assert.equal(history[1].type, 'output');
if (selection.selectCompletedVideo) {
  const result = selection.selectCompletedVideo('upscale', history);
  assert.deepEqual(selection.outputFileLocation(result), { kind: 'output', name: 'video/H3_HD_Refine_00001_.mp4' });
}
console.log('H3_VIDEO_PROVENANCE_OK reference image/video/audio, frames, swap, refine and saved recipes');
