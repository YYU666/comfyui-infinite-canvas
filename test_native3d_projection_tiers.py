import unittest
from unittest.mock import patch
import numpy as np
from native3d_bake_projection import ExternalVisibleProjector


class TierTests(unittest.TestCase):
    def projector(self):
        vertices=[];faces=[]
        for i in range(70):
            offset=len(vertices);x=i*.001
            vertices.extend([[x,0,0],[x+.0001,0,0],[x,.0001,0]])
            faces.append([offset,offset+1,offset+2])
        def miss(rays):
            return {'t_hit':np.full(len(rays),np.inf),'primitive_ids':np.full(len(rays),2**32-1,np.uint32),
                    'primitive_normals':np.zeros((len(rays),3))}
        return ExternalVisibleProjector(np.asarray(vertices),np.asarray(faces),miss,1.,1e-5)

    def test_retry_only_missing_preserves_every_first_tier_field(self):
        p=self.projector();seen=[];accepted={}
        def tier(points,normals,scope,count):
            seen.append((count,points.copy()))
            result={'points':points.copy()+count,'valid':np.array([True,False]) if count==32 else np.array([True]),
                    'primitive_ids':np.arange(len(points))+count,'primitive_uvs':np.full((len(points),2),count,dtype=float)}
            if count==32:accepted.update({k:v[0].copy() for k,v in result.items()})
            return result
        points=np.array([[1.,2,3],[4,5,6]])
        with patch.object(p,'_project_tier',side_effect=tier):result=p.project(points,np.tile([0.,0,1],(2,1)),'center')
        self.assertEqual([entry[0] for entry in seen],[32,64])
        np.testing.assert_array_equal(seen[1][1],points[1:])
        for key,value in accepted.items():np.testing.assert_array_equal(result[key][0],value)
        self.assertTrue(result['valid'].all())
        self.assertEqual(p.report['scopes']['center']['queries'],2)
        self.assertEqual(p.report['scopes']['center']['accepted'],2)

    def test_unresolved_is_bounded_to_64_and_reported_per_tier(self):
        p=self.projector();tree=p.tree;seen=[]
        class Track:
            def query(self,points,k):seen.append(k);return tree.query(points,k=k)
        p.tree=Track()
        result=p.project([[.01,0,.001]],[[0,0,1]],'center')
        self.assertEqual(seen,[32,64]);self.assertFalse(result['valid'][0])
        self.assertEqual(p.report['tiers']['center']['32']['queries'],1)
        self.assertEqual(p.report['tiers']['center']['64']['queries'],1)
        self.assertEqual(p.report['scopes']['center']['remaining'],1)
        with self.assertRaisesRegex(ValueError,'32 or 64'):
            p._project_tier(np.zeros((1,3)),np.array([[0,0,1]]),'bad',128)

    def test_all_accepted_and_disabled_never_retry(self):
        p=self.projector()
        with patch.object(p,'_project_tier',return_value={'valid':np.array([True]),'points':np.zeros((1,3))}) as query:
            p.project([[0,0,0]],[[0,0,1]])
            self.assertEqual(query.call_count,1)
        p.enabled=False
        result=p.project([[0,0,0]],[[0,0,1]],'disabled')
        self.assertFalse(result['valid'][0]);self.assertNotIn('64',p.report['tiers']['disabled'])

    def test_ambiguity_gate_remains_active_in_second_tier(self):
        import open3d as o3d
        vertices=np.array([[.1,-1,-1],[.1,1,-1],[.1,1,1],[.1,-1,1],[-1,.1,-1],[-1,.1,1],[1,.1,1],[1,.1,-1]],float)
        faces=np.tile([[0,1,2],[0,2,3],[4,5,6],[4,6,7]],(18,1))
        scene=o3d.t.geometry.RaycastingScene();scene.add_triangles(o3d.core.Tensor(vertices.astype('f4')),o3d.core.Tensor(faces.astype('u4')))
        p=ExternalVisibleProjector(vertices,faces,lambda rays:{k:v.numpy() for k,v in scene.cast_rays(o3d.core.Tensor(rays)).items()},10.,1e-5)
        found=p.project([[0,0,0]],[[1,1,0]],'center')
        self.assertFalse(found['valid'][0])
        self.assertGreater(p.report['tiers']['center']['64']['ambiguousNearTies'],0)

    def test_certified_hit_still_cannot_bypass_invalid_source_frame(self):
        from native3d_source_material import filtered_source_normals
        class InvalidMaterial:
            faces=np.array([[0,1,2]])
            basis={'validFaces':np.array([False])}
            def world_normals(self,*args):raise AssertionError('Invalid source frame must never decode')
        def query(points,normals):
            return {'points':points,'valid':np.ones(len(points),bool),'primitive_ids':np.zeros(len(points),int),
                    'primitive_uvs':np.zeros((len(points),2))}
        _,valid,report=filtered_source_normals([[0,0]],np.array([[0.,0],[4,0],[0,4]]),
            np.array([[0.,0,0],[1,0,0],[0,1,0]]),[[0,1,2]],np.tile([0,0,1],(3,1)),.1,query,
            np.tile([0,0,1],(3,1)),source_material=InvalidMaterial())
        self.assertFalse(valid[0]);self.assertEqual(report['invalidSourceFrameTaps'],4)


if __name__=='__main__':unittest.main()
