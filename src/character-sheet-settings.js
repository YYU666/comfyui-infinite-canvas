import { CHARACTER_SHEET_RECIPE_VERSION, CHARACTER_SHEET_TEMPLATE_VERSION } from './character-sheet-recipe.js';
export const CHARACTER_SHEET_DELIVERY_CROP = Object.freeze({x:108,y:384,width:936,height:1664});
export const CHARACTER_SHEET_PRESETS = Object.freeze({
  reference: { label: '参考优先', description: 'Preserve the reference body proportions and distinctive traits.' },
  natural_adult: { label: '自然成人', description: 'Use natural adult proportions around 7–8 anatomical heads.' },
  heroic_nine_head: { label: '英雄九头身', description: 'Use a heroic nine-head silhouette with natural joints.' },
  short_stout: { label: '矮壮', description: 'Use a shorter, stockier build and compact proportions.' },
  stylized: { label: '风格化', description: 'Retain the reference stylization; fill unclear proportions consistently with its visual language.' },
  custom: { label: '自定义', description: 'Use only explicit instructions and reference evidence; invent no idealized body proportions.' },
});
export const CHARACTER_SHEET_STAGES = Object.freeze({ all: '四格整表', front_portrait: '正面近景头像', three_quarter_portrait: '45°近景头像', front_body: '正面完整身体', back_body: '背面完整身体' });
export const CHARACTER_SHEET_TEXT_FIELDS = Object.freeze({ characterSheetBuild: '体格', characterSheetLegs: '腿部比例', characterSheetTorso: '躯干比例', characterSheetShoulders: '肩部', characterSheetHips: '胯部', characterSheetPosture: '站姿', characterSheetPreserveTraits: '保留特征', characterSheetPortraitBrief: '头像身份 / 风格要求' });
export const CHARACTER_SHEET_SETTING_KEYS = Object.freeze(['characterSheetIdentityMode','characterSheetRecipeVersion','characterSheetTemplateVersion','characterSheetPortraitCrop','characterSheetStageSeeds','characterSheetDeliveryCrop', 'characterSheetPreset', 'characterSheetStage', 'characterSheetHeadRatio', ...Object.keys(CHARACTER_SHEET_TEXT_FIELDS)]);
export function validateCharacterSheetSettings(settings = {}) {
  if (settings.characterSheetIdentityMode === 'source-anchored-v1' && settings.imageLora === 'qwen21Realism' && settings.loraStrength !== undefined && !(typeof settings.loraStrength === 'number' && Number.isFinite(settings.loraStrength) && settings.loraStrength >= 0 && settings.loraStrength <= 1)) throw new Error('角色写实强度必须为 0–1。');
  if (settings.characterSheetIdentityMode !== undefined && !['legacy','source-anchored-v1'].includes(settings.characterSheetIdentityMode)) throw new Error('未知角色身份参考模式。');
  if (settings.characterSheetRecipeVersion !== undefined && !['generic-v2',CHARACTER_SHEET_RECIPE_VERSION].includes(settings.characterSheetRecipeVersion)) throw new Error('未知角色表配方版本。');
  if (settings.characterSheetTemplateVersion !== undefined && settings.characterSheetTemplateVersion !== CHARACTER_SHEET_TEMPLATE_VERSION) throw new Error('未知角色表提示词模板版本。');
  if (settings.characterSheetPortraitCrop !== undefined) {
    const crop=settings.characterSheetPortraitCrop;
    if (!crop || typeof crop !== 'object' || Array.isArray(crop) || Object.keys(crop).sort().join(',') !== 'height,width,x,y' || !Object.values(crop).every(Number.isSafeInteger) || crop.x<0 || crop.y<0 || crop.width<1 || crop.height<1 || crop.x+crop.width>16384 || crop.y+crop.height>16384) throw new Error('characterSheetPortraitCrop 必须为有效原图像素裁切矩形。');
    if (settings.characterSheetIdentityMode !== 'source-anchored-v1' && settings.characterSheetStage && settings.characterSheetStage !== 'all') throw new Error('头像参考预处理仅适用于整表模式。');
  }
  if (settings.characterSheetStageSeeds !== undefined) {
    const seeds=settings.characterSheetStageSeeds;
    if (!seeds || typeof seeds !== 'object' || Array.isArray(seeds) || Object.keys(seeds).some(key=>!['front_portrait','three_quarter_portrait','front_body','back_body'].includes(key)) || Object.values(seeds).some(seed=>!Number.isSafeInteger(seed)||seed<0)) throw new Error('characterSheetStageSeeds 必须包含有效阶段及非负安全整数种子。');
  }
  if (settings.characterSheetPreset !== undefined && !Object.hasOwn(CHARACTER_SHEET_PRESETS, settings.characterSheetPreset)) throw new Error('不支持的 characterSheetPreset。');
  if (settings.characterSheetStage !== undefined && !Object.hasOwn(CHARACTER_SHEET_STAGES, settings.characterSheetStage)) throw new Error('不支持的 characterSheetStage。');
  if (settings.characterSheetDeliveryCrop !== undefined) {
    const crop = settings.characterSheetDeliveryCrop;
    if (!crop || typeof crop !== 'object' || Array.isArray(crop) || Object.keys(crop).sort().join(',') !== 'height,width,x,y' || !Object.values(crop).every(Number.isSafeInteger) || crop.x < 0 || crop.y < 0 || crop.width < 1 || crop.height < 1 || crop.x + crop.width > 1152 || crop.y + crop.height > 2048) throw new Error('characterSheetDeliveryCrop 必须是 1152×2048 内的整数 x/y/width/height。');
  }
  const ratio = settings.characterSheetHeadRatio;
  if (ratio !== undefined && ratio !== 'auto' && !(typeof ratio === 'number' && Number.isFinite(ratio) && ratio >= 2 && ratio <= 12)) throw new Error('characterSheetHeadRatio 必须为 auto 或 2–12 的数字。');
  for (const key of Object.keys(CHARACTER_SHEET_TEXT_FIELDS)) if (settings[key] !== undefined && (typeof settings[key] !== 'string' || settings[key].length > 2000)) throw new Error(`${key} 必须是最多 2000 字符的文本。`);
  return settings;
}
export function characterSheetBodyInstructions(settings = {}) {
  validateCharacterSheetSettings(settings);
  const traits = Object.entries(CHARACTER_SHEET_TEXT_FIELDS).filter(([key]) => key !== 'characterSheetPortraitBrief').filter(([key]) => settings[key]?.trim()).map(([key, label]) => `${label}: ${settings[key].trim()}`);
  if (settings.characterSheetHeadRatio !== undefined && settings.characterSheetHeadRatio !== 'auto') traits.unshift(`Target anatomical head-to-total-height ratio: 1:${settings.characterSheetHeadRatio}; measure skull/chin head height, excluding hair volume.`);
  return `Priority: explicit numeric/text requirements override the selected preset. A selected non-reference preset is an explicit user choice: apply its specified attributes even when the reference differs. Preserve reference evidence for all unspecified attributes. Do not slim, lengthen legs, widen shoulders, lighten skin or beautify unless explicitly requested by the fields or selected preset. Explicit traits: ${traits.join('; ') || 'none'}. Selected preset: ${CHARACTER_SHEET_PRESETS[settings.characterSheetPreset || 'reference'].description}`;
}
export function characterSheetSourceHint(stage = 'all') {
  return stage === 'three_quarter_portrait' ? '连接已接受的正面近景头像；只生成45°这一格。' : stage === 'back_body' ? '连接已接受的完整正面身体图（含头脚）；背身沿用该图体型与服装。' : stage === 'front_body' ? '连接已接受的身份 / 服装参考；输出含头到脚完整原图。' : '连接单人参考；头像要求单独填写，身体配方不会进入头像提示词。';
}
