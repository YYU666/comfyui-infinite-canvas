import assert from 'node:assert/strict';
import { nodeSummary } from './src/canvas-mcp.js';
const sourceHash='a'.repeat(64), highHash='b'.repeat(64), reportHash='c'.repeat(64);
const large=Array.from({length:10000},(_,i)=>({face:i,signedDots:[.9,.8,-.1,.7],vertices:[i,i+1,i+2]}));
const node={id:'result',type:'native3d',position:{x:1,y:2},data:{
 title:'真实诊断结果',operation:'analyze',status:'completed',sourceJobId:'n3d_source',assetPath:`assets/${sourceHash}.glb`,
 metadata:{operation:'repair_lod',sourceSha256:sourceHash,highSourceSha256:highHash,wallSeconds:42.5,
  source:{triangles:1767,vertices:925,bounds:large},unknownRaw:large,
  geometry:{status:'blocked',blocker:'局部贴合出现交叉；保留诊断',source_mesh_hash:sourceHash,selectedLod:800,
   stages:['raw_ai','repair','orientation','fit','lod_1200','lod_800','lod_500','lod_300'].map((stage,i)=>({stage,parent_mesh_hash:i?sourceHash:null,mesh_hash:highHash,receipt:{triangles:1767-i,records:large,collapses:large,components:[{flipped:true,faces:large,sample_signed_dots:large}],after:{triangles:1767-i,intersection_pairs:large}}}))}},
 quality:{status:'needs_review',triangles:1767,records:large},nativeParameters:{selectedLod:800,unbounded:large},
 nativeArtifacts:[{name:'evil',role:'report',assetPath:'../../private/report.json'},{name:'remote',role:'report',assetPath:'https://external/report.json'},{name:'report.json',role:'report',assetPath:`assets/${reportHash}.json`},{name:'raw_ai.glb',role:'export',assetPath:`assets/${sourceHash}.glb`,receipt:large}],
}};
const before=JSON.stringify(node);
const summary=nodeSummary(node);
const encoded=JSON.stringify(summary);
assert.ok(Buffer.byteLength(encoded)<16*1024);
assert.equal(summary.metadata.geometry.status,'blocked');
assert.equal(summary.metadata.geometry.blocker,node.data.metadata.geometry.blocker);
assert.equal(summary.metadata.operation,'repair_lod');
assert.equal(summary.operation,'analyze');
assert.equal(summary.metadata.sourceSha256,sourceHash);
assert.equal(summary.metadata.highSourceSha256,highHash);
assert.equal(summary.metadata.wallSeconds,42.5);
assert.equal(summary.metadata.geometry.source_mesh_hash,sourceHash);
assert.equal(summary.metadata.geometry.selectedLod,800);
assert.equal(summary.metadata.geometry.stageCount,8);
assert.equal(summary.metadata.geometry.stages.length,8);
assert.equal(summary.metadata.geometry.stages[0].parent_mesh_hash,null);
assert.equal(summary.metadata.geometry.stages[1].parent_mesh_hash,sourceHash);
assert.equal(summary.metadata.geometry.stages[1].mesh_hash,highHash);
assert.equal(summary.metadata.geometry.stages[1].receipt.records_count,10000);
assert.equal(summary.metadata.geometry.stages[1].receipt.component_count,1);
assert.equal(summary.metadata.geometry.stages[1].receipt.after.intersection_pairs_count,10000);
assert.equal(summary.nativeArtifacts[0].assetPath,`assets/${reportHash}.json`);
assert.equal(summary.nativeArtifacts.length,2);
for(const key of ['sample_signed_dots','signedDots','collapses":','records":','unknownRaw','bounds']) assert.equal(encoded.includes(key),false,key);
assert.equal(JSON.stringify(node),before);
assert.notEqual(summary.metadata,node.data.metadata);
assert.notEqual(summary.metadata.geometry.stages,node.data.metadata.geometry.stages);
const unicode=structuredClone(node);
unicode.data.metadata.geometry.stages=Array.from({length:100},()=>({stage:'复'.repeat(10000),mesh_hash:'哈'.repeat(10000),parent_mesh_hash:'父'.repeat(10000),filename:'文'.repeat(10000),receipt:{status:'状'.repeat(10000),mesh_hash:'希'.repeat(10000)}}));
const bounded=nodeSummary(unicode);
assert.ok(Buffer.byteLength(JSON.stringify(bounded))<16*1024);
assert.equal(bounded.metadata.geometry.stageCount,100);
assert.equal(bounded.metadata.geometry.stagesTruncated,true);
assert.equal(bounded.metadata.geometry.status,'blocked');
const image={id:'image',type:'media',data:{title:'素材',metadata:{large},prompt:'unchanged'}};
assert.equal(nodeSummary(image).prompt,'unchanged');
console.log(`NATIVE3D_SUMMARY_OK ${Buffer.byteLength(encoded)} bytes; bounded Unicode, provenance, blocked status, safe report links, immutable data`);
