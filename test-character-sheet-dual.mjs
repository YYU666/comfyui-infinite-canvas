import assert from 'node:assert/strict';
import{writeFile,mkdir}from'node:fs/promises';
globalThis.window={location:{hostname:'localhost'}};
const{buildCharacterSheetQueuePlan}=await import('./src/workbench-api.js');
const{planCanvasConnection}=await import('./src/canvas-connections.js');
const base={seed:42,qwenSteps:40,references:[{kind:'image',slot:'guide',name:'IDENTITY.png'}]};
const single=buildCharacterSheetQueuePlan(base);
const dual={...base,references:[...base.references,{kind:'image',slot:'body_reference',name:'BODY.png'}]};
const plan=buildCharacterSheetQueuePlan(dual);
assert.equal(plan.referenceMode,'identityBody');
const front=plan.panels.find(p=>p.id==='front_body');assert.deepEqual(front.dependsOn,['front_portrait']);assert.deepEqual(front.inputRoles,{body_source:'body'});
assert.equal(front.single.body_source.inputs.image,'BODY.png');assert.equal(front.single.identity_source.inputs.image,'__H3_CHARACTER_SHEET_PANEL_front_portrait__');assert.deepEqual(front.single.front_body_encode.inputs['images.image_1'],['body_reference',0]);assert.deepEqual(front.single.front_body_encode.inputs['images.image_2'],['identity_source',0]);
for(const id of ['front_portrait','three_quarter_portrait'])assert.equal(JSON.stringify(plan.panels.find(p=>p.id===id).single).includes('BODY.png'),false);
assert.deepEqual(plan.panels.find(p=>p.id==='back_body').single,single.panels.find(p=>p.id==='back_body').single);
for(const stage of ['front_portrait','three_quarter_portrait','front_body','back_body']){const{workflow}=buildCharacterSheetQueuePlan({...dual,characterSheetStage:stage});assert.equal(JSON.stringify(workflow).includes('__H3_CHARACTER_SHEET_PANEL_'),false);if(stage==='front_body'){assert.equal(workflow.identity_source.inputs.image,'IDENTITY.png');assert.equal(workflow.body_source.inputs.image,'BODY.png');}}
const same=buildCharacterSheetQueuePlan({...dual,references:dual.references.map(r=>({...r,name:'same.png'}))});assert.deepEqual(same.panels.find(p=>p.id==='front_body').inputRoles,{body_source:'body'});
const frozenDual=buildCharacterSheetQueuePlan({...dual,characterSheetRecipeVersion:'white-female-approved-20261108-v1',prompt:'white denim nine-head',characterSheetHeadRatio:9});assert.doesNotMatch(frozenDual.panels.find(p=>p.id==='front_body').single.front_body_encode.inputs.prompt,/denim|nine-head|1:9/);
assert.deepEqual(buildCharacterSheetQueuePlan({...dual,references:dual.references.filter(r=>r.slot!=='body_reference')}),single,'disconnect exact fallback');
const nodes=[{id:'identity',type:'media',data:{kind:'image'}},{id:'body',type:'media',data:{kind:'image'}},{id:'sheet',type:'generator',data:{mode:'characterSheet'}}];const edge={source:'identity',sourceHandle:'ref',target:'sheet',targetHandle:'guide'};assert.equal(planCanvasConnection({...edge,source:'body',targetHandle:'body_reference'},nodes,[edge]).error,undefined);assert.equal(planCanvasConnection({...edge,targetHandle:'body_reference'},nodes,[edge]).error,undefined);assert.deepEqual(buildCharacterSheetQueuePlan(JSON.parse(JSON.stringify(dual))),plan);
await mkdir('D:/RefmuseReviews/character-dual-20261108',{recursive:true});await writeFile('D:/RefmuseReviews/character-dual-20261108/compiled-dual-plan.json',JSON.stringify(plan,null,2));
console.log('CHARACTER_DUAL_OK roles/body+savedidentity/single retry/samefile/disconnect/reload/frozen bypass');

const {prepareExtension}=await import('./src/workflow-extensions.js');const sent=[];const originalFetch=globalThis.fetch;globalThis.fetch=async(_url,options)=>{sent.push(JSON.parse(options.body));return {ok:true,json:async()=>({workflow:{}})};};
try{const node={extensionDigest:'a'.repeat(64),nodeDefinitionId:'dual',workflowParameters:{}};await prepareExtension(node,{image_identity:'IDENTITY.png'});await prepareExtension(node,{image_identity:'IDENTITY.png',image_body:'BODY.png'});assert.deepEqual(sent[0].inputs,{image_identity:'IDENTITY.png'});assert.deepEqual(sent[1].inputs,{image_identity:'IDENTITY.png',image_body:'BODY.png'});}finally{globalThis.fetch=originalFetch;}

assert.equal(frozenDual.panels.find(p=>p.id==='front_body').single.front_body_sample.inputs.seed,981306);assert.equal(frozenDual.panels.find(p=>p.id==='front_body').single.cache.inputs.device,'cpu');assert.equal(frozenDual.panels.find(p=>p.id==='front_body').single.front_body_sample.inputs.steps,40);
