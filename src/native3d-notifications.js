const preferenceKey='refmuse.native3d.completionSound.v1';
const consumedKey='refmuse.native3d.completionSound.jobs.v1';
const jobPattern=/^n3d_[a-f0-9]{32}$/;

// Audio is optional and must never affect job delivery. No pending sound queue.
export function createNative3DNotifications(environment=globalThis) {
  const read=(storage,key)=>{try{return environment[storage]?.getItem(key);}catch{return null;}};
  const write=(storage,key,value)=>{try{environment[storage]?.setItem(key,value);}catch{/* Storage may be unavailable. */}};
  let enabled=read('localStorage',preferenceKey)!=='off',context=null;
  const armed=new Set(),consumed=new Set();
  try {const saved=JSON.parse(read('sessionStorage',consumedKey)||'[]');if(Array.isArray(saved))for(const id of saved)if(jobPattern.test(id))consumed.add(id);}catch{/* Ignore invalid preference data. */}
  function consume(id) {
    armed.delete(id);consumed.add(id);
    write('sessionStorage',consumedKey,JSON.stringify([...consumed]));
  }
  async function unlock() {
    if(!enabled)return false;
    try {
      const Audio=environment.AudioContext||environment.webkitAudioContext;
      if(!Audio)return false;
      if(!context||context.state==='closed')context=new Audio();
      if(context.state!=='running')await context.resume();
      return context.state==='running';
    }catch{return false;}
  }
  function arm(id) {if(jobPattern.test(id)&&!consumed.has(id))armed.add(id);}
  function delivered(id,status='succeeded') {
    if(!jobPattern.test(id)||consumed.has(id))return false;
    const expected=armed.has(id);consume(id);
    if(status!=='succeeded'||!expected||!enabled||context?.state!=='running')return false;
    try {
      const start=context.currentTime;
      // Original two-note sine chime, short and quiet; no media or permissions.
      for(const [offset,frequency] of [[0,659.25],[0.12,880]]) {
        const oscillator=context.createOscillator(),gain=context.createGain(),at=start+offset;
        oscillator.type='sine';oscillator.frequency.setValueAtTime(frequency,at);
        gain.gain.setValueAtTime(0,at);gain.gain.linearRampToValueAtTime(0.065,at+0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001,at+0.24);
        oscillator.connect(gain);gain.connect(context.destination);
        oscillator.onended=()=>{try{oscillator.disconnect();gain.disconnect();}catch{}};
        oscillator.start(at);oscillator.stop(at+0.25);
      }
      return true;
    }catch{return false;}
  }
  return {
    get enabled(){return enabled;},
    setEnabled(value){enabled=value===true;write('localStorage',preferenceKey,enabled?'on':'off');if(enabled)void unlock();return enabled;},
    unlock,arm,delivered,
    discard(id){if(jobPattern.test(id))consume(id);},
    observe(nodes){
      for(const node of nodes||[]) {
        const d=node?.data;
        if(node?.type==='native3d'&&d?.nativeJobId&&d.nativeDeliveredJobId!==d.nativeJobId&&['queued','running','finishing'].includes(d.status))arm(d.nativeJobId);
      }
    },
  };
}

export const native3DNotifications=createNative3DNotifications();
