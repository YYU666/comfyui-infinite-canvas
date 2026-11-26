import unittest
import numpy as np
from native3d_high_analysis import hemisphere,screen_blocks

class HighAnalysisTests(unittest.TestCase):
 def test_cosine_directions_repeat_and_hemisphere(self):
  a=hemisphere(32);np.testing.assert_array_equal(a,hemisphere(32));np.testing.assert_allclose(np.linalg.norm(a,axis=1),1)
  self.assertTrue((a[:,2]>0).all())
 def test_screen_regions_split_normals_and_depth_without_mutation(self):
  normals=np.zeros((4,6,3));normals[:,:3,2]=1;normals[:,3:,0]=1
  points=np.zeros((4,6,3));points[:,:,0]=np.arange(6)*.001
  before=normals.copy();valid=np.ones((4,6),bool)
  labels,sizes=screen_blocks(normals,points,valid,1,angle=30,sigma=0)
  self.assertEqual(len(sizes),2);np.testing.assert_array_equal(normals,before)
  normals[:]=[0,0,1];points[:,3:,2]=1
  labels,sizes=screen_blocks(normals,points,valid,1,sigma=0)
  self.assertEqual(len(sizes),2)

if __name__=='__main__':unittest.main()
