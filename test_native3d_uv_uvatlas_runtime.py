import unittest
import numpy as np
from native3d_uv_uvatlas_runtime import unwrap_patch,runtime_status

class RuntimeTests(unittest.TestCase):
    @unittest.skipUnless(runtime_status()['ready'],'local UVAtlas runtime not built')
    def test_hard_seam_and_exact_mapping(self):
        v=np.array([[0,0,0],[1,0,0],[1,1,0],[0,1,0]],float)
        f=np.array([[0,1,2],[0,2,3]],np.int64)
        for cuts,charts in ((set(),1),({(0,2)},2)):
            uv,out,remap,part,receipt=unwrap_patch(v,f,cuts)
            np.testing.assert_array_equal(remap[out],f)
            np.testing.assert_array_equal(v[remap][out],v[f])
            np.testing.assert_array_equal(uv,uv.astype(np.float32).astype(float))
            self.assertEqual(receipt['charts'],charts)
            self.assertTrue(receipt['hardSeamsVerified'])
    def test_float32_collision_rejected(self):
        v=np.array([[1,0,0],[1+1e-9,0,0],[0,1,0]],float)
        with self.assertRaisesRegex(ValueError,'merges distinct'):unwrap_patch(v,np.array([[0,1,2]]),set())
    def test_missing_hard_edge_rejected(self):
        v=np.array([[0,0,0],[1,0,0],[1,1,0],[0,1,0]],float)
        with self.assertRaisesRegex(ValueError,'absent'):unwrap_patch(v,np.array([[0,1,2],[0,2,3]]),{(1,3)})

if __name__=='__main__':unittest.main()
