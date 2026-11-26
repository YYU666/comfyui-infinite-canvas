import copy,json,unittest
import numpy as np
import trimesh
from native3d_uv_evidence import read_high_guided_evidence
from native3d_uv_ao import high_guided_seams
from native3d_uv import unwrap,groups_from_edges
from test_native3d_uv_ao import cavity

def evidence(count):
 return dict(version=1,method='partfield_high_surface_ao',highSourceSha256='a'*64,targetSourceSha256='b'*64,faceOrderVerified=True,highFaceCount=1998143,queryCount=32768,queryCacheSha256='c'*64,queryLabelsSha256='d'*64,checkpointSha256='e'*64,raySamples=32,raysCast=1048576,labels=[0]*count,confidence=[.9]*count,darkness=[.8]*count)
class HighEvidenceTests(unittest.TestCase):
 def test_both_source_hashes_and_sampling_bounds_are_required(self):
  value=evidence(4);v,r=read_high_guided_evidence(json.dumps(value),'b'*64,'a'*64,4);self.assertEqual(r['supportedTargetFaces'],4)
  for patch in [{'highSourceSha256':'f'*64},{'targetSourceSha256':'f'*64},{'queryCount':100001},{'raysCast':1},{'faceOrderVerified':False},{'labels':[True]*4},{'confidence':[float('nan')]*4},{'supported':[1]*4},{'confidence':[.64]*4},{'extra':'bad'}]:
   with self.assertRaises(ValueError):read_high_guided_evidence(json.dumps({**value,**patch}),'b'*64,'a'*64,4)
 def test_unsupported_minus_one_never_nominates_a_boundary(self):
  m=cavity();value=evidence(4);value['labels'][0]=-1
  value['labels'][1]=-1
  reasons,r=high_guided_seams(m,{},value)
  self.assertEqual(r['neuralBoundaryEdges'],0);self.assertEqual(r['aoConcaveEdges'],0)
 def test_unknown_chain_cannot_bridge_distinct_supported_regions(self):
  m=cavity();labels=np.array([0,-1,-1,1]);groups=groups_from_edges(m,{},partition_labels=labels)
  self.assertGreater(len(groups),1)
  for g in groups:self.assertLessEqual(len(set(labels[g][labels[g]>=0])),1)
  np.testing.assert_array_equal(labels,[0,-1,-1,1])
 def test_darkness_alone_does_not_cut_convex_surface(self):
  m=trimesh.creation.box();reasons,r=high_guided_seams(m,{},evidence(len(m.faces)));self.assertEqual(reasons,{})
 def test_signed_concave_ao_and_report_bind_actual_geometry(self):
  m=cavity();value=evidence(4);reasons,r=high_guided_seams(m,{},value);self.assertEqual(r['aoConcaveEdges'],1)
  result,report=unwrap(m,{'seamStrategy':'coherent','packingMode':'legacy_fixed','orientationConfirmed':True},high_guided_evidence=read_high_guided_evidence(json.dumps(value),'b'*64,'a'*64,4)[0])
  self.assertEqual(report['aoGeometry']['referenceUsed'],True);self.assertEqual(report['aoGeometry']['faceDarkness'],value['darkness']);self.assertTrue(report['seamReasons'])
  src=np.asarray(result.metadata['uvSourceVertex']);face=np.asarray(result.metadata['uvSourceFace']);np.testing.assert_array_equal(result.vertices,m.vertices[src]);np.testing.assert_array_equal(src[result.faces],m.faces[face])
 def test_reject_high_evidence_ignored_by_other_strategy(self):
  with self.assertRaises(ValueError):unwrap(cavity(),{'seamStrategy':'structural'},high_guided_evidence=evidence(4))
if __name__=='__main__':unittest.main()
