import assert from 'node:assert/strict';import{createHash}from'node:crypto';import{mkdir,writeFile}from'node:fs/promises';
globalThis.window={location:{hostname:'localhost'}};const{buildCharacterSheetQueuePlan,buildCharacterSheetWorkflow}=await import('./src/workbench-api.js');const{planCanvasConnection}=await import('./src/canvas-connections.js');
const hashes={generic:'f682f420de65afaebd56745458590090e8bd094f3483a5ac158755c298a0667a',dual:'7a05d3af7d25a9721ba5e5b9c401b73ab944811fcf1388e951a0b5e288b3d461',approved:'39be08c8a2d5533cca32f97f506f3da36e7167341ab0291292eebdb739e3a5b6'};
let final;
for(const kind of Object.keys(hashes)){
 const options={seed:42,references:[{kind:'image',slot:'guide',name:'IDENTITY.png'}],...(kind==='approved'?{characterSheetRecipeVersion:'white-female-approved-20261108-v1'}:{})};if(kind==='dual')options.references.push({kind:'image',slot:'body_reference',name:'BODY.png'});
 const noBack=buildCharacterSheetQueuePlan(options);assert.equal(createHash('sha256').update(JSON.stringify({plan:noBack,graph:buildCharacterSheetWorkflow(options)})).digest('hex'),hashes[kind],`${kind} no-back byte-identical prechangegraph`);
 const withBack=buildCharacterSheetQueuePlan({...options,references:[...options.references,{kind:'image',slot:'back_reference',name:'BACK.png'}]});
 assert.equal(withBack.referenceMode,kind==='dual'?'identityBodyBack':'identityBack');
 for(const panel of noBack.panels.filter(p=>p.id!=='back_body'))assert.deepEqual(withBack.panels.find(p=>p.id===panel.id).single,panel.single,`${kind}/${panel.id} unchanged`);
 const back=withBack.panels.find(p=>p.id==='back_body');assert.deepEqual(back.withoutBackSingle,noBack.panels.find(p=>p.id==='back_body').single);
 assert.deepEqual(back.dependsOn,['front_body']);assert.deepEqual(back.inputRoles,{back_source:'back'});assert.deepEqual(back.single.back_body_encode.inputs['images.image_1'],['angle_source',0]);assert.deepEqual(back.single.back_body_encode.inputs['images.image_2'],['back_reference',0]);assert.equal(back.single.back_source.inputs.image,'BACK.png');assert.match(back.single.back_body_encode.inputs.prompt,/authoritative evidence for rear clothing/);
 assert.equal(back.single.back_body_sample.inputs.seed,noBack.panels.find(p=>p.id==='back_body').single.back_body_sample.inputs.seed);
 final=withBack;
}
const retry=buildCharacterSheetQueuePlan({seed:123,characterSheetStage:'back_body',references:[{kind:'image',slot:'guide',name:'COMPLETE_FRONT.png'},{kind:'image',slot:'back_reference',name:'REAR.png'}]}).workflow;
assert.equal(retry.angle_source.inputs.image,'COMPLETE_FRONT.png');assert.equal(retry.back_source.inputs.image,'REAR.png');assert.equal(JSON.stringify(retry).includes('__H3_CHARACTER_SHEET_PANEL_'),false);
const same=buildCharacterSheetQueuePlan({seed:1,references:[{kind:'image',slot:'guide',name:'same.png'},{kind:'image',slot:'back_reference',name:'same.png'}]});assert.deepEqual(same.panels.find(p=>p.id==='back_body').inputRoles,{back_source:'back'});
const nodes=[{id:'image',type:'media',data:{kind:'image'}},{id:'sheet',type:'generator',data:{mode:'characterSheet'}}];assert.equal(planCanvasConnection({source:'image',sourceHandle:'ref',target:'sheet',targetHandle:'back_reference'},nodes,[]).error,undefined);
await mkdir('D:/RefmuseReviews/character-back-20261108',{recursive:true});await writeFile('D:/RefmuseReviews/character-back-20261108/compiled-back-plan.json',JSON.stringify(final,null,2));
console.log('CHARACTER_BACK_OK exact no-back parity/approved first3 unchanged/backrole/single retry/samefile/fallback');
