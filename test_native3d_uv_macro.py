import unittest
import numpy as np
import trimesh
import types
import tempfile
from unittest.mock import patch
from native3d_uv_macro_plan import macro_groups
from native3d_uv_macro import _fold_split
from native3d_uv_pack import pack_natural_charts

class MacroTests(unittest.TestCase):
    def setUp(self):
        self.cache=tempfile.TemporaryDirectory()
        self.env=patch.dict('os.environ',{'NATIVE3D_UVATLAS_GROUP_CACHE':self.cache.name});self.env.start()
    def tearDown(self):
        self.env.stop();self.cache.cleanup()
    def test_micro_region_merges_but_ai_boundary_survives(self):
        mesh=trimesh.Trimesh([[0,0,0],[1,0,0],[0,1,0],[1,1,0]],[[0,1,2],[1,3,2]],process=False)
        groups=[np.array([0]),np.array([1])];edge=(1,2)
        hard,merged,report=macro_groups(mesh,[np.arange(2)],groups,{edge:'concave_structural'},.6)
        self.assertEqual(len(merged),1);self.assertFalse(hard)
        self.assertEqual(report['softEdges'][0]['vertices'],[1,2])
        hard,merged,_=macro_groups(mesh,groups,groups,{edge:'high_surface_region_boundary'},.6)
        self.assertEqual(len(merged),2);self.assertEqual(hard[edge],'high_surface_region_boundary')

    def test_fold_patch_never_isolates_small_triangle(self):
        mesh=trimesh.creation.icosphere(subdivisions=0)
        with self.assertRaises(ValueError):_fold_split(mesh,np.arange(8),[(0,1)])

    def test_pack_only_preserves_shape_density_and_direction(self):
        v=np.array([[0,0,0],[1,0,0],[0,1,0],[2,0,0],[3,0,0],[2,1,0]],float)
        mesh=trimesh.Trimesh(v,[[0,1,2],[3,4,5]],process=False)
        local=np.array([[0,0],[1,0],[0,1]],float)
        charts=[(np.arange(3),local,np.ones(2)),(np.arange(3,6),local,np.ones(2))]
        uv,receipt=pack_natural_charts(mesh,charts,4096,16)
        np.testing.assert_allclose(uv[1:3]-uv[0],uv[4:6]-uv[3],atol=1e-12)
        self.assertGreater(uv[1,0],uv[0,0]);self.assertAlmostEqual(uv[1,1],uv[0,1])
        self.assertLess(receipt['chartScaleRatio'],1.0001)

    def test_uvatlas_mapping_and_hard_seam_are_checked_independently(self):
        from native3d_uv_uvatlas import parameterize_groups
        mesh=trimesh.Trimesh([[0,0,0],[1,0,0],[0,1,0],[1,1,0]],[[0,1,2],[1,3,2]],process=False)
        def uncut(v,f,hard_edges,cache_directory=None):
            return v[:,:2],f,np.arange(4),np.zeros(2,int),{}
        module=types.SimpleNamespace(unwrap_patch=uncut)
        with patch.dict('sys.modules',{'native3d_uv_uvatlas_runtime':module}):
            with self.assertRaisesRegex(ValueError,'preserve hard seams'):
                parameterize_groups(mesh,[np.arange(2)],{(1,2):'manual_locked'})
        def cut(v,f,hard_edges,cache_directory=None):
            self.assertIn((1,2),hard_edges)
            source=np.array([0,1,2,1,3,2]);uv=v[source,:2].copy();uv[3:,0]+=2
            return uv,np.arange(6).reshape(2,3),source,np.arange(2),{}
        module=types.SimpleNamespace(unwrap_patch=cut)
        with patch.dict('sys.modules',{'native3d_uv_uvatlas_runtime':module}):
            result,uv,source,face,receipt=parameterize_groups(mesh,[np.arange(2)],{(1,2):'manual_locked'})
        np.testing.assert_array_equal(result.vertices,mesh.vertices[source])
        np.testing.assert_array_equal(source[result.faces],mesh.faces[face])
        self.assertEqual(receipt['missingHardConstraintEdges'],0)

if __name__=='__main__':unittest.main()
