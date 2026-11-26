import unittest
import numpy as np
from native3d_lod_boundary import OriginalBoundaryReference


def grid(n=4):
 v=np.array([[x/n,y/n,0.] for y in range(n+1) for x in range(n+1)])
 f=[]
 for y in range(n):
  for x in range(n):
   i=y*(n+1)+x;f.extend([[i,i+1,i+n+2],[i,i+n+2,i+n+1]])
 return v,np.array(f)

class BoundaryTests(unittest.TestCase):
 def test_collinear_resegmentation_and_certified_shape(self):
  v,f=grid();a,b=grid(1);r=OriginalBoundaryReference(v,f).compare(a,b)
  self.assertTrue(r['accepted']);self.assertEqual(r['loopCount'],1);self.assertEqual(r['candidateBoundaryEdges'],4)
  self.assertLess(r['loops'][0]['originalToCandidate']['certifiedMaxDistanceUpperBound'],r['loops'][0]['maximumDistanceBudget'])
 def test_small_drift_explicit_and_large_drift_rejected(self):
  v,f=grid();reference=OriginalBoundaryReference(v,f);r=reference.compare(v+[0,0,.001],f)
  self.assertGreater(r['loops'][0]['originalToCandidate']['sampledMaxDistance'],.00099)
  with self.assertRaisesRegex(ValueError,'shape budget'):reference.compare(v+[0,0,.02],f)
 def test_hole_creation_and_closure_rejected(self):
  v,f=grid();keep=np.ones(len(f),bool);keep[10:12]=False
  with self.assertRaisesRegex(ValueError,'Euler|loop'):OriginalBoundaryReference(v,f).compare(v,f[keep])
  with self.assertRaisesRegex(ValueError,'Euler|loop'):OriginalBoundaryReference(v,f[keep]).compare(v,f)
 def test_concentric_loops_survive_reindexing(self):
  v,f=grid(3);keep=np.ones(len(f),bool);keep[8:10]=False;f=f[keep]
  order=np.arange(len(v))[::-1];inverse=np.argsort(order)
  receipt=OriginalBoundaryReference(v,f).compare(v[order],inverse[f[::-1]])
  self.assertEqual(receipt['loopCount'],2)
  self.assertTrue(all(abs(x['perimeterRatio']-1)<1e-12 for x in receipt['loops']))
 def test_component_matching_is_bounded(self):
  v=np.concatenate([np.array([[0.,0,0],[1,0,0],[0,1,0]])+[3*i,0,0] for i in range(129)])
  f=np.arange(len(v)).reshape(-1,3)
  with self.assertRaisesRegex(ValueError,'128 connected'):OriginalBoundaryReference(v,f)
 def test_component_loss_rejected(self):
  v,f=grid();vv=np.vstack([v,v+[3,0,0]]);ff=np.vstack([f,f+len(v)])
  with self.assertRaisesRegex(ValueError,'component'):OriginalBoundaryReference(vv,ff).compare(v,f)
 def test_original_reference_prevents_cumulative_drift(self):
  v,f=grid();reference=OriginalBoundaryReference(v,f);reference.compare(v+[0,0,.004],f)
  with self.assertRaisesRegex(ValueError,'shape budget'):reference.compare(v+[0,0,.008],f)

if __name__=='__main__':unittest.main()
