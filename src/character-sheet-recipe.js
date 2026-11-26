import approved from './character-sheet-approved-recipe.json' with { type: 'json' };
export const CHARACTER_SHEET_RECIPE_VERSION = approved.version;
export const CHARACTER_SHEET_TEMPLATE_VERSION = 'portrait-proportions-v2';
export function resolveCharacterSheetRecipe(options) {
  if (options.characterSheetTemplateVersion !== undefined && options.characterSheetTemplateVersion !== CHARACTER_SHEET_TEMPLATE_VERSION) throw new Error('未知角色表提示词模板版本。');
  const dual = options.references?.some(ref => ref.slot === 'body_reference' && ref.kind === 'image');
  if (options.characterSheetIdentityMode === 'source-anchored-v1') {
    if (options.characterSheetRecipeVersion !== undefined && !['generic-v2', approved.version].includes(options.characterSheetRecipeVersion)) throw new Error('未知角色表配方版本。');
    if (options.characterSheetStage === 'three_quarter_portrait') throw new Error('原图优先模式的45°头像需要原始身份图和已接受的正面头像；当前单格输入不足，请选择四格整表生成。');
    const effective = {...options, characterSheetRecipeVersion:'generic-v2', characterSheetDualReference:Boolean(dual)};
    delete effective.characterSheetFrozenPrompts;
    delete effective.characterSheetFrozenModelNodes;
    return effective;
  }
  if (dual) {
    if (options.characterSheetRecipeVersion !== undefined && !['generic-v2', approved.version].includes(options.characterSheetRecipeVersion)) throw new Error('未知角色表配方版本。');
    const wasLocked = options.characterSheetRecipeVersion === approved.version;
    const effective = {...options,characterSheetRecipeVersion:'generic-v2',characterSheetDualReference:true};
    delete effective.characterSheetFrozenPrompts;
    if (wasLocked) {
      // The frozen single-character recipe is not an explicit dual-reference override.
      Object.assign(effective,{prompt:'',characterSheetPreset:'reference',characterSheetHeadRatio:'auto'});
      for(const key of ['characterSheetBuild','characterSheetLegs','characterSheetTorso','characterSheetShoulders','characterSheetHips','characterSheetPosture','characterSheetPreserveTraits','characterSheetPortraitBrief','characterSheetPortraitCrop','characterSheetStageSeeds']) delete effective[key];
      Object.assign(effective,{qwenSteps:40,qwenRefResolution:1536,qwenCacheDevice:'cpu',imageLora:'none',characterSheetStageSeeds:approved.seeds,characterSheetFrozenModelNodes:approved.modelNodes});
    }
    return effective;
  }
  if (options.characterSheetRecipeVersion === undefined || options.characterSheetRecipeVersion === 'generic-v2') return options;
  if (options.characterSheetRecipeVersion !== approved.version) throw new Error('未知角色表配方版本。');
  if (options.characterSheetStage !== undefined && options.characterSheetStage !== 'all') throw new Error('已验收固定配方仅支持整表 all 模式。');
  return { ...options, characterSheetTemplateVersion: approved.templateVersion, characterSheetStage: 'all', characterSheetPortraitCrop: approved.portraitCrop, characterSheetDeliveryCrop: approved.deliveryCrop, characterSheetStageSeeds: approved.seeds, characterSheetFrozenPrompts: approved.prompts, qwenSteps:40,qwenRefResolution:1536,qwenCacheDevice:'cpu',imageLora:'none', characterSheetFrozenModelNodes:approved.modelNodes };
}
