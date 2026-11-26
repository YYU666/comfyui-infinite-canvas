import unittest
import numpy as np
from native3d_bake_projection import project_cage,ExternalVisibleProjector


class ProjectionTests(unittest.TestCase):
    def visible_scene(self):
        import open3d as o3d
        vertices=[]
        for z in [0.,.1]:vertices.extend([[-1,-1,z],[1,-1,z],[1,1,z],[-1,1,z]])
        vertices=np.array(vertices,dtype=float);faces=np.array([[0,1,2],[0,2,3],[4,5,6],[4,6,7]])
        scene=o3d.t.geometry.RaycastingScene()
        scene.add_triangles(o3d.core.Tensor(vertices.astype(np.float32)),o3d.core.Tensor(faces.astype(np.uint32)))
        cast=lambda rays:{k:v.numpy() for k,v in scene.cast_rays(o3d.core.Tensor(rays)).items()}
        return vertices,faces,cast

    def test_visible_rejects_nearest_internal_layer_and_certifies_external(self):
        vertices,faces,cast=self.visible_scene();saved_vertices=vertices.copy();saved_faces=faces.copy()
        projector=ExternalVisibleProjector(vertices,faces,cast,10.,1e-5)
        point=np.array([[.1,.2,-.01]])
        result=projector.project(point,[[0,0,1]],'center')
        self.assertTrue(result['valid'][0]);self.assertIn(result['primitive_ids'][0],[2,3])
        np.testing.assert_allclose(result['points'][0],[.1,.2,.1],atol=1e-5)
        # Candidate certification and its spatial index cannot change source
        # topology/positions; UVs are never input to or rewritten by this step.
        np.testing.assert_array_equal(vertices,saved_vertices);np.testing.assert_array_equal(faces,saved_faces)

    def test_visible_cap_backface_and_empty_neighborhood_remain_misses(self):
        vertices,faces,cast=self.visible_scene();projector=ExternalVisibleProjector(vertices,faces,cast,10.,1e-5)
        points=np.array([[0.,0,-1],[0,0,-.01],[100,100,0]])
        result=projector.project(points,[[0,0,1],[0,0,-1],[0,0,1]])
        self.assertFalse(result['valid'].any());self.assertTrue(np.isnan(result['points']).all())

    def test_visible_queries_are_chunked_and_large_faces_supplemented(self):
        vertices,faces,cast=self.visible_scene();projector=ExternalVisibleProjector(vertices,faces,cast,10.,1e-5,chunk_size=2)
        self.assertGreater(projector.report['largeFaces'],0)
        result=projector.project(np.tile([.1,.2,-.01],(5,1)),np.tile([0,0,1],(5,1)))
        self.assertTrue(result['valid'].all());self.assertEqual(projector.report['queryChunkLimit'],2)

    def test_certified_normal_taps_may_exceed_primary_cage(self):
        from native3d_bake_normal import filtered_high_normals
        vertices,faces,cast=self.visible_scene();projector=ExternalVisibleProjector(vertices,faces,cast,10.,1e-5)
        tex=np.array([[0.,0],[4,0],[0,4]])
        xyz=np.array([[-.5,-.5,-.15],[.5,-.5,-.15],[-.5,.5,-.15]])
        # The visible outer sheet is .25 away: outside primary .2 but inside
        # certified cap .4. Its validated taps must not be re-rejected at .2.
        normal,valid,report=filtered_high_normals([[0,0]],tex,xyz,faces,
            np.tile([0.,0,1],(len(vertices),1)),.2,projector.project,[[0.,0,1]]*3)
        self.assertTrue(valid.all());np.testing.assert_allclose(normal,[[0,0,1]])
        self.assertEqual(report['validTaps'],4)

    def test_equal_distance_unrelated_visible_sheets_are_ambiguous(self):
        import open3d as o3d
        vertices=np.array([[.1,-1,-1],[.1,1,-1],[.1,1,1],[.1,-1,1],
                           [-1,.1,-1],[-1,.1,1],[1,.1,1],[1,.1,-1]],float)
        faces=np.array([[0,1,2],[0,2,3],[4,5,6],[4,6,7]])
        scene=o3d.t.geometry.RaycastingScene()
        scene.add_triangles(o3d.core.Tensor(vertices.astype(np.float32)),o3d.core.Tensor(faces.astype(np.uint32)))
        cast=lambda rays:{k:v.numpy() for k,v in scene.cast_rays(o3d.core.Tensor(rays)).items()}
        projector=ExternalVisibleProjector(vertices,faces,cast,10.,1e-5)
        result=projector.project([[0.,0,0]],[[1.,1,0]],'center')
        self.assertFalse(result['valid'][0])
        self.assertEqual(projector.report['scopes']['center']['ambiguousNearTies'],1)

    def test_equal_distance_sharp_faces_in_one_oriented_fan_are_valid(self):
        import open3d as o3d
        vertices=np.array([[.1,-1,-1],[.1,.1,-1],[.1,.1,1],[.1,-1,1],[-1,.1,-1],[-1,.1,1]],float)
        faces=np.array([[0,1,2],[0,2,3],[4,5,2],[4,2,1]])
        scene=o3d.t.geometry.RaycastingScene()
        scene.add_triangles(o3d.core.Tensor(vertices.astype(np.float32)),o3d.core.Tensor(faces.astype(np.uint32)))
        cast=lambda rays:{k:v.numpy() for k,v in scene.cast_rays(o3d.core.Tensor(rays)).items()}
        projector=ExternalVisibleProjector(vertices,faces,cast,10.,1e-5)
        result=projector.project([[0.,0,0]],[[1.,1,0]],'center')
        self.assertTrue(result['valid'][0]);self.assertEqual(projector.report['scopes']['center']['topologyResolvedNearTies'],1)
        self.assertAlmostEqual(np.linalg.norm(result['points'][0]),.1,places=5)

    def test_vertex_touch_without_edge_connected_fan_is_not_continuity(self):
        vertices=np.array([[0,0,0],[1,0,0],[0,1,0],[-1,0,0],[0,0,1]],float)
        faces=np.array([[0,1,2],[0,3,4]])
        projector=ExternalVisibleProjector(vertices,faces,lambda _:None,10.,1e-5)
        self.assertFalse(projector._same_oriented_fan(0,1))

    def test_outer_sheet_instead_of_nearest_internal_sheet(self):
        import open3d as o3d
        # Low surface is nearer an internal sheet. The cage must hit
        # the outer sheet first, consistently from either side of its seam.
        vertices=[]
        for z in [-.01,.15]:vertices.extend([[-2,-2,z],[2,-2,z],[2,2,z],[-2,2,z]])
        scene=o3d.t.geometry.RaycastingScene()
        scene.add_triangles(o3d.core.Tensor(np.array(vertices,np.float32)),o3d.core.Tensor(np.array([[0,1,2],[0,2,3],[4,5,6],[4,6,7]],np.uint32)))
        points=np.array([[-.1,.1,0],[.1,-.1,0]])
        nearest=scene.compute_closest_points(o3d.core.Tensor(points.astype(np.float32)))['points'].numpy()
        np.testing.assert_allclose(nearest[:,2],-.01,atol=1e-6)
        found=project_cage(points,[[0,0,3]]*2,.2,lambda rays:{k:v.numpy() for k,v in scene.cast_rays(o3d.core.Tensor(rays)).items()})
        self.assertTrue(found['valid'].all());np.testing.assert_allclose(found['points'][:,2],.15,atol=1e-6)

    def test_filtered_normals_use_the_same_outer_surface(self):
        from native3d_bake_normal import filtered_high_normals
        tex=np.array([[0.,0],[4,0],[0,4]])
        xyz=np.column_stack([tex,np.zeros(3)])
        def query(points,normals):
            # First hit is the outer face (id1); the internal face id0 has a
            # sharply different normal and must never contribute to the map.
            def cast(rays):
                return {'t_hit':np.full(len(rays),.05),
                        'primitive_normals':np.tile([0.,0,1],(len(rays),1)),
                        'primitive_ids':np.ones(len(rays),dtype=int),
                        'primitive_uvs':np.tile([.2,.3],(len(rays),1))}
            return project_cage(points,normals,.2,cast)
        result,valid,report=filtered_high_normals([[0,0]],tex,xyz,
            [[0,1,2],[3,4,5]],[[1.,0,0]]*3+[[0.,0,1]]*3,.2,query,[[0.,0,1]]*3)
        np.testing.assert_allclose(result,[[0,0,1]]);self.assertTrue(valid.all())
        self.assertEqual(report['validTaps'],4)

    def test_finite_segment_no_nearest_fallback(self):
        def cast(rays):return {'t_hit':np.array([np.inf,.41,.2]),'primitive_ids':np.array([2**32-1,0,0]),'primitive_normals':np.tile([0.,0,1],(3,1))}
        found=project_cage(np.zeros((3,3)),[[0,0,1]]*3,.2,cast)
        np.testing.assert_array_equal(found['valid'],[False,False,True])
        self.assertTrue(np.isnan(found['points'][:2]).all());np.testing.assert_allclose(found['points'][2],0,atol=1e-8)


if __name__=='__main__':unittest.main()
