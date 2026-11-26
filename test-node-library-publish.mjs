import assert from 'node:assert/strict';
globalThis.window={location:{hostname:'127.0.0.1'}};
const {createPublishLedger,validatePublishRequest,trustedLibraryMessage,dispatchRecordedPublication}=await import('./src/node-library-publish.js');
const request={requestId:'publish1',digest:'a'.repeat(64),packageId:'user/package',version:'0.2.0'};
let stored='';const storage={getItem:()=>stored,setItem:(_k,v)=>{stored=v;}};let sent=0,time=0,publicStatus='ready';
let lockTail=Promise.resolve();const locks={request:(_name,fn)=>{const result=lockTail.then(fn);lockTail=result.catch(()=>{});return result;}};
const deps={locks,storage,now:()=>time,timeoutMs:10,getBundle:async digest=>({digest,manifest:{packageId:request.packageId,version:request.version,name:'test'}}),archive:async()=>new ArrayBuffer(10),preflight:async()=>({...request,status:publicStatus}),send:async()=>{sent++;}};
const ledger=createPublishLedger(deps);assert.equal((await ledger.publish(request)).status,'submitted');assert.equal(sent,1);assert.equal((await ledger.publish(request)).status,'submitted');assert.equal(sent,1);assert.equal(stored.includes('package\":'),false);
await ledger.result({requestId:'other',ok:true,status:'published'});await ledger.result({requestId:'publish1',ok:true,status:'published'});assert.equal(ledger.get('publish1').status,'submitted','unsent ack rejected');await ledger.sent('publish1');await ledger.result({requestId:'publish1',ok:true,status:'review'});assert.equal(ledger.get('publish1').status,'submitted');
time=11;assert.equal(ledger.get('publish1').status,'unknown');const reloaded=createPublishLedger(deps);await reloaded.publish(request);assert.equal(sent,1,'reload and timeout never resend');await assert.rejects(()=>reloaded.publish({...request,digest:'b'.repeat(64)}));await assert.rejects(()=>reloaded.publish({...request,requestId:'duplicate'}));publicStatus='published';assert.equal((await reloaded.status('publish1')).status,'published');assert.equal(sent,1);assert.equal((await reloaded.status('not-recorded')).status,'unknown');
for(const bad of [{...request,path:'secret.zip'},{...request,digest:'bad'},{...request,mode:'replace'}, {...request,requestId:'../bad'}])assert.throws(()=>validatePublishRequest(bad));
console.log('NODE_LIBRARY_PUBLISH_OK exact installed identity/idempotency/reload/timeout/status no upload');

const frame={};const event={origin:'https://refmuse.cn',source:frame,data:{version:1}};
assert.equal(trustedLibraryMessage(event,frame),true);
assert.equal(trustedLibraryMessage({...event,origin:'https://evil.example'},frame),false);
assert.equal(trustedLibraryMessage({...event,source:{}},frame),false);
assert.equal(trustedLibraryMessage({...event,data:{version:2}},frame),false);
assert.equal(trustedLibraryMessage({...event,source:null},null),false);

let retryStored='',attempts=0;const retryDeps={...deps,storage:{getItem:()=>retryStored,setItem:(_k,v)=>retryStored=v},preflight:async()=>{if(++attempts===1)throw Object.assign(new Error('network'),{code:'PUBLICATION_UNAVAILABLE'});return {...request,status:'ready'};}};
const retryLedger=createPublishLedger(retryDeps);assert.equal((await retryLedger.publish(request)).code,'PUBLICATION_UNAVAILABLE');assert.equal((await retryLedger.publish(request)).status,'submitted');await retryLedger.sent(request.requestId);await retryLedger.result({requestId:request.requestId,ok:false,error:'upload result unconfirmed'});assert.equal(retryLedger.get(request.requestId).status,'unknown');await retryLedger.result({requestId:request.requestId,ok:true,status:'pending_review'});time+=100;assert.equal(retryLedger.get(request.requestId).status,'submitted');assert.equal(retryLedger.get(request.requestId).remoteStatus,'pending_review');

let dispatched=0;await assert.rejects(()=>dispatchRecordedPublication({requestId:'x'},()=>{throw new Error('storage full');},()=>dispatched++));assert.equal(dispatched,0);
assert.equal(validatePublishRequest({...request,version:'0.2.0+build.1'}).version,'0.2.0+build.1');

let tabStored='',tabSends=0;const tabDeps={...deps,storage:{getItem:()=>tabStored,setItem:(_k,v)=>tabStored=v},preflight:async()=>({...request,status:'ready'}),send:async()=>tabSends++};
const tabA=createPublishLedger(tabDeps),tabB=createPublishLedger(tabDeps);
await Promise.all([tabA.publish(request),tabB.publish(request)]);assert.equal(tabSends,1,'simultaneous initialized tabs claim once');await tabA.sent(request.requestId);await tabB.result({requestId:request.requestId,ok:true,status:'published'});assert.equal(tabA.get(request.requestId).status,'published','fresh status sees other tab acknowledgement');

await retryLedger.result({requestId:request.requestId,ok:false,status:'changes_requested',error:'https://secret.example?token=123'});assert.equal(retryLedger.get(request.requestId).status,'failed');assert.equal(retryLedger.get(request.requestId).remoteStatus,'changes_requested');assert.equal(JSON.stringify(retryLedger.get(request.requestId)).includes('secret'),false);
