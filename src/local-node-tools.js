// Compatibility implementations can open old projects, but aren't preinstalled
// official tools. Only an explicit local build can register these shortcuts.
export const LOCAL_NODE_TOOLS = typeof __H3_LOCAL_NODE_TOOLS__ === 'undefined' ? [] : __H3_LOCAL_NODE_TOOLS__;
export const LOCAL_ONLY_PRESETS = new Set([
  'character_sheet', 'character_swap', 'identity_edit', 'local_realism',
  'outfit_edit', 'outfit_qwen21_turbo', 'outfit_qwen21_turbo_7b', 'outfit_muse_v4',
]);

export function availableNodePresets(presets, localTools = LOCAL_NODE_TOOLS) {
  const enabled = new Set(localTools.map((item) => item.preset));
  return Object.fromEntries(Object.entries(presets).filter(([key]) => key !== 'prompt_optimizer' && (!LOCAL_ONLY_PRESETS.has(key) || enabled.has(key))));
}
