// ComfyUI history may include the source video before the SaveVideo output.
export function selectCharacterSwapVideo(files) {
  const result = files.find((file) => file.type === 'output'
    && file.filename?.startsWith('H3_CharacterSwap_')
    && /\.(mp4|webm|mov|mkv)$/i.test(file.filename));
  if (!result) throw new Error('换人任务已结束，但未找到 H3_CharacterSwap 成品视频；未将输入视频作为结果。');
  return result;
}
