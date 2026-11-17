// Shared deterministic race fixture. No network, real media, or service.
import assert from 'node:assert/strict';
export async function verifyVideoImportGuard(createRunner, type, data, handle) {
  const previousFetch = globalThis.fetch;
  try {
    for (const phase of ['blob', 'saveQueue']) {
      let project = 'prj_old', release, reached;
      const waiting = new Promise(resolve => { release = resolve; });
      const entered = new Promise(resolve => { reached = resolve; });
      const source = { id:'fixture_video', type:'media', data:{kind:'video',url:'/synthetic.mp4'} };
      const current = { id:'processor', type, data:{status:'idle',...data} };
      let writes = 0, mutationsAfterSwitch = 0;
      const jobs = new Map();
      globalThis.fetch = async url => {
        assert.equal(url, '/synthetic.mp4');
        return {ok:true, blob:async()=> { if(phase==='blob'){reached();await waiting;} return new Blob(['synthetic']); }};
      };
      const runner=createRunner({ getProjectId:()=>project,getNodes:()=>[source,current],
        getEdges:()=>[{source:source.id,target:current.id,targetHandle:handle}],jobs,
        updateNode:()=>{if(project!=='prj_old')mutationsAfterSwitch++;},
        saveProjectFile:async()=>{writes++;return {asset:{path:'fixture'}};},
        saveCanvasMedia:async(write,onSaved)=>{if(phase==='saveQueue'){reached();await waiting;}return onSaved(await write(1,project));}
      });
      const result=runner.run(current.id);
      await entered;
      project='prj_new'; release();
      assert.equal((await result).ok,false);
      assert.equal(writes,0); assert.equal(mutationsAfterSwitch,0); assert.equal(jobs.size,0);
    }
  } finally { globalThis.fetch=previousFetch; }
}
