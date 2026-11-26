"""Small analytic geometry regressions; never bakes a user asset."""
import unittest
import numpy as np
import open3d as o3d
from native3d_bake_projection import project_cage,ExternalVisibleProjector
from native3d_bake_normal import interpolate_high_normals,filtered_high_normals
from native3d_bake_ao import sample_high_surface_ao


def ray_scene(vertices,faces):
    scene=o3d.t.geometry.RaycastingScene()
    scene.add_triangles(o3d.core.Tensor(np.asarray(vertices,np.float32)),o3d.core.Tensor(np.asarray(faces,np.uint32)))
    return lambda rays:{k:v.numpy() for k,v in scene.cast_rays(o3d.core.Tensor(rays)).items()}


class ConcavitySafetyTests(unittest.TestCase):
    def test_real_thin_layer_backface_rejected_without_blind_next_hit(self):
        vertices=[]
        for z in [0.,.1]:vertices.extend([[-1,-1,z],[1,-1,z],[1,1,z],[-1,1,z]])
        faces=[[0,1,2],[0,2,3],[4,6,5],[4,7,6]]
        cast=ray_scene(vertices,faces)
        result=project_cage([[0.,0,0]],[[0.,0,2]],.2,cast)
        self.assertFalse(result['valid'][0]);self.assertTrue(result['backfaceRejectedMask'][0])
        self.assertTrue(np.isnan(result['points'][0]).all())
        # The bottom is occluded by the backfacing foreground sheet. Existing
        # certification also fails, so this sample remains a real miss.
        certified=ExternalVisibleProjector(vertices,faces,cast,10.,1e-5).project([[0.,0,0]],[[0.,0,1]])
        self.assertFalse(certified['valid'][0])

    def test_positive_grazing_and_missing_rays(self):
        def cast(_):return {'t_hit':np.array([.1,.1,np.inf]),'primitive_normals':np.array([[1.,0,1e-9],[1.,0,0],[0,0,0]])}
        result=project_cage([[0.,0,0]]*3,[[0.,0,1]]*3,.2,cast)
        np.testing.assert_array_equal(result['valid'],[True,False,False])
        np.testing.assert_array_equal(result['nonOutwardRejectedMask'],[False,True,False])

    def test_bad_shading_normals_use_own_geometry_only(self):
        for normal in [[0.,0,-1],[0.,0,0],[float('nan'),0,1]]:
            stats={}
            result=interpolate_high_normals([normal]*3,[[0,1,2]],[0],[[.2,.3]],[[0.,0,1]],stats)
            np.testing.assert_allclose(result,[[0,0,1]])
            self.assertEqual(sum(stats.values()),1)
        # Legal low-frame negative Z must survive when it points outward
        # relative to the actual high face, including a near-grazing carrier.
        source=np.array([1.,0,-.1]);source/=np.linalg.norm(source)
        result=interpolate_high_normals([source]*3,[[0,1,2]],[0],[[.2,.3]],[[1.,0,.1]],{})
        np.testing.assert_allclose(result,[source]);self.assertLess(result[0,2],0)

    def test_tangent_and_positive_grazing_shading_normals_are_preserved(self):
        for z in [0.,1e-14]:
            source=np.array([1.,0,z]);source/=np.linalg.norm(source)
            stats={};result=interpolate_high_normals([source]*3,[[0,1,2]],[0],[[.2,.3]],[[0.,0,1]],stats)
            np.testing.assert_allclose(result,[source],atol=1e-16);self.assertEqual(sum(stats.values()),0)

    def test_smooth_curve_normals_not_repaired(self):
        source=np.array([[0.,0,1],[.2,0,1],[0,.2,1]]);source/=np.linalg.norm(source,axis=1,keepdims=True)
        expected=.5*source[0]+.2*source[1]+.3*source[2];expected/=np.linalg.norm(expected)
        stats={};result=interpolate_high_normals(source,[[0,1,2]],[0],[[.2,.3]],[[0.,0,1]],stats)
        np.testing.assert_allclose(result,[expected]);self.assertEqual(sum(stats.values()),0)

    def test_geometry_hemisphere_prevents_shading_self_hit_on_plane(self):
        cast=ray_scene([[-10,-10,0],[10,-10,0],[10,10,0],[-10,10,0]],[[0,1,2],[0,2,3]])
        distance=lambda rays:cast(rays)['t_hit']
        args=([[0.,0,0]],[[np.sqrt(.75),0,-.5]],256,1.,1e-5,distance)
        legacy=sample_high_surface_ao(*args,attenuation='linear')
        physical=sample_high_surface_ao(*args,geometric_normals=[[0.,0,1]],attenuation='linear')
        # No-geometry compatibility retains its shading-normal origin/frame,
        # which puts the origin below this plane and still creates false AO.
        self.assertLess(legacy[0],.9);self.assertEqual(physical[0],1.)

    def test_deep_groove_still_casts_real_shadow_with_geometry_frame(self):
        floor=[[-5,-5,0],[5,-5,0],[5,5,0],[-5,5,0]]
        walls=[[-.25,-5,0],[-.25,5,0],[-.25,5,2],[-.25,-5,2],[.25,-5,0],[.25,5,0],[.25,5,2],[.25,-5,2]]
        cast=ray_scene(floor+walls,[[0,1,2],[0,2,3],[4,5,6],[4,6,7],[8,10,9],[8,11,10]])
        args=([[0.,0,0]],[[1.,0,0]],256,2.,1e-5,lambda rays:cast(rays)['t_hit'])
        shade=sample_high_surface_ao(*args,geometric_normals=[[0.,0,1]],attenuation='linear')
        self.assertGreater(shade[0],0.);self.assertLess(shade[0],.6)

    def test_opposing_taps_report_risk_without_voting_or_filling(self):
        tex=np.array([[0.,0],[4,0],[0,4]]);xyz=np.column_stack([tex,np.zeros(3)])
        normals=np.array([[1.,0,.01]]*3+[[-1.,0,.01]]*3)
        normals/=np.linalg.norm(normals,axis=1,keepdims=True)
        def query(points):
            return {'points':points,'valid':np.ones(len(points),bool),'primitive_ids':(points[:,0]>.5).astype(int),
                'primitive_uvs':np.tile([.2,.3],(len(points),1)),'primitive_normals':np.tile([0.,0,1],(len(points),1))}
        normal,valid,report=filtered_high_normals([[0,0]],tex,xyz,[[0,1,2],[3,4,5]],normals,.1,query)
        self.assertTrue(valid[0]);np.testing.assert_allclose(normal,[[0,0,1]],atol=1e-12)
        self.assertEqual(report['texelsWithStrongOpposingTaps'],1);self.assertGreater(report['strongOpposingTapPairs'],0)


if __name__=='__main__':unittest.main()
