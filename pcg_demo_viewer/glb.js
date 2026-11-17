/** Bounded in-memory decoder for the local PCG GLB subset; no resource loading. */
export const LIMITS = Object.freeze({
  glbBytes: 64 * 1024 * 1024, jsonBytes: 8 * 1024 * 1024,
  vertices: 360000, triangles: 100000, renderedTriangles: 2000000,
  instances: 10000, renderedPoints: 1000000, meshes: 64, primitives: 128,
  nodes: 10000, depth: 64,
});

export function fail(code, message) {
  const error = new Error(message); error.code = code; throw error;
}
function need(test, message, code = 'INVALID_GLB') { if (!test) fail(code, message); }
function object(value, allowed, required = []) {
  need(value !== null && typeof value === 'object' && !Array.isArray(value), 'Expected an object.');
  need(required.every(k => Object.hasOwn(value, k)), 'Missing required GLB property.');
  need(Object.keys(value).every(k => allowed.includes(k)), 'Unsupported GLB property or external resource.', 'UNSUPPORTED_GLB');
}
function list(value, maximum, message) {
  need(Array.isArray(value) && value.length <= maximum, message, 'BUDGET_EXCEEDED'); return value;
}
function integer(value, low, high) { need(Number.isInteger(value) && value >= low && value <= high, 'Invalid integer or index.'); return value; }
function finite(value, maximum = 1e6) { need(typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= maximum, 'Nonfinite or out-of-range number.'); return value; }
function vector(value, size) { need(Array.isArray(value) && value.length === size, 'Invalid vector shape.'); value.forEach(v => finite(v)); return value; }
function label(value) { need(typeof value === 'string' && value.length <= 256, 'Invalid name.'); }
export function identity4() { return new Float64Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]); }
export function multiply4(a, b) {
  const result = new Float64Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    for (let k = 0; k < 4; k++) result[c*4+r] += a[k*4+r] * b[c*4+k];
  }
  return result;
}
function trs(node) {
  if (Object.hasOwn(node, 'matrix')) {
    need(!['translation','rotation','scale'].some(k => Object.hasOwn(node,k)), 'Matrix and TRS cannot coexist.');
    const m = vector(node.matrix,16);
    need(m[3] === 0 && m[7] === 0 && m[11] === 0 && m[15] === 1, 'Node matrix must be affine.');
    return new Float64Array(m);
  }
  const t=vector(node.translation ?? [0,0,0],3), q=vector(node.rotation ?? [0,0,0,1],4), s=vector(node.scale ?? [1,1,1],3);
  need(s.every(v=>Math.abs(v)>=1e-8), 'Singular scale.');
  need(Math.abs(q.reduce((sum,v)=>sum+v*v,0)-1) < 1e-5, 'Rotation quaternion must be unit length.');
  const [x,y,z,w]=q, xx=x*x, yy=y*y, zz=z*z, xy=x*y, xz=x*z, yz=y*z, wx=w*x, wy=w*y, wz=w*z;
  return new Float64Array([
    (1-2*(yy+zz))*s[0], 2*(xy+wz)*s[0], 2*(xz-wy)*s[0], 0,
    2*(xy-wz)*s[1], (1-2*(xx+zz))*s[1], 2*(yz+wx)*s[1], 0,
    2*(xz+wy)*s[2], 2*(yz-wx)*s[2], (1-2*(xx+yy))*s[2], 0,
    t[0],t[1],t[2],1,
  ]);
}
export function normalMatrix(m) {
  const a=m[0], b=m[4], c=m[8], d=m[1], e=m[5], f=m[9], g=m[2], h=m[6], i=m[10];
  const det=a*(e*i-f*h)-b*(d*i-f*g)+c*(d*h-e*g);
  need(Number.isFinite(det) && Math.abs(det) >= 1e-24, 'Singular world transform.');
  const n = new Float64Array([
    (e*i-f*h)/det,(c*h-b*i)/det,(b*f-c*e)/det,
    (f*g-d*i)/det,(a*i-c*g)/det,(c*d-a*f)/det,
    (d*h-e*g)/det,(b*g-a*h)/det,(a*e-b*d)/det,
  ]);
  // Normal vectors are renormalized in the shader; common scale avoids overflow.
  const scale=Math.max(...n.map(Math.abs));
  need(Number.isFinite(scale) && scale > 0, 'Invalid normal transform.');
  return new Float32Array(n.map(v=>v/scale));
}
function transformed(m,p) { return [0,1,2].map(r=>m[r]*p[0]+m[4+r]*p[1]+m[8+r]*p[2]+m[12+r]); }
function corners(bounds) {
  const result=[];
  for (const x of [bounds.min[0],bounds.max[0]]) for (const y of [bounds.min[1],bounds.max[1]]) for (const z of [bounds.min[2],bounds.max[2]]) result.push([x,y,z]);
  return result;
}
function mergeBounds(target,point) {
  point.forEach((v,i)=>{ finite(v,1e12); target.min[i]=Math.min(target.min[i],v);target.max[i]=Math.max(target.max[i],v); });
}

