"""Integration tests for the real Node MikkTSpace worker and glTF convention."""
import unittest
from unittest.mock import patch
import numpy as np
from native3d_bake_basis import build_bake_basis, encode_world_normals, interpolated_basis, unit


class MikkTSpaceTests(unittest.TestCase):
    def test_rotated_uv_seam_and_mirrored_orientation_cross_decoder(self):
        # Three disconnected corners coincide spatially, but the seam rotates
        # the tangent and the mirrored island reverses handedness.
        triangle=np.array([[0.,0,0],[1,0,0],[0,1,0]])
        vertices=np.tile(triangle,(3,1));faces=np.arange(9).reshape(3,3)
        uv=np.array([[0.,0],[1,0],[0,1], [1,0],[1,1],[0,0], [0,0],[-1,0],[0,1]])
        normals=np.tile([0.,0,1],(9,1));result=build_bake_basis(vertices,faces,uv,normals)
        np.testing.assert_array_equal(vertices[result['sourceVertex']][result['faces']],vertices[faces])
        np.testing.assert_array_equal(uv[result['sourceVertex']][result['faces']],uv[faces])
        expected=[([1,0,0],1),([0,-1,0],1),([-1,0,0],-1)]
        weights=np.array([[.2,.3,.5],[.8,.1,.1],[.01,.49,.5]])
        world=unit(np.array([[.3,.4,.8],[-.2,.4,1],[.8,-.2,.4]]))
        for face,(tangent,sign) in zip(result['faces'],expected):
            np.testing.assert_allclose(result['tangents'][face,:3],np.tile(tangent,(3,1)),atol=1e-6)
            np.testing.assert_array_equal(result['tangents'][face,3],sign)
            encoded=encode_world_normals(world,result['normals'][face],result['tangents'][face],weights)
            # Independent planar renderer frame: T, cross(N,T)*sign, N.
            renderer=np.stack([tangent,np.cross([0,0,1],tangent)*sign,[0,0,1]],axis=1)
            np.testing.assert_allclose(unit(encoded@renderer.T),world,atol=1e-7)
        self.assertIn('MikkTSpace',result['basisMethod'])

    def test_missing_node_is_explicit_failure(self):
        with patch('native3d_bake_basis.shutil.which',return_value=None):
            with self.assertRaisesRegex(RuntimeError,'Node.js.*not found'):
                build_bake_basis(np.array([[0.,0,0],[1,0,0],[0,1,0]]),np.array([[0,1,2]]),
                                 np.array([[0.,0],[1,0],[0,1]]),np.tile([0.,0,1],(3,1)))

    def test_degenerate_uv_fails_before_worker(self):
        with self.assertRaisesRegex(ValueError,'Degenerate UV'):
            build_bake_basis(np.array([[0.,0,0],[1,0,0],[0,1,0]]),np.array([[0,1,2]]),
                             np.zeros((3,2)),np.tile([0.,0,1],(3,1)))


if __name__=='__main__':unittest.main()
