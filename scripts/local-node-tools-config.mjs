import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function loadLocalNodeTools(mode, file = fileURLToPath(new URL('../.local-node-tools/presets.json', import.meta.url))) {
  if (mode !== 'local-tools') return [];
  const items = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  if (!Array.isArray(items) || items.length > 64) throw new Error('本机节点清单格式无效。');
  const seen = new Set();
  return items.map((item) => {
    if (!item || typeof item.preset !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(item.preset) || seen.has(item.preset)
      || typeof item.label !== 'string' || !item.label.trim() || item.label.length > 80
      || (item.description !== undefined && (typeof item.description !== 'string' || item.description.length > 200))) throw new Error('本机节点清单含无效或重复条目。');
    seen.add(item.preset);
    return { preset: item.preset, label: item.label.trim(), description: item.description || '本机未验证工具' };
  });
}