export function parseGlb(buffer) {
  need(buffer instanceof ArrayBuffer, 'GLB must be an ArrayBuffer.');
  need(buffer.byteLength >= 20 && buffer.byteLength <= LIMITS.glbBytes, 'GLB byte budget exceeded.', 'BUDGET_EXCEEDED');
  const header=new DataView(buffer);
  need(header.getUint32(0,true)===0x46546c67 && header.getUint32(4,true)===2 && header.getUint32(8,true)===buffer.byteLength, 'Invalid GLB header.');
  let offset=12, json=null, binary=null, chunk=0;
  while (offset < buffer.byteLength) {
    need(offset+8<=buffer.byteLength,'Truncated GLB chunk.');
    const size=header.getUint32(offset,true),kind=header.getUint32(offset+4,true);offset+=8;
    need(size%4===0 && offset+size<=buffer.byteLength,'Invalid chunk size/alignment.');
    if (chunk===0 && kind===0x4e4f534a) {
      need(size<=LIMITS.jsonBytes,'GLB JSON budget exceeded.','BUDGET_EXCEEDED');
      try { json=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(new Uint8Array(buffer,offset,size))); }
      catch { fail('INVALID_GLB','Invalid UTF-8 JSON chunk.'); }
    } else if (chunk===1 && kind===0x004e4942) binary={offset,length:size};
    else fail('UNSUPPORTED_GLB','Unsupported or repeated GLB chunk.');
    chunk++;offset+=size;
  }
  need(json!==null,'JSON chunk is required.');
  object(json,['asset','scene','scenes','nodes','meshes','buffers','bufferViews','accessors','extras'],['asset','scenes']);
  object(json.asset,['version','generator','minVersion'],['version']);
  need(json.asset.version==='2.0' && (!json.asset.minVersion || json.asset.minVersion==='2.0'),'Unsupported glTF version.','UNSUPPORTED_GLB');
  if (json.asset.generator!==undefined) label(json.asset.generator);
  if (json.extras!==undefined) {
    object(json.extras,['unit','up','handedness']);
    need((json.extras.unit??'meter')==='meter' && (json.extras.up??'Y')==='Y' && (json.extras.handedness??'right')==='right','Unsupported coordinates.','UNSUPPORTED_GLB');
  }
  const accessors=list(json.accessors??[],512,'Too many accessors.');
  const views=list(json.bufferViews??[],512,'Too many buffer views.');
  const buffers=list(json.buffers??[],1,'Only one internal buffer is supported.');
  let bufferLength=0;
  if (buffers.length) {
    object(buffers[0],['byteLength'],['byteLength']);bufferLength=integer(buffers[0].byteLength,1,LIMITS.glbBytes);
    need(binary!==null && bufferLength<=binary.length && binary.length-bufferLength<=3,'Buffer does not match BIN chunk.');
  } else need(binary===null && !views.length && !accessors.length,'Unexpected BIN data or accessors.');
  for (const view of views) {
    object(view,['buffer','byteOffset','byteLength','target'],['buffer','byteLength']);
    need(view.buffer===0,'Only the internal buffer is supported.','UNSUPPORTED_GLB');
    integer(view.byteOffset??0,0,bufferLength);integer(view.byteLength,1,bufferLength);
    need((view.byteOffset??0)%4===0 && (view.byteOffset??0)+view.byteLength<=bufferLength,'View exceeds/alignment differs from buffer.');
    if (view.target!==undefined) need(view.target===34962 || view.target===34963,'Unsupported buffer target.');
  }
  let totalAccessorBytes=0;
  const parsedAccessors=accessors.map(a=>{
    object(a,['bufferView','byteOffset','componentType','count','type','min','max'],['bufferView','componentType','count','type']);
    integer(a.bufferView,0,views.length-1);const view=views[a.bufferView];
    need([5126,5125,5123].includes(a.componentType) && ['SCALAR','VEC2','VEC3'].includes(a.type),'Unsupported accessor representation.','UNSUPPORTED_GLB');
    const width={SCALAR:1,VEC2:2,VEC3:3}[a.type],bytes=a.componentType===5123?2:4;
    integer(a.count,1,360000);integer(a.byteOffset??0,0,view.byteLength);
    const length=a.count*width*bytes,start=(view.byteOffset??0)+(a.byteOffset??0);
    need(start%bytes===0 && (a.byteOffset??0)+length<=view.byteLength && start+length<=bufferLength,'Accessor exceeds buffer or is misaligned.');
    totalAccessorBytes+=length;
    need(totalAccessorBytes<=64*1024*1024,'Decoded accessor budget exceeded.','BUDGET_EXCEEDED');
    const data=a.componentType===5126?new Float32Array(a.count*width):new Uint32Array(a.count*width);
    const viewData=new DataView(buffer,binary.offset+start,length);
    for (let i=0;i<data.length;i++) {
      data[i]=a.componentType===5126?viewData.getFloat32(i*bytes,true):bytes===2?viewData.getUint16(i*bytes,true):viewData.getUint32(i*bytes,true);
      if (a.componentType===5126)finite(data[i]);
    }
    for (const name of ['min','max']) if (a[name]!==undefined)vector(a[name],width);
    if (a.min && a.max)need(a.min.every((v,i)=>v<=a.max[i]),'Invalid accessor bound order.');
    return {data,width,type:a.type,componentType:a.componentType,count:a.count};
  });
  function attribute(index,width,component=5126) {
    integer(index,0,parsedAccessors.length-1);const a=parsedAccessors[index];
    need(a.width===width && a.componentType===component,'Accessor type does not match its port.');return a;
  }
  let totalVertices=0,totalTriangles=0,totalPrimitives=0;
  const meshes=list(json.meshes??[],LIMITS.meshes,'Mesh budget exceeded.').map(m=>{
    object(m,['name','primitives'],['primitives']);if(m.name!==undefined)label(m.name);
    const primitives=list(m.primitives,LIMITS.primitives,'Primitive budget exceeded.').map(p=>{
      totalPrimitives++;need(totalPrimitives<=LIMITS.primitives,'Primitive budget exceeded.','BUDGET_EXCEEDED');
      object(p,['attributes','indices','mode'],['attributes']);object(p.attributes,['POSITION','NORMAL','TEXCOORD_0'],['POSITION']);
      const mode=p.mode??4;need(mode===0||mode===4,'Only triangle and point primitives are supported.','UNSUPPORTED_GLB');
      const position=attribute(p.attributes.POSITION,3);
      totalVertices+=position.count;need(totalVertices<=LIMITS.vertices,'Vertex budget exceeded.','BUDGET_EXCEEDED');
      let normals=null,uvs=null,indices=null;
      if(p.attributes.NORMAL!==undefined) {
        const normal=attribute(p.attributes.NORMAL,3);need(normal.count===position.count,'Normal count mismatch.');normals=normal.data;
        for(let i=0;i<normals.length;i+=3)need(Math.abs(Math.hypot(normals[i],normals[i+1],normals[i+2])-1)<1e-3,'Normal must be unit length.');
      }
      if(p.attributes.TEXCOORD_0!==undefined) {const uv=attribute(p.attributes.TEXCOORD_0,2);need(uv.count===position.count,'UV count mismatch.');uvs=uv.data;}
      if(p.indices!==undefined) {
        integer(p.indices,0,parsedAccessors.length-1);const index=parsedAccessors[p.indices];
        need(index.type==='SCALAR' && [5123,5125].includes(index.componentType),'Indices must be unsigned integers.');
        indices=index.data;for(const i of indices)need(i<position.count,'Triangle or point index exceeds positions.');
      }
      const count=indices?.length??position.count;
      need(mode!==4 || count%3===0,'Triangle index count is not divisible by three.');
      const triangles=mode===4?count/3:0;totalTriangles+=triangles;
      need(totalTriangles<=LIMITS.triangles,'Unique triangle budget exceeded.','BUDGET_EXCEEDED');
      if (mode===4) {
        if(!normals)normals=new Float32Array(position.data.length);
        for(let start=0;start<count;start+=3) {
          const ids=[0,1,2].map(k=>(indices?indices[start+k]:start+k)*3),a=position.data;
          const ab=[0,1,2].map(k=>a[ids[1]+k]-a[ids[0]+k]),ac=[0,1,2].map(k=>a[ids[2]+k]-a[ids[0]+k]);
          const n=[ab[1]*ac[2]-ab[2]*ac[1],ab[2]*ac[0]-ab[0]*ac[2],ab[0]*ac[1]-ab[1]*ac[0]];
          need(Math.hypot(...n)>1e-15,'Degenerate triangle.');
          if(p.attributes.NORMAL===undefined)for(const id of ids)for(let k=0;k<3;k++)normals[id+k]+=n[k];
        }
        if(p.attributes.NORMAL===undefined)for(let i=0;i<normals.length;i+=3) {
          const length=Math.hypot(normals[i],normals[i+1],normals[i+2]);
          if(length)for(let k=0;k<3;k++)normals[i+k]/=length;else normals[i+1]=1;
        }
      }
      const bounds={min:[Infinity,Infinity,Infinity],max:[-Infinity,-Infinity,-Infinity]};
      for(let i=0;i<position.data.length;i+=3)mergeBounds(bounds,[position.data[i],position.data[i+1],position.data[i+2]]);
      return {positions:position.data,normals,uvs,indices,mode,vertexCount:position.count,triangleCount:triangles,pointCount:mode===0?count:0,bounds};
    });
    need(primitives.length>0,'Mesh has no primitives.');return {primitives};
  });
  const nodes=list(json.nodes??[],LIMITS.nodes,'Node budget exceeded.');
  const parents=new Uint8Array(nodes.length),locals=[];
  for(const node of nodes) {
    object(node,['name','mesh','children','matrix','translation','rotation','scale']);if(node.name!==undefined)label(node.name);
    if(node.mesh!==undefined)integer(node.mesh,0,meshes.length-1);
    locals.push(trs(node));normalMatrix(locals.at(-1));
    const children=list(node.children??[],LIMITS.nodes,'Child node budget exceeded.');
    need(new Set(children).size===children.length,'Duplicate node child.');
    for(const child of children){integer(child,0,nodes.length-1);parents[child]++;need(parents[child]<=1,'Nodes cannot have multiple parents.');}
  }
  const marks=new Uint8Array(nodes.length);
  function checkTree(index,depth) {
    need(depth<=LIMITS.depth,'Scene nesting budget exceeded.','BUDGET_EXCEEDED');need(marks[index]!==1,'Cyclic node graph.');if(marks[index]===2)return;
    marks[index]=1;for(const child of nodes[index].children??[])checkTree(child,depth+1);marks[index]=2;
  }
  for(let i=0;i<nodes.length;i++)if(parents[i]===0)checkTree(i,0);
  for(let i=0;i<nodes.length;i++)if(marks[i]===0)checkTree(i,0);
  const scenes=list(json.scenes,64,'Scene budget exceeded.');need(scenes.length>0,'Scene is required.');
  for(const scene of scenes) {
    object(scene,['name','nodes']);if(scene.name!==undefined)label(scene.name);
    const roots=list(scene.nodes??[],LIMITS.nodes,'Scene root budget exceeded.');need(new Set(roots).size===roots.length,'Duplicate scene root.');
    for(const i of roots){integer(i,0,nodes.length-1);need(parents[i]===0,'Scene root has a parent.');}
  }
  const selected=integer(json.scene??0,0,scenes.length-1);
  const instances=[],used=new Set(),bounds={min:[Infinity,Infinity,Infinity],max:[-Infinity,-Infinity,-Infinity]};
  let renderedTriangles=0,renderedPoints=0;
  function visit(index,parent) {
    const node=nodes[index],world=multiply4(parent,locals[index]);for(const v of world)finite(v,1e12);
    if(node.mesh!==undefined) {
      need(instances.length<LIMITS.instances,'Instance budget exceeded.','BUDGET_EXCEEDED');used.add(node.mesh);
      const normal=normalMatrix(world);
      for(const p of meshes[node.mesh].primitives) {
        renderedTriangles+=p.triangleCount;renderedPoints+=p.pointCount;
        need(renderedTriangles<=LIMITS.renderedTriangles && renderedPoints<=LIMITS.renderedPoints,'Rendered geometry budget exceeded.','BUDGET_EXCEEDED');
        for(const corner of corners(p.bounds))mergeBounds(bounds,transformed(world,corner));
      }
      instances.push({mesh:node.mesh,name:node.name??`node:${index}`,worldMatrix:world,normalMatrix:normal});
    }
    for(const child of node.children??[])visit(child,world);
  }
  for(const root of scenes[selected].nodes??[])visit(root,identity4());
  if(!instances.length){bounds.min=[0,0,0];bounds.max=[0,0,0];}
  let gpuBytes=instances.length*100,visiblePrimitives=0,visibleVertices=0;
  for(const index of used)for(const p of meshes[index].primitives) {
    visiblePrimitives++;visibleVertices+=p.vertexCount;gpuBytes+=p.positions.byteLength+(p.normals?.byteLength??0)+(p.indices?.byteLength??0);
  }
  return {meshes,instances,bounds,metrics:{meshCount:used.size,instanceCount:instances.length,primitiveCount:visiblePrimitives,drawCalls:visiblePrimitives,triangleCount:renderedTriangles,pointCount:renderedPoints,vertexCount:visibleVertices,gpuBytes}};
}
