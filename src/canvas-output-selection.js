// ComfyUI history can list a LoadVideo / guide clip before SaveVideo.
// Result nodes must bind the file this workbench actually saved, never the input.
const VIDEO_EXT = /\.(mp4|webm|mov|mkv)$/i;

const SAVED_VIDEO_PREFIX = {
  swap: 'H3_CharacterSwap_',
  upscale: 'H3_HD_Refine_',
  reference: 'H3_Workbench_',
  frames: 'H3_Workbench_',
  text: 'H3_Workbench_',
};

const MISSING_VIDEO = {
  swap: '换人任务已结束，但未找到 H3_CharacterSwap 成品视频；未将输入视频作为结果。',
  upscale: '高清二采已结束，但未找到 H3_HD_Refine 成品视频；未将输入视频作为结果。',
  reference: '视频生成已结束，但未找到 H3_Workbench 成品视频；未将输入视频作为结果。',
  frames: '视频生成已结束，但未找到 H3_Workbench 成品视频；未将输入视频作为结果。',
  text: '视频生成已结束，但未找到 H3_Workbench 成品视频；未将输入视频作为结果。',
};

function outputBasename(filename) {
  return String(filename || '').replace(/\\/g, '/').split('/').pop();
}

function isSavedVideo(file, prefix) {
  const name = outputBasename(file?.filename);
  return file?.type === 'output' && name.startsWith(prefix) && VIDEO_EXT.test(name);
}

function selectSavedVideo(files, prefix, missingMessage) {
  const list = Array.isArray(files) ? files : [];
  // SaveVideo runs after LoadVideo, so the newest matching output is the file just written.
  const result = list.findLast((file) => isSavedVideo(file, prefix));
  if (!result) throw new Error(missingMessage);
  return result;
}

export function selectCharacterSwapVideo(files) {
  return selectSavedVideo(files, SAVED_VIDEO_PREFIX.swap, MISSING_VIDEO.swap);
}

export function selectHdRefineVideo(files) {
  return selectSavedVideo(files, SAVED_VIDEO_PREFIX.upscale, MISSING_VIDEO.upscale);
}

/** First-pass reference, frames, and text-to-video all save as video/H3_Workbench. */
export function selectFirstPassVideo(files) {
  return selectSavedVideo(files, SAVED_VIDEO_PREFIX.reference, MISSING_VIDEO.reference);
}

export function selectCompletedVideo(mode, files) {
  const prefix = SAVED_VIDEO_PREFIX[mode];
  if (!prefix) throw new Error('任务已结束，但未找到工作台保存的成品视频；未将输入视频作为结果。');
  return selectSavedVideo(files, prefix, MISSING_VIDEO[mode]);
}

/** Same path “打开文件位置” builds from a result node's saved filename and subfolder. */
export function outputFileLocation(file) {
  const filename = file?.filename || '';
  if (!filename) return null;
  const subfolder = file.subfolder || '';
  return { kind: 'output', name: `${subfolder ? `${subfolder}/` : ''}${filename}` };
}
