/** Local read-only WebGL2 turntable. No assets, shaders, or materials are fetched. */
import { parseGlb, fail, identity4, multiply4 } from './glb.js';

const VERTEX=`#version 300 es
precision highp float;
layout(location=0) in vec3 aPosition;
layout(location=1) in vec3 aNormal;
layout(location=2) in mat4 aModel;
layout(location=6) in mat3 aNormalMatrix;
uniform mat4 uViewProjection;
uniform mat3 uTurnNormal;
out vec3 vNormal;
void main(){
  gl_Position=uViewProjection*aModel*vec4(aPosition,1.0);
  vNormal=uTurnNormal*aNormalMatrix*aNormal;
  gl_PointSize=5.0;
}`;
const FRAGMENT=`#version 300 es
precision highp float;
in vec3 vNormal;
uniform float uPoints;
out vec4 outColor;
void main(){
  if(uPoints>0.5 && length(gl_PointCoord-vec2(0.5))>0.5) discard;
  vec3 n=normalize(vNormal);
  float light=0.30+0.62*max(dot(n,normalize(vec3(-0.4,0.8,0.65))),0.0)+0.08*abs(n.z);
  vec3 base=mix(vec3(0.34,0.66,0.74),vec3(0.45,0.85,0.81),uPoints);
  outColor=vec4(base*light,1.0);
}`;
const EMPTY={meshCount:0,instanceCount:0,primitiveCount:0,drawCalls:0,triangleCount:0,pointCount:0,vertexCount:0,gpuBytes:0};
function clone(value) { return value===null?null:JSON.parse(JSON.stringify(value)); }
function validateIdentity(value,depth=0) {
  check(depth<=8,'Identity nesting exceeds budget.','INVALID_IDENTITY');
  if(value===null||typeof value==='boolean')return;
  if(typeof value==='number'){check(Number.isFinite(value),'Identity must be finite JSON.','INVALID_IDENTITY');return;}
  if(typeof value==='string'){check(value.length<=1024,'Identity string exceeds budget.','INVALID_IDENTITY');return;}
  check(typeof value==='object' && (Array.isArray(value)||Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null),'Identity must be plain JSON.','INVALID_IDENTITY');
  const values=Object.values(value);check(values.length<=64,'Identity item count exceeds budget.','INVALID_IDENTITY');
  for(const key of Object.keys(value))check(key.length<=64,'Identity key exceeds budget.','INVALID_IDENTITY');
  values.forEach(v=>validateIdentity(v,depth+1));
}
function errorValue(error) { return {code:error.code??'RENDER_ERROR',message:String(error.message??error).slice(0,240)}; }
function check(test,message,code='GPU_UPLOAD_FAILED') { if(!test)fail(code,message); }
function perspective(fov,aspect,near,far) {
  const f=1/Math.tan(fov/2),m=new Float64Array(16);m[0]=f/aspect;m[5]=f;m[10]=(far+near)/(near-far);m[11]=-1;m[14]=2*far*near/(near-far);return m;
}
function lookAt(eye) {
  const length=Math.hypot(...eye),z=eye.map(v=>v/length);
  let x=[z[2],0,-z[0]],l=Math.hypot(...x);x=x.map(v=>v/l);
  const y=[z[1]*x[2]-z[2]*x[1],z[2]*x[0]-z[0]*x[2],z[0]*x[1]-z[1]*x[0]];
  return new Float64Array([x[0],y[0],z[0],0,x[1],y[1],z[1],0,x[2],y[2],z[2],0,0,0,-length,1]);
}
function rotationY(angle) {
  const m=identity4(),c=Math.cos(angle),s=Math.sin(angle);m[0]=c;m[2]=-s;m[8]=s;m[10]=c;return m;
}
function compileProgram(gl) {
  const shaders=[],program=gl.createProgram();
  try {
    check(program,'Cannot allocate shader program.');
    for(const [type,source] of [[gl.VERTEX_SHADER,VERTEX],[gl.FRAGMENT_SHADER,FRAGMENT]]) {
      const shader=gl.createShader(type);check(shader,'Cannot allocate shader.');shaders.push(shader);
      gl.shaderSource(shader,source);gl.compileShader(shader);
      check(gl.getShaderParameter(shader,gl.COMPILE_STATUS),`Shader compilation failed: ${String(gl.getShaderInfoLog(shader)).slice(0,180)}`,'WEBGL_UNAVAILABLE');gl.attachShader(program,shader);
    }
    gl.linkProgram(program);check(gl.getProgramParameter(program,gl.LINK_STATUS),`Shader link failed: ${String(gl.getProgramInfoLog(program)).slice(0,180)}`,'WEBGL_UNAVAILABLE');
    return {program,viewProjection:gl.getUniformLocation(program,'uViewProjection'),turnNormal:gl.getUniformLocation(program,'uTurnNormal'),points:gl.getUniformLocation(program,'uPoints')};
  } catch(error) { if(program)gl.deleteProgram(program);throw error; }
  finally {for(const shader of shaders)gl.deleteShader(shader);}
}
function release(gl,scene) {
  if(!scene)return;
  for(const vao of scene.vaos)gl.deleteVertexArray(vao);
  for(const buffer of scene.buffers)gl.deleteBuffer(buffer);
  scene.vaos.length=0;scene.buffers.length=0;
}
function upload(gl,cpu) {
  const scene={buffers:[],vaos:[],draws:[],bounds:cpu.bounds,metrics:{...cpu.metrics},center:cpu.bounds.min.map((v,i)=>(v+cpu.bounds.max[i])/2)};
  scene.radius=Math.hypot(...cpu.bounds.max.map((v,i)=>(v-cpu.bounds.min[i])/2));if(scene.radius<1e-12)scene.radius=1;
  const groups=new Map();
  for(const instance of cpu.instances) {
    if(!groups.has(instance.mesh))groups.set(instance.mesh,[]);
    groups.get(instance.mesh).push(instance);
  }
  let actualBytes=0;
  function buffer(target,data) {
    const b=gl.createBuffer();check(b,'GPU buffer allocation failed.');scene.buffers.push(b);gl.bindBuffer(target,b);gl.bufferData(target,data,gl.STATIC_DRAW);actualBytes+=data.byteLength;return b;
  }
  try {
    check(!gl.isContextLost(),'WebGL context is lost.','CONTEXT_LOST');
    for(let i=0;i<16 && gl.getError()!==gl.NO_ERROR;i++) { /* Discard errors from an earlier frame. */ }
    for(const [meshIndex,instances] of groups) {
      const models=new Float32Array(instances.length*16),normals=new Float32Array(instances.length*9);
      instances.forEach((instance,index)=>{
        const m=new Float32Array(instance.worldMatrix);
        for(let c=0;c<3;c++)for(let r=0;r<3;r++)m[c*4+r]=instance.worldMatrix[c*4+r]/scene.radius;
        for(let r=0;r<3;r++)m[12+r]=(instance.worldMatrix[12+r]-scene.center[r])/scene.radius;
        models.set(m,index*16);normals.set(instance.normalMatrix,index*9);
      });
      const modelBuffer=buffer(gl.ARRAY_BUFFER,models),normalBuffer=buffer(gl.ARRAY_BUFFER,normals);
      for(const primitive of cpu.meshes[meshIndex].primitives) {
        const vao=gl.createVertexArray();check(vao,'GPU vertex array allocation failed.');scene.vaos.push(vao);gl.bindVertexArray(vao);
        buffer(gl.ARRAY_BUFFER,primitive.positions);gl.enableVertexAttribArray(0);gl.vertexAttribPointer(0,3,gl.FLOAT,false,0,0);
        if(primitive.normals) {buffer(gl.ARRAY_BUFFER,primitive.normals);gl.enableVertexAttribArray(1);gl.vertexAttribPointer(1,3,gl.FLOAT,false,0,0);}
        else {gl.disableVertexAttribArray(1);gl.vertexAttrib3f(1,0,1,0);}
        gl.bindBuffer(gl.ARRAY_BUFFER,modelBuffer);
        for(let c=0;c<4;c++){const location=2+c;gl.enableVertexAttribArray(location);gl.vertexAttribPointer(location,4,gl.FLOAT,false,64,c*16);gl.vertexAttribDivisor(location,1);}
        gl.bindBuffer(gl.ARRAY_BUFFER,normalBuffer);
        for(let c=0;c<3;c++){const location=6+c;gl.enableVertexAttribArray(location);gl.vertexAttribPointer(location,3,gl.FLOAT,false,36,c*12);gl.vertexAttribDivisor(location,1);}
        if(primitive.indices)buffer(gl.ELEMENT_ARRAY_BUFFER,primitive.indices);
        scene.draws.push({vao,mode:primitive.mode===4?gl.TRIANGLES:gl.POINTS,indexed:!!primitive.indices,count:primitive.indices?.length??primitive.vertexCount,instances:instances.length});
      }
    }
    gl.bindVertexArray(null);gl.bindBuffer(gl.ARRAY_BUFFER,null);
    check(!gl.isContextLost(),'WebGL context was lost during upload.','CONTEXT_LOST');
    check(gl.getError()===gl.NO_ERROR,'GPU rejected geometry upload.');
    scene.metrics.gpuBytes=actualBytes;return scene;
  } catch(error) { release(gl,scene);throw error; }
}

