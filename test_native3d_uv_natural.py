import unittest
import numpy as np
import igl,trimesh
from test_native3d_uv_slim import grid
from native3d_uv_natural import connected_constraint_cuts
from native3d_uv_slim import _cut,_components,_boundary

class ConstraintNetworkTests(unittest.TestCase):
    def cuts(self,n,edges):
        mesh=grid(n);source=np.arange(len(mesh.vertices));reasons={e:'manual_locked' for e in edges}
        cuts=connected_constraint_cuts(mesh.vertices,mesh.faces,source,reasons)
        self.assertTrue(set(edges)<=cuts)
        v,f,s=_cut(igl,mesh.vertices,mesh.faces,source,cuts)
        np.testing.assert_array_equal(v,mesh.vertices[s]);np.testing.assert_array_equal(s[f],mesh.faces)
        return mesh,cuts,v,f,s
    def test_boundary_attached_branch_has_no_spokes(self):
        edges={(1,8),(8,15),(15,22),(22,23),(22,29)}
        _,cuts,_,_,_=self.cuts(7,edges);self.assertEqual(cuts,edges)
    def test_internal_long_chain_adds_one_shortest_connection(self):
        edges={(15,16),(16,17),(17,18)}
        _,cuts,_,_,_=self.cuts(7,edges)
        self.assertEqual(len(cuts-edges),1)
    def test_closed_constraint_loop_is_preserved(self):
        edges={(16,17),(17,24),(23,24),(16,23)}
        mesh,cuts,v,f,s=self.cuts(7,edges)
        parts=_components(v,f,s,np.arange(len(f)))
        self.assertEqual(len(parts),2)
        for _,ff,_,_ in parts:
            ee,_,loops=_boundary(ff);self.assertEqual(len(loops),1)
    def test_disconnected_networks_each_reach_boundary(self):
        edges={(15,16),(32,33)}
        _,cuts,_,_,_=self.cuts(7,edges)
        self.assertLessEqual(len(cuts-edges),2)

if __name__=='__main__':unittest.main()
