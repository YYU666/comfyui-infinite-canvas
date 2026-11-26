// One pending frame at most; OrbitControls changes/damping wake the viewer.
export function createDemandRender({update,render,request=globalThis.requestAnimationFrame,cancel=globalThis.cancelAnimationFrame}) {
  let pending=null,disposed=false;
  const draw=()=>{pending=null;if(disposed)return;const changing=update();if(disposed)return;render();if(changing)invalidate();};
  const invalidate=()=>{if(!disposed&&pending===null)pending=request(draw);};
  return {invalidate,dispose(){disposed=true;if(pending!==null)cancel(pending);pending=null;}};
}
