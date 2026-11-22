// This extracted workflow remains a draft until its custom nodes and licensing
// evidence are available. No UI entry or automatic dependency installation.
export const CHARACTER_SWAP_MAP_STATUS = Object.freeze({
  enabled: false,
  requiredCustomNodes: Object.freeze(['H3MapPrepareFrames', 'H3MapSinglePersonGuide', 'H3MapValidateGuide']),
  reason: '法线引导草稿尚未启用：缺少 H3MapPrepareFrames、H3MapSinglePersonGuide、H3MapValidateGuide 的已核验实现，模型哈希与授权也尚未核实。',
});
export function assertCharacterSwapMapAvailable() {
  if (!CHARACTER_SWAP_MAP_STATUS.enabled) throw new Error(CHARACTER_SWAP_MAP_STATUS.reason);
}
