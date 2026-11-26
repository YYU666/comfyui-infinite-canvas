import assert from 'node:assert/strict';
import {createNative3DNotifications} from './src/native3d-notifications.js';
const id=n=>'n3d_'+n.toString(16).padStart(32,'0');
function fixture({denyStorage=false,rejectResume=false,failAudio=false}={}) {
  const events=[],local=new Map(),session=new Map();
  const storage=map=>({getItem:k=>{if(denyStorage)throw Error('denied');return map.get(k);},setItem:(k,v)=>{if(denyStorage)throw Error('denied');map.set(k,v);}});
  class AudioContext {
    state='suspended';currentTime=0;destination={};
    async resume(){events.push('resume');if(rejectResume)throw Error('autoplay denied');this.state='running';}
    createOscillator(){if(failAudio)throw Error('audio unavailable');return {frequency:{setValueAtTime(){}},connect(){},disconnect(){},start(){events.push('note');},stop(){}};}
    createGain(){return {gain:{setValueAtTime(){},linearRampToValueAtTime(){},exponentialRampToValueAtTime(){}},connect(){},disconnect(){}};}
  }
  const environment={AudioContext,localStorage:storage(local),sessionStorage:storage(session)};
  return {environment,events,local,create:()=>createNative3DNotifications(environment)};
}
const node=(job,status,delivered)=>({type:'native3d',data:{nativeJobId:job,status,nativeDeliveredJobId:delivered}});
{
  const f=fixture(),n=f.create();await n.unlock();
  n.observe([node(id(1),'completed',id(1))]);assert.equal(n.delivered(id(1)),false);
  n.observe([node(id(2),'running'),node(id(2),'completed',id(2))]);assert.equal(n.delivered(id(2)),true);
  assert.equal(n.delivered(id(2)),false);n.arm(id(2));assert.equal(n.delivered(id(2)),false);
  const remount=f.create();await remount.unlock();remount.observe([node(id(2),'running')]);assert.equal(remount.delivered(id(2)),false);
  assert.equal(f.events.filter(x=>x==='note').length,2);
  n.arm(id(3));assert.equal(n.delivered(id(3),'failed'),false);n.arm(id(4));n.discard(id(4));assert.equal(n.delivered(id(4)),false);
}
{
  const f=fixture(),n=f.create();n.arm(id(5));assert.equal(n.delivered(id(5)),false);assert.deepEqual(f.events,[]);
  await n.unlock();assert.equal(n.delivered(id(5)),false);assert.ok(!f.events.includes('note'));
  n.setEnabled(false);n.arm(id(6));assert.equal(n.delivered(id(6)),false);assert.equal(f.create().enabled,false);
  n.setEnabled(true);await n.unlock();assert.equal(n.delivered(id(6)),false);assert.ok(!f.events.includes('note'));
}
for(const options of [{denyStorage:true},{rejectResume:true},{failAudio:true}]) {
  const f=fixture(options),n=f.create();await n.unlock();n.arm(id(7));assert.equal(n.delivered(id(7)),Boolean(options.denyStorage));assert.equal(n.delivered(id(7)),false);
}
assert.equal(await createNative3DNotifications({}).unlock(),false);
console.log('NATIVE3D_NOTIFICATIONS_OK manual unlock, once per job/session, history suppressed, disabled persisted, no delayed replay, denied storage/autoplay/audio isolated');
