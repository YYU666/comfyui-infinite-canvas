async function checkLayout(read, length, inputRole) {
  const invalid = () => Object.assign(new Error('GLB 头部或 JSON 块无效，请重新导出 GLB 2.0。'),
    {code:'NATIVE3D_GLB_INVALID',details:{inputRole}});
  const header = await read(0,20);
  if (header.byteLength !== 20) throw invalid();
  const view = new DataView(header);
  const size = view.getUint32(12,true);
  if (view.getUint32(0,true) !== 0x46546c67 || view.getUint32(4,true) !== 2
      || view.getUint32(16,true) !== 0x4e4f534a || size > 32*1024**2
      || size > view.getUint32(8,true)-20 || size > length-20) throw invalid();
  let materialCount, meshPrimitiveCounts;
  try {
    const document = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await read(20,20+size)));
    materialCount = (document.materials ?? []).length;
    meshPrimitiveCounts = (document.meshes ?? []).map(mesh => (mesh.primitives ?? []).length);
  } catch { throw invalid(); }
  if (materialCount > 1 || meshPrimitiveCounts.some(count => count !== 1)) {
    const remediation = '在 Blender 中将贴图烘焙到同一张 UV 图集，合并为一个材质槽，再导出为单对象、单 primitive 的 GLB。请另存副本。';
    let summary = meshPrimitiveCounts.slice(0,12).map((count,i) => `Mesh ${i}: ${count}`).join('、');
    if (meshPrimitiveCounts.length > 12) summary += `（共 ${meshPrimitiveCounts.length} 个 mesh）`;
    throw Object.assign(new Error(`此 GLB 有 ${materialCount} 个材质；primitive 数：${summary}。${remediation}`),
      {code:'NATIVE3D_GLB_LAYOUT_UNSUPPORTED',details:{materialCount,meshPrimitiveCounts,remediation,inputRole}});
  }
}

export function checkGLBLayout(file) {
  return checkLayout((start,end) => file.slice(start,end).arrayBuffer(),file.size,'model');
}

export function checkSavedGLBLayout(url, inputRole, fetchFile = fetch) {
  return checkLayout(async (start,end) => {
    const response = await fetchFile(url,{headers:{Range:`bytes=${start}-${end-1}`},redirect:'error'});
    if (response.status !== 206) {
      await response.body?.cancel();
      throw Error('无法读取已保存 GLB 的头部，请检查项目素材或重新导入。');
    }
    const data = await response.arrayBuffer();
    if (data.byteLength !== end-start) throw Error('已保存 GLB 的头部读取不完整。');
    return data;
  },Infinity,inputRole);
}
