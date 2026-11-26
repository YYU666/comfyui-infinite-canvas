import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
globalThis.window={location:{hostname:'localhost'}};
const {buildCharacterSheetQueuePlan}=await import('./src/workbench-api.js');
const a='D:/RefmuseReviews/character-sheet-unified-20261108/';
const b='D:/RefmuseReviews/character-dual-reference-20261108/';
for(const [dir,optionsFile,planFile] of [[a,'compiled-approved-options.json','compiled-approved-plan.json'],[b,'chosen-export-options.json','compiled-final-dual-plan.json']]) {
const options=JSON.parse(await readFile(dir+optionsFile,'utf8'));const evidence=JSON.parse(await readFile(dir+planFile,'utf8'));assert.deepEqual(buildCharacterSheetQueuePlan(options),evidence,planFile+' exact saved evidence');
if(dir===b){options.references.push({kind:'image',slot:'back_reference',name:'back-reference.png'});await writeFile('D:/RefmuseReviews/character-back-20261108/compiled-body-back-plan.json',JSON.stringify(buildCharacterSheetQueuePlan(options),null,2));}
}
console.log('SAVED_APPROVED_AND_FINAL_V3_EXACT_PARITY_OK');