export function createViewer(canvas,{onFrame}={}) {
  check(canvas && typeof canvas.getContext==='function','A canvas is required.','WEBGL_UNAVAILABLE');
  const gl=canvas.getContext('webgl2',{alpha:false,antialias:true,preserveDrawingBuffer:true,powerPreference:'low-power'});
  check(gl,'WebGL2 is unavailable.','WEBGL_UNAVAILABLE');
  const doc=canvas.ownerDocument??globalThis.document;
  const win=doc?.defaultView??globalThis;
  const request=win.requestAnimationFrame?.bind(win),cancel=win.cancelAnimationFrame?.bind(win);
  check(request&&cancel,'Animation frame support is unavailable.','WEBGL_UNAVAILABLE');
  let program=compileProgram(gl),scene=null,disposed=false,contextLost=false,epoch=0,raf=null,lastTime=null;
  const state={status:'ready',loadedIdentity:null,frameCount:0,sceneFrameCount:0,yaw:0,angle:0,rotating:true,visible:!doc?.hidden,cameraFramed:false,camera:null,bounds:null,error:null,contextLost:false,metrics:{...EMPTY}};
  function getState(){return {...clone(state),...state.metrics};}
  function notify(){if(typeof onFrame==='function'){try{onFrame(getState());}catch{/* Caller callbacks cannot corrupt viewer state. */}}}
  function stop(){if(raf!==null){cancel(raf);raf=null;}lastTime=null;}
  function visible(){return !disposed&&!contextLost&&!doc?.hidden;}
  function camera() {
    const dpr=Math.max(1,Math.min(2,Number(win.devicePixelRatio)||1));
    const rawWidth=Math.max(1,Math.round((canvas.clientWidth||640)*dpr)),rawHeight=Math.max(1,Math.round((canvas.clientHeight||480)*dpr));
    const resolutionScale=Math.min(1,2048/Math.max(rawWidth,rawHeight));
    const width=Math.max(1,Math.round(rawWidth*resolutionScale)),height=Math.max(1,Math.round(rawHeight*resolutionScale));
    if(canvas.width!==width)canvas.width=width;if(canvas.height!==height)canvas.height=height;
    const aspect=width/height,fov=Math.PI/4,minFov=Math.min(fov,2*Math.atan(Math.tan(fov/2)*aspect)),distance=1.15/Math.sin(minFov/2);
    const eye=[0,distance*.32,distance*Math.sqrt(1-.32*.32)],near=Math.max(.01,distance-1.5),far=distance+2;
    const projection=perspective(fov,aspect,near,far),view=lookAt(eye);
    return {matrix:multiply4(projection,view),width,height,public:{center:[...scene.center],radius:scene.radius,distance:distance*scene.radius,near:near*scene.radius,far:far*scene.radius,fovDegrees:45,aspect,eye:eye.map((v,i)=>scene.center[i]+v*scene.radius)}};
  }
  function draw() {
    if(!scene||!visible()||!program)return false;
    check(!gl.isContextLost(),'WebGL context is lost.','CONTEXT_LOST');
    const frame=camera(),turn=rotationY(state.yaw),viewProjection=multiply4(frame.matrix,turn);
    gl.viewport(0,0,frame.width,frame.height);gl.clearColor(.035,.055,.075,1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);gl.depthFunc(gl.LEQUAL);gl.disable(gl.CULL_FACE);gl.disable(gl.BLEND);gl.useProgram(program.program);
    gl.uniformMatrix4fv(program.viewProjection,false,new Float32Array(viewProjection));
    gl.uniformMatrix3fv(program.turnNormal,false,new Float32Array([turn[0],turn[1],turn[2],turn[4],turn[5],turn[6],turn[8],turn[9],turn[10]]));
    for(const item of scene.draws) {
      gl.bindVertexArray(item.vao);gl.uniform1f(program.points,item.mode===gl.POINTS?1:0);
      if(item.indexed)gl.drawElementsInstanced(item.mode,item.count,gl.UNSIGNED_INT,0,item.instances);
      else gl.drawArraysInstanced(item.mode,0,item.count,item.instances);
    }
    gl.bindVertexArray(null);check(gl.getError()===gl.NO_ERROR,'GPU draw failed.','GPU_DRAW_FAILED');
    state.frameCount++;state.sceneFrameCount++;state.cameraFramed=true;state.camera=frame.public;state.angle=state.yaw;
    state.status='displaying';return true;
  }
  function schedule(){if(raf===null && scene && visible() && state.rotating)raf=request(tick);}
  function tick(time) {
    raf=null;if(!visible()||!scene)return;
    if(lastTime!==null)state.yaw=(state.yaw+Math.min(.1,Math.max(0,(time-lastTime)/1000))*.35)%(Math.PI*2);
    lastTime=time;
    try{draw();notify();schedule();}catch(error){state.error=errorValue(error);state.status='error';stop();notify();}
  }
  function refresh(){if(!visible())return;try{draw();notify();schedule();}catch(error){state.error=errorValue(error);state.status='error';stop();notify();}}
  function visibility(){state.visible=!doc?.hidden;stop();if(!state.visible){if(scene)state.status='hidden';notify();}else refresh();}
  function loss(event) {
    event.preventDefault?.();contextLost=true;epoch++;stop();release(gl,scene);scene=null;
    if(program)gl.deleteProgram(program.program);program=null;
    state.status='error';state.contextLost=true;state.error={code:'CONTEXT_LOST',message:'WebGL context lost. Reload a managed asset after context restoration.'};
    state.loadedIdentity=null;state.metrics={...EMPTY};state.cameraFramed=false;state.camera=null;state.bounds=null;notify();
  }
  function restore(){
    if(disposed)return;
    try{program=compileProgram(gl);contextLost=false;state.contextLost=false;state.status='ready';state.error=null;notify();}
    catch(error){state.status='error';state.error=errorValue(error);notify();}
  }
  doc?.addEventListener?.('visibilitychange',visibility);canvas.addEventListener('webglcontextlost',loss);canvas.addEventListener('webglcontextrestored',restore);
  win.addEventListener?.('resize',refresh);
  const observer=typeof win.ResizeObserver==='function'?new win.ResizeObserver(refresh):null;observer?.observe(canvas);
  async function load(buffer,identity) {
    check(!disposed,'Viewer is disposed.','VIEWER_DISPOSED');check(!contextLost,'WebGL context is lost.','CONTEXT_LOST');
    const ownEpoch=++epoch;let candidate=null;
    try {
      validateIdentity(identity);
      const encoded=JSON.stringify(identity);check(encoded!==undefined&&encoded.length<=4096,'Loaded identity must be bounded JSON.','INVALID_IDENTITY');
      const loadedIdentity=JSON.parse(encoded),cpu=parseGlb(buffer);
      // Yield before allocation and before publication so overlapping loads have a clear latest winner.
      await Promise.resolve();check(ownEpoch===epoch&&!disposed,'A newer load superseded this asset.','STALE_LOAD');
      candidate=upload(gl,cpu);
      await Promise.resolve();check(ownEpoch===epoch&&!disposed&&!contextLost,'A newer load superseded this asset.','STALE_LOAD');
      const old=scene,previous=clone(state);scene=candidate;
      state.loadedIdentity=loadedIdentity;state.metrics={...candidate.metrics};state.bounds=clone(cpu.bounds);state.sceneFrameCount=0;state.yaw=0;state.angle=0;state.cameraFramed=false;state.camera=null;state.error=null;state.status=doc?.hidden?'hidden':'ready';
      try{draw();}catch(error){
        scene=old;Object.assign(state,previous);
        if(old&&visible()){try{draw();}catch{/* Preserve the original upload/draw error. */}}
        throw error;
      }
      candidate=null;release(gl,old);stop();notify();schedule();return getState();
    } catch(error) {
      release(gl,candidate);
      if(ownEpoch===epoch && !disposed && !contextLost) {state.error=errorValue(error);if(!scene)state.status='error';notify();}
      throw error;
    }
  }
  function setRotating(value) {
    check(typeof value==='boolean','Rotating must be boolean.','INVALID_OPTION');if(disposed)return;
    state.rotating=value;stop();refresh();
  }
  function dispose() {
    if(disposed)return;disposed=true;epoch++;stop();observer?.disconnect();
    doc?.removeEventListener?.('visibilitychange',visibility);canvas.removeEventListener('webglcontextlost',loss);canvas.removeEventListener('webglcontextrestored',restore);win.removeEventListener?.('resize',refresh);
    release(gl,scene);scene=null;if(program)gl.deleteProgram(program.program);program=null;
    state.status='disposed';state.loadedIdentity=null;state.metrics={...EMPTY};state.cameraFramed=false;state.camera=null;state.bounds=null;notify();
  }
  return {load,setRotating,getState,dispose};
}
