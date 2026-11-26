import unittest
import tempfile
import json
from pathlib import Path
import numpy as np
import trimesh
from native3d_geometry import *

class GeometryTests(unittest.TestCase):
 def patch_fixture(self):
  m=trimesh.creation.box();removed=m.faces[0].copy();v=m.vertices.copy();f=m.faces[1:].copy()
  # Patch winding follows the removed original face; boundary is undirected identity.
  plan={'version':1,'sourceMeshHash':mesh_hash(v,f),'patches':[{'label':'Explicit fixture missing face','boundaryCycle':removed.tolist(),'faces':[removed.tolist()]}],'remainingBoundaryEdges':[]}
  return v,f,plan
 def test_reviewed_patch_exact_topology_and_hash(self):
  v,f,plan=self.patch_fixture();source=mesh_hash(v,f)
  vv,ff,r=apply_reviewed_repair_plan(v,f,json.dumps(plan),source)
  np.testing.assert_array_equal(vv,v);np.testing.assert_array_equal(ff[:len(f)],f)
  self.assertEqual(len(ff),12);self.assertEqual(r['after']['boundary_edges'],0)
  plan['sourceMeshHash']='f'*64
  with self.assertRaisesRegex(ValueError,'mismatch'):apply_reviewed_repair_plan(v,f,json.dumps(plan),source)
 def test_invalid_plan_preserves_raw_and_is_bounded(self):
  v,f,plan=self.patch_fixture();m=trimesh.Trimesh(v,f,process=False)
  with tempfile.TemporaryDirectory() as folder:
   _,meta,_=process(m,None,folder,{'reviewedRepairPlan':'unknown'})
   self.assertEqual(meta['status'],'blocked');self.assertTrue((Path(folder)/'raw_ai.glb').exists())
  with self.assertRaisesRegex(ValueError,'16KiB'):
   apply_reviewed_repair_plan(v,f,' '*16385,mesh_hash(v,f))
 def test_reviewed_patch_rejects_wrong_edges_faces_and_winding(self):
  v,f,plan=self.patch_fixture();source=mesh_hash(v,f)
  for mutation in ('cycle','faces','winding','remaining'):
   p=json.loads(json.dumps(plan))
   if mutation=='cycle':p['patches'][0]['boundaryCycle'][0]=7
   if mutation=='faces':p['patches'][0]['faces']=[[0,1,2],[0,2,3]]
   if mutation=='winding':p['patches'][0]['faces'][0].reverse()
   if mutation=='remaining':p['remainingBoundaryEdges']=[[0,1]]
   with self.assertRaises(ValueError):apply_reviewed_repair_plan(v,f,json.dumps(p),source)
 def test_reviewed_patch_rejects_new_crossing(self):
  v,f,plan=self.patch_fixture();t=v[np.asarray(plan['patches'][0]['faces'][0])];n=np.cross(t[1]-t[0],t[2]-t[0]);n/=np.linalg.norm(n);p=t.mean(0);axis=(t[1]-t[0]);axis/=np.linalg.norm(axis)
  extra=np.array([p+n*.1,p-n*.1,p+axis*.05]);index=len(v)
  v=np.vstack((v,extra));f=np.vstack((f,[index,index+1,index+2]));source=mesh_hash(v,f);plan['sourceMeshHash']=source
  plan['remainingBoundaryEdges']=[[index,index+1],[index+1,index+2],[index,index+2]]
  with self.assertRaisesRegex(GeometryBlocked,'intersection'):apply_reviewed_repair_plan(v,f,json.dumps(plan),source)
 def test_reviewed_boundary_motion_requires_permission(self):
  v=np.array([[0.,0,0],[1,0,0],[0,1,0]]);f=np.array([[0,1,2]])
  with self.assertRaisesRegex(GeometryBlocked,'reviewedBoundaryMeshHash'):
   constrained_fit(v,f,None,False,'reviewed_bounded')
  class Plane:
   def ray_cast(self,origin,direction,maximum):
    if abs(direction[2])<1e-12:return None,None,None,None
    distance=(.001-origin[2])/direction[2]
    if distance<0 or distance>maximum:return None,None,None,None
    return origin+direction*distance,np.array([0.,0,1]),0,distance
   def find_nearest(self,p):return np.array([p[0],p[1],.001]),np.array([0.,0,1]),0,abs(.001-p[2])
  fixed,_,_=constrained_fit(v,f,Plane(),True)
  moved,_,receipt=constrained_fit(v,f,Plane(),True,'reviewed_bounded')
  np.testing.assert_array_equal(fixed,v);self.assertGreater(receipt['accepted_moves'],0)
  self.assertLessEqual(np.linalg.norm(moved-v,axis=1).max(),.012*np.linalg.norm(np.ptp(v,axis=0)))
 def test_orientation_sign_is_distinct_from_fidelity(self):
  dots=np.array([[.9]*4,[.1]*4,[-.9]*4])
  r=orientation_evidence(dots,[75,24,1])
  self.assertFalse(r['ambiguous']);self.assertFalse(r['flipped'])
  inverse=orientation_evidence(-dots,[75,24,1])
  self.assertTrue(inverse['flipped']);self.assertFalse(inverse['ambiguous'])
 def test_orientation_rejects_strong_mixed_and_perpendicular(self):
  self.assertTrue(orientation_evidence(np.array([[.9]*4,[-.9]*4]),[90,10])['ambiguous'])
  self.assertTrue(orientation_evidence(np.full((3,4),.05),[1,1,1])['ambiguous'])
  self.assertTrue(orientation_evidence(np.array([[.9]*4,[.01]*4]),[49,51])['ambiguous'])
 def test_orientation_area_weights_prevent_tiny_face_votes(self):
  r=orientation_evidence(np.array([[.9]*4,[-.9]*4,[-.9]*4]),[100,1,1])
  self.assertFalse(r['ambiguous']);self.assertFalse(r['flipped'])
 def test_crossing_detected(self):
  v=np.array([[0,0,0],[1,0,0],[0,1,0],[.2,.2,-1],[.2,.2,1],[.8,.2,0]])
  r=diagnose(v,np.array([[0,1,2],[3,4,5]]));self.assertEqual(len(r['intersection_pairs']),1)
 def test_opening_not_guessed(self):
  m=trimesh.creation.box();f=m.faces[:-1];v,nf,r=repair_local(m.vertices,f)
  self.assertEqual(len(nf),len(f));self.assertEqual(r['automatic_hole_caps'],0)
  with self.assertRaises(GeometryBlocked):continuous_lod(v,nf,[6])
 def test_exact_t_split(self):
  v=np.array([[0.,0,0],[2,0,0],[1,0,0],[0,1,0],[0,0,1]])
  f=np.array([[0,1,3],[2,0,4],[1,2,4],[1,4,3],[0,3,4]])
  nf,log=split_t_junctions(v,f);self.assertEqual(len(log),1);self.assertEqual(len(nf),6)
 def test_continuous_lineage(self):
  m=trimesh.creation.icosphere(subdivisions=1);h=mesh_hash(m.vertices,m.faces)
  events=[];v,f,records=continuous_lod(m.vertices,m.faces,[60,40],callback=lambda *r:events.append(r))
  self.assertEqual(len(records),2);self.assertEqual(records[0]['parent_mesh_hash'],h)
  self.assertEqual(records[1]['parent_mesh_hash'],records[0]['mesh_hash']);self.assertEqual(len(events),2)
  self.assertFalse(diagnose(v,f)['intersection_pairs'])
 def test_nonmanifold_blocks(self):
  v=np.array([[0.,0,0],[1,0,0],[0,1,0],[0,-1,0],[0,0,1]])
  f=np.array([[0,1,2],[1,0,3],[0,1,4]])
  with self.assertRaises(GeometryBlocked):continuous_lod(v,f,[2],boundary_intent_reviewed=True)
 def test_boundary_fixed_fit(self):
  v=np.array([[0.,0,0],[1,0,0],[0,1,0]]);f=np.array([[0,1,2]])
  class NoQuery:
   def find_nearest(self,p):raise AssertionError('Boundary must not query')
  result,r=fit_vertices(v,f,NoQuery());np.testing.assert_array_equal(result,v)
  self.assertEqual(r['accepted_moves'],0)
 def test_budget_validation(self):
  m=trimesh.creation.box()
  with self.assertRaises(ValueError):continuous_lod(m.vertices,m.faces,[6,8])
 def test_oversize_preserves_raw_without_quadratic_audit(self):
  m=trimesh.creation.icosphere(subdivisions=5)
  with self.assertRaises(GeometryBlocked):diagnose(m.vertices,m.faces)
  with tempfile.TemporaryDirectory() as folder:
   _,meta,_=process(m,None,folder,{})
   self.assertEqual(meta['status'],'blocked');self.assertIn('10000',meta['blocker'])
   self.assertTrue((Path(folder)/'raw_ai.glb').is_file());self.assertLess((Path(folder)/'report.json').stat().st_size,4096)
 def test_adapter_preserves_blocked_diagnostics(self):
  m=trimesh.creation.box();m.faces=m.faces[:-1]
  with tempfile.TemporaryDirectory() as folder:
   selected,meta,artifacts=process(m,m,folder,{})
   self.assertEqual(meta['status'],'blocked');self.assertTrue((Path(folder)/'report.json').exists())
   self.assertTrue((Path(folder)/'repair.glb').exists());self.assertEqual(len(selected.faces),11)
   self.assertFalse((Path(folder)/'lod_800.glb').exists())
 def test_signed_reference_orientation(self):
  m=trimesh.creation.icosphere(subdivisions=0)
  scene=ReferenceScene(m.vertices,m.faces)
  v,f,receipt=orient_components(m.vertices,m.faces[:,[0,2,1]],scene)
  self.assertEqual(receipt['ambiguous_components'],0);self.assertTrue(receipt['components'][0]['flipped'])
  fitted,ff,r=constrained_fit(v,f,scene)
  self.assertEqual(r['accepted_moves'],0)
  self.assertEqual(r['boundary_vertex_drift_world'],{'samples':0})
if __name__=='__main__':unittest.main()
