import assert from 'node:assert/strict';
import { checkGLBLayout, checkSavedGLBLayout } from './src/native3d-glb-layout.js';

function file(materialCount, counts) {
  const json = Buffer.from(JSON.stringify({
    materials: Array.from({length:materialCount}, () => ({})),
    meshes: counts.map(count => ({ primitives: Array.from({length:count}, () => ({})) })),
  }));
  const head = Buffer.alloc(20);
  head.write('glTF');
  head.writeUInt32LE(2,4);
  head.writeUInt32LE(20+json.length,8);
  head.writeUInt32LE(json.length,12);
  head.writeUInt32LE(0x4e4f534a,16);
  return new Blob([head,json]);
}
for (const [materials,counts] of [[3,[3]],[1,[2]],[3,[1,2]]]) {
  await assert.rejects(checkGLBLayout(file(materials,counts)), error => {
    assert.equal(error.code,'NATIVE3D_GLB_LAYOUT_UNSUPPORTED');
    assert.equal(error.details.materialCount,materials);
    assert.deepEqual(error.details.meshPrimitiveCounts,counts);
    assert.match(error.details.remediation,/UV 图集/);
    return true;
  });
}
await checkGLBLayout(file(1,[1]));
await checkGLBLayout(file(0,[1]));
await assert.rejects(checkGLBLayout(new Blob(['glTF'])), { code:'NATIVE3D_GLB_INVALID' });

for (const [materials,counts] of [[3,[3]],[1,[2]],[1,[1]]]) {
  const glb = file(materials,counts);
  const calls = [];
  const rangeRead = async (url, request) => {
    assert.equal(url,'/asset.glb');
    calls.push(request.headers.Range);
    const [,start,end] = /^bytes=([0-9]+)-([0-9]+)$/.exec(request.headers.Range);
    return new Response(glb.slice(Number(start),Number(end)+1),{status:206});
  };
  const check = checkSavedGLBLayout('/asset.glb','high',rangeRead);
  if (materials === 1 && counts[0] === 1) await check;
  else await assert.rejects(check,{details:{materialCount:materials,meshPrimitiveCounts:counts,
    remediation:'在 Blender 中将贴图烘焙到同一张 UV 图集，合并为一个材质槽，再导出为单对象、单 primitive 的 GLB。请另存副本。',inputRole:'high'}});
  assert.deepEqual(calls,['bytes=0-19',`bytes=20-${glb.size-1}`]);
}
