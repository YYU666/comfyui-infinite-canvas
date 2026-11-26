import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
globalThis.window={location:{hostname:'localhost'}};
const {buildCharacterSheetQueuePlan,buildCharacterSheetPanelPrompt}=await import('./src/workbench-api.js');
const base={seed:42,characterSheetIdentityMode:'source-anchored-v1',characterSheetRecipeVersion:'white-female-approved-20261108-v1',imageLora:'qwen21Realism',loraStrength:0.45,qwenCacheDevice:'cpu',qwenSteps:40,characterSheetStageSeeds:{front_portrait:781307,three_quarter_portrait:2096285145,front_body:981306,back_body:617210},references:[{kind:'image',slot:'guide',name:'identity-reference.png'}]};
const results=[];
for(const body of [false,true])for(const back of [false,true])for(const crop of [false,true]){
 const options={...base,references:[...base.references,...(body?[{kind:'image',slot:'body_reference',name:'body-reference.png'}]:[]),...(back?[{kind:'image',slot:'back_reference',name:'back-reference.png'}]:[])],...(crop?{characterSheetPortraitCrop:{x:80,y:30,width:620,height:700}}:{})};
 const plan=buildCharacterSheetQueuePlan(options);assert.equal(plan.fidelityMode,'sourceAnchored');assert.equal(plan.panels.length,4);
 for(const id of ['front_portrait','three_quarter_portrait']){
  const p=plan.panels.find(p=>p.id===id),g=p.single;
  assert.equal(Object.values(g).filter(n=>n.class_type==='KSampler').length,1);
  assert.deepEqual(p.inputRoles,{source:'identity'});assert.equal(g.realism.inputs.strength_model,0.45);
  assert.deepEqual(g.portrait_reference,{class_type:'ImageScale',inputs:{image:[crop?'portrait_crop':'source',0],upscale_method:'lanczos',width:1152,height:2048,crop:'center'}});
  assert.equal(Object.values(g).some(n=>n.class_type==='ResizeAndPadImage'),false);
  const prompt=g[id+'_encode'].inputs.prompt;
  assert.equal(prompt.split('chest-above-v3').length-1,2);
  assert.match(prompt,/NOT a half-body portrait/);
  assert.match(prompt,/ABOVE the chest\/bust/);
  assert.match(prompt,/ONLY to features visible inside the required portrait crop/);
  assert.doesNotMatch(prompt,/controls output scale/);
  assert.doesNotMatch(g[id+'_encode'].inputs.prompt,/long braid|ornate hair crown|nine.head|1:9/i);
  assert.match(g[id+'_encode'].inputs.prompt,/Mandatory photographic transformation of materials and lighting, with the original facial geometry locked/);
 }
 const angle=plan.panels[1];assert.deepEqual(angle.dependsOn,['front_portrait']);assert.deepEqual(angle.single.three_quarter_portrait_encode.inputs['images.image_2'],['portrait_reference',0]);assert.equal(angle.single.source.inputs.image,'identity-reference.png');assert.equal(angle.single.angle_source.inputs.image,'__H3_CHARACTER_SHEET_PANEL_front_portrait__');
 const angleInputs=angle.single.three_quarter_portrait_encode.inputs;
 assert.deepEqual(angleInputs['images.image_1'],['angle_source',0]);
 assert.match(angleInputs.prompt,/<image2> is the ORIGINAL identity reference and is authoritative for facial anatomy/);
 assert.match(angleInputs.prompt,/Reference images determine identity, not output orientation/);
 assert.match(angleInputs.prompt,/pose instruction is authoritative for orientation/);
 assert.match(angleInputs.prompt,/Rotate the head and shoulders together 45 degrees toward the viewer's left/);
 assert.match(angleInputs.prompt,/eyes follow the turned head/);
 assert.match(angleInputs.prompt,/visibly asymmetric cheek exposure.*foreshortened far eye; both eyes remain visible, not a full profile/);
 assert.match(angleInputs.prompt,/Preserve the same facial anatomy in perspective/);
 assert.doesNotMatch(plan.panels[0].single.front_portrait_encode.inputs.prompt,/Rotate the head and shoulders/);
 results.push({body,back,crop,plan});
}
// Both rendering modes must keep source geometry above conflicting style requests.
for (const imageLora of ['none', 'qwen21Realism']) for (const view of ['front_portrait', 'three_quarter_portrait']) {
 const prompt=buildCharacterSheetPanelPrompt('',view,{...base,imageLora,characterSheetPreserveTraits:'Keep original eyelids and lip contour',characterSheetPortraitBrief:'Use a fashion photography style'});
 assert.match(prompt,/Priority order: ORIGINAL identity and facial geometry first, requested view and framing second, lighting and material realism third/);
 assert.match(prompt,/upper and lower eyelid curves, inner and outer canthus relative height and tilt/);
 assert.match(prompt,/eye aperture width-to-height ratio, iris size relative to the aperture and eyelid overlap, and inter-eye spacing/);
 assert.match(prompt,/Preserve the actual source values and relationships/);
 assert.match(prompt,/nose bridge, tip and nostril proportions, lip contour/);
 assert.match(prompt,/Keep even stylized source proportions unchanged/);
 assert.doesNotMatch(prompt,/reduce realism|only to the extent compatible/);
 assert.match(prompt,/Never redesign the face to realistic human norms/);
 assert.match(prompt,/do not freeze frontal 2D landmark positions in a rotated view/);
 assert.match(prompt,/Explicit user identity preservation requirements \(highest priority\): Keep original eyelids and lip contour/);
 assert.match(prompt,/Additional portrait\/style request \(lower priority; apply only where compatible with source identity, facial geometry and required view\/framing\): Use a fashion photography style/);
 assert.doesNotMatch(prompt,/Portrait-only identity\/style instructions|almond|bigger eyes|rounder eyes|large round eyes/i);
 if(imageLora==='qwen21Realism') {
  assert.match(prompt,/Mandatory photographic transformation of materials and lighting/);
  assert.match(prompt,/skin microtexture and subtle subsurface translucency, wet corneal highlights and detailed irises within the unchanged eye proportions, individual hair fibers/);
  assert.match(prompt,/photographic studio key\/fill lighting with natural shadows/);
  assert.match(prompt,/Replace baked game lighting, plastic surfaces and game shaders/);
  assert.match(prompt,/Both source facial proportions and photographic materials\/lighting are required/);
  assert.match(prompt,/Limit photographic treatment to skin microtexture, surface materials and light response/);
 } else {
  assert.match(prompt,/Preserve the original visual style/);
  assert.doesNotMatch(prompt,/Mandatory photographic transformation|Replace baked game lighting/);
 }
}
const legacyPrompt=buildCharacterSheetPanelPrompt('', 'front_portrait', {characterSheetPortraitBrief:'legacy style'});
assert.match(legacyPrompt,/Portrait-only identity\/style instructions.*legacy style/);
assert.doesNotMatch(legacyPrompt,/Priority order:|stylized source proportions/);
assert.throws(()=>buildCharacterSheetQueuePlan({...base,characterSheetStage:'three_quarter_portrait'}),/四格整表/);
assert.throws(()=>buildCharacterSheetQueuePlan({...base,characterSheetRecipeVersion:'unknown'}),/未知角色表配方版本/);
assert.equal(buildCharacterSheetQueuePlan({...base,loraStrength:undefined}).panels[0].single.realism.inputs.strength_model,0.45);
assert.equal(buildCharacterSheetQueuePlan({...base,characterSheetIdentityMode:undefined,characterSheetRecipeVersion:'generic-v2',loraStrength:undefined}).panels[0].single.realism.inputs.strength_model,0.6);
const reference=buildCharacterSheetQueuePlan({...base,imageLora:'none'});assert.equal(reference.panels[0].single.realism,undefined);assert.match(reference.panels[0].single.front_portrait_encode.inputs.prompt,/Preserve the original visual style/);
await mkdir('D:/RefmuseReviews/character-fidelity-20261108',{recursive:true});
await writeFile('D:/RefmuseReviews/character-fidelity-20261108/compiled-source-anchored-plans.json',JSON.stringify(results,null,2));
await writeFile('D:/RefmuseReviews/character-fidelity-20261108/compiled-source-anchored-options.json',JSON.stringify(base,null,2));
console.log('SOURCE_ANCHORED_OK 8 combinations: single pass/role/crop-cover/style retained/original angle/retry');
