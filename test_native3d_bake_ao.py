import unittest
import numpy as np
from native3d_bake_ao import cosine_hammersley,high_surface_frame,sample_high_surface_ao


class BakeAOTests(unittest.TestCase):
    def test_cosine_sequence_unit_hemisphere_and_distribution(self):
        directions=cosine_hammersley(1024)
        np.testing.assert_allclose(np.linalg.norm(directions,axis=1),1,atol=1e-12)
        self.assertGreater(directions[:,2].min(),0)
        self.assertLess(abs(directions[:,2].mean()-2/3),1e-4)
        self.assertLess(np.linalg.norm(directions[:,:2].mean(0)),.003)
        np.testing.assert_array_equal(directions,cosine_hammersley(1024))

    def test_high_normal_only_frame_and_identical_chart_samples(self):
        normals=np.array([[0.,0,1],[.2,-.7,.1],[0,0,-1]])
        n,t,b=high_surface_frame(normals)
        frame=np.stack([t,b,n],axis=-1)
        np.testing.assert_allclose(np.einsum('nji,njk->nik',frame,frame),np.tile(np.eye(3),(3,1,1)),atol=1e-12)
        np.testing.assert_allclose(np.linalg.det(frame),1,atol=1e-12)
        points=np.tile([1.,2,3],(2,1));high_n=np.tile([.2,.3,1.],(2,1));record=[]
        # The two points represent charts with arbitrarily rotated low T/B.
        # Neither low frame is an input; every emitted direction is identical.
        def cast(rays):record.append(rays.copy());return np.full(len(rays),np.inf)
        result=sample_high_surface_ao(points,high_n,64,1.,1e-5,cast)
        np.testing.assert_array_equal(result,[1,1])
        for rays in record:np.testing.assert_array_equal(rays[0],rays[1])

    def test_actual_cpu_rays_open_plane_and_occluding_groove(self):
        import open3d as o3d
        def scene_from(vertices,faces):
            scene=o3d.t.geometry.RaycastingScene()
            scene.add_triangles(o3d.core.Tensor(np.asarray(vertices,dtype=np.float32)),o3d.core.Tensor(np.asarray(faces,dtype=np.uint32)))
            return lambda rays:scene.cast_rays(o3d.core.Tensor(rays))['t_hit'].numpy()
        plane=[[-5,-5,0],[5,-5,0],[5,5,0],[-5,5,0]]
        faces=[[0,1,2],[0,2,3]]
        open_cast=scene_from(plane,faces)
        point=np.array([[0.,0,0]]);normal=np.array([[0.,0,1]])
        self.assertEqual(sample_high_surface_ao(point,normal,64,2.,1e-5,open_cast)[0],1.)
        # Two vertical walls around a floor point produce measurable finite-
        # radius occlusion without changing the surface normal or low mesh.
        vertices=plane+[[-.25,-5,0],[-.25,5,0],[-.25,5,2],[-.25,-5,2],[.25,-5,0],[.25,5,0],[.25,5,2],[.25,-5,2]]
        groove_cast=scene_from(vertices,faces+[[4,5,6],[4,6,7],[8,10,9],[8,11,10]])
        visibility=sample_high_surface_ao(point,normal,256,2.,1e-5,groove_cast)[0]
        self.assertGreater(visibility,0.);self.assertLess(visibility,.5)
        short=sample_high_surface_ao(point,normal,256,.1,1e-5,groove_cast)[0]
        self.assertEqual(short,1.,'occlusion must respect original finite radius')

    def test_invalid_and_empty_queries(self):
        result=sample_high_surface_ao(np.empty((0,3)),np.empty((0,3)),8,1.,1e-5,lambda _:self.fail('empty query must not raycast'))
        self.assertEqual(len(result),0)
        with self.assertRaises(ValueError):high_surface_frame([[0,0,0]])


if __name__=='__main__':unittest.main()
