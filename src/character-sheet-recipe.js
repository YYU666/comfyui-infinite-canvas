// Public generic branches migrated from the runtime resolver; private fixed recipes are unsupported.
export const CHARACTER_SHEET_RECIPE_VERSION = 'generic-v2';
export const CHARACTER_SHEET_TEMPLATE_VERSION = 'portrait-proportions-v2';
export function resolveCharacterSheetRecipe(options) {
  if (options.characterSheetTemplateVersion !== undefined && options.characterSheetTemplateVersion !== CHARACTER_SHEET_TEMPLATE_VERSION) throw new Error('未知角色表提示词模板版本。');
  if (options.characterSheetRecipeVersion !== undefined && options.characterSheetRecipeVersion !== CHARACTER_SHEET_RECIPE_VERSION) throw new Error('公开版本仅支持通用角色表配方。');
  const dual = options.references?.some(ref => ref.slot === 'body_reference' && ref.kind === 'image');
  if (options.characterSheetIdentityMode === 'source-anchored-v1' && options.characterSheetStage === 'three_quarter_portrait') throw new Error('原图优先模式的45°头像需要原始身份图和已接受的正面头像；当前单格输入不足，请选择四格整表生成。');
  const effective = {...options, characterSheetRecipeVersion: CHARACTER_SHEET_RECIPE_VERSION, characterSheetDualReference: Boolean(dual)};
  delete effective.characterSheetFrozenPrompts;
  delete effective.characterSheetFrozenModelNodes;
  return effective;
}
