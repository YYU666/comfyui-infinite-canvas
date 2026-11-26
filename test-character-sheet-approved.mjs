import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
globalThis.window={location:{hostname:'127.0.0.1'}};
const {buildCharacterSheetQueuePlan,buildCharacterSheetWorkflow}=await import('./src/workbench-api.js');
const options={characterSheetRecipeVersion:'white-female-approved-20261108-v1',references:[{kind:'image',slot:'guide',name:'workbench/H3_Qwen21Edit_00087_.png'}]};
const plan=buildCharacterSheetQueuePlan(options);
assert.deepEqual(plan.panels.map(p=>p.id),['portrait_reference','front_portrait','three_quarter_portrait','front_body','back_body']);
const findGraph=v=>{if(!v||typeof v!=='object')return null;if(!Array.isArray(v)&&Object.values(v).some(n=>n?.class_type==='KSampler'))return v;for(const x of Object.values(v)){const g=findGraph(x);if(g)return g;}return null;};
const receipt=[];
for(const panel of plan.panels.slice(1)){
 const evidence=findGraph(JSON.parse(await readFile(`D:/RefmuseReviews/character-sheet-unified-20261108/${panel.id}-accepted-inspect.json`,'utf8')));
 for(const type of ['KSampler','UNETLoader','CLIPLoader','VAELoader','QwenImage21Cache'])assert.deepEqual(Object.values(panel.single).find(n=>n.class_type===type),Object.values(evidence).find(n=>n.class_type===type),`${panel.id} ${type}`);
 const encode=Object.values(panel.single).find(n=>n.class_type==='TextEncodeQwenImage21');const prior=Object.values(evidence).find(n=>n.class_type==='TextEncodeQwenImage21');assert.deepEqual(encode,prior,`${panel.id} exact prompt + encoding`);
 receipt.push({stage:panel.id,exactPromptAndSamplingAndModels:true,seed:panel.single[`${panel.id}_sample`].inputs.seed});
}
assert.deepEqual(plan.panels[1].dependsOn,['portrait_reference']);
assert.deepEqual(plan.panels[4].dependsOn,['front_body']);
assert.deepEqual(plan.panels[4].single.angle_source.inputs.image,'__H3_CHARACTER_SHEET_PANEL_front_body__');
assert.deepEqual(plan.stitch.bottom_row.inputs.image2,['front_body_delivery_pad',0]);
assert.deepEqual(buildCharacterSheetWorkflow(options).bottom_row.inputs.image2,['front_body_delivery_pad',0]);
for(const characterSheetRecipeVersion of ['old','',null])assert.throws(()=>buildCharacterSheetQueuePlan({...options,characterSheetRecipeVersion}));
assert.throws(()=>buildCharacterSheetQueuePlan({...options,characterSheetTemplateVersion:'unknown'}));
await writeFile('D:/RefmuseReviews/character-sheet-unified-20261108/compiled-approved-plan.json',JSON.stringify(plan,null,2));
await writeFile('D:/RefmuseReviews/character-sheet-unified-20261108/compiled-approved-options.json',JSON.stringify(options,null,2));
await writeFile('D:/RefmuseReviews/character-sheet-unified-20261108/compiled-parity.json',JSON.stringify(receipt,null,2));
console.log('CHARACTER_SHEET_APPROVED_PARITY_OK all 4 exact prompts samplers models cache; five stages, body-only final crop');

assert.throws(()=>buildCharacterSheetQueuePlan({...options,characterSheetStage:'front_body'}),/仅支持整表/);
