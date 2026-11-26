import assert from 'node:assert/strict';
import {planEdgeLayers,planEdgeLayerVisible} from './src/native3d-plan.js';

// The table is deliberately reordered: binary IDs have no frontend meaning.
const names=['manual_locked','concave_structural','high_surface_region_boundary','future_reason','convex_structural','ao_supported_signed_concave','high_surface_uncertain_group_guard'];
const edges=new Uint32Array([0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8]);
const data={edges,edgeReason:new Uint8Array([2,4,1,5,0,6,3,200])};
const result=planEdgeLayers(data,names);
assert.equal(result.categorized,true);
const visible=mode=>result.layers.filter(layer=>planEdgeLayerVisible(layer.key,mode)).flatMap(layer=>[...layer.edges]);
assert.deepEqual(visible('regions'),[0,1]);
assert.deepEqual(visible('convex'),[0,1,1,2]);
assert.deepEqual(visible('details'),[0,1,1,2,2,3,3,4]);
assert.deepEqual(visible('seams'),[0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8]);
assert.deepEqual(visible('ao'),[]);assert.deepEqual(visible('grey'),[]);assert.deepEqual(visible('high'),[]);
assert.equal(result.layers.find(layer=>layer.key==='unknown').count,2,'unknown table names and IDs never masquerade as AI/structure');
assert.equal(result.layers.find(layer=>layer.key==='auxiliary').count,2);
assert.deepEqual([...edges],[0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8],'source edge topology is unchanged');

// Existing plans may have the original five-name table, or no reason metadata.
const oldTable=['high_surface_region_boundary','ao_supported_signed_concave','high_surface_uncertain_group_guard','coherent_constrained_group_boundary','manual_locked'];
const old=planEdgeLayers({edges:new Uint32Array([0,1,1,2]),edgeReason:new Uint8Array([0,1])},oldTable);
assert.equal(old.layers.find(layer=>layer.key==='ai').count,1);
assert.equal(old.layers.find(layer=>layer.key==='ao').count,1);
for(const oldData of [{edges},{edges,edgeReason:data.edgeReason}]){
 const legacy=planEdgeLayers(oldData,undefined);assert.equal(legacy.categorized,false);
 const layer=legacy.layers.find(layer=>layer.key==='legacy');assert.deepEqual([...layer.edges],[...edges]);
 assert.equal(planEdgeLayerVisible(layer.key,'regions'),true);assert.equal(planEdgeLayerVisible(layer.key,'seams'),true);
 assert.equal(planEdgeLayerVisible(layer.key,'convex'),false);assert.equal(planEdgeLayerVisible(layer.key,'details'),false);
}
console.log('NATIVE3D_PLAN_EDGES_OK dynamic reason table, exact progressive overlays, auxiliary/unknown isolation, legacy plans, unchanged source edges');
