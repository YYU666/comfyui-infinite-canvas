import unittest
import numpy as np
from native3d_bake_basis import unit
from native3d_bake_normal import interpolate_high_normals,filtered_high_normals


class BakeNormalTests(unittest.TestCase):
    def test_thin_face_center_sampling_requires_zero_inside_taps(self):
        tex=np.array([[0.,.48],[1.,.48],[.5,.52]])
        xyz=np.column_stack([tex,np.zeros(3)])
        def no_query(*_):self.fail('all2x2 taps are outside thin face')
        result,valid,report=filtered_high_normals([[0,0]],tex,xyz,[[0,1,2]],[[0.,0,1]]*3,.1,no_query,
            center_normals=[[0.,0,1]],center_valid=[True])
        self.assertTrue(valid[0]);np.testing.assert_allclose(result,[[0,0,1]])
        self.assertEqual(report['centerOnlySubpixelTexels'],1)
        # A failed inside-face tap must stay a miss even with a valid center.
        tex=np.array([[0.,0],[4,0],[0,4]]);xyz=np.column_stack([tex,np.zeros(3)])
        def miss(points):return {'points':np.full_like(points,np.nan),'valid':np.zeros(len(points),bool)}
        _,valid,report=filtered_high_normals([[0,0]],tex,xyz,[[0,1,2]],[[0.,0,1]]*3,.1,miss,
            center_normals=[[0.,0,1]],center_valid=[True])
        self.assertFalse(valid[0]);self.assertEqual(report['centerOnlySubpixelTexels'],0)

    def test_smooth_sphere_interpolation_and_hard_source_normal_split(self):
        vertices=unit(np.array([[0.,0,1],[.3,0,1],[0,.3,1]]))
        weights=np.array([[.2,.3,.5],[.7,.1,.2]])
        result=interpolate_high_normals(vertices,[[0,1,2]],[0,0],weights[:,1:])
        np.testing.assert_allclose(result,unit(weights@vertices),atol=1e-12)
        # Separate source corners with hard normals are never welded/smoothed
        # merely because their spatial positions coincide.
        normals=np.array([[0.,0,1]]*3+[[1.,0,0]]*3)
        hard=interpolate_high_normals(normals,[[0,1,2],[3,4,5]],[0,1],[[.2,.3],[.2,.3]])
        np.testing.assert_array_equal(hard,[[0,0,1],[1,0,0]])

    def test_2x2_samples_stay_inside_low_face_and_reject_missing_projection(self):
        tex=np.array([[0.,0],[4,0],[0,4]]);xyz=np.column_stack([tex,np.zeros(3)])
        queried=[]
        def query(points):
            queried.append(points.copy());nearest=points.copy();nearest[points[:,0]>.5,2]+=10
            return {'points':nearest,'primitive_ids':np.zeros(len(points),dtype=int),'primitive_uvs':points[:,:2]/4}
        normal,valid,report=filtered_high_normals([[0,0],[3,0]],tex,xyz,[[0,1,2]],[[0.,0,1]]*3,.1,query)
        self.assertTrue(np.all(np.vstack(queried)[:,:2].sum(1)<=4+1e-10))
        self.assertEqual(report['outsideFaceTaps'],1)
        np.testing.assert_array_equal(valid,[True,False]);np.testing.assert_array_equal(normal[0],[0,0,1])
        self.assertEqual(report['texelsWithoutValidTaps'],1)
        self.assertEqual(report['validTaps']+report['cageRejectedTaps'],report['insideFaceTaps'])

    def test_sphere_pixel_average_converges_without_primitive_flat_alias(self):
        tex=np.array([[0.,0],[512,0],[0,512]]);xyz=np.column_stack([tex/512,np.zeros(3)])
        high_normals=unit(np.array([[0.,0,1],[1,0,1],[0,1,1]]))
        def query(points):return {'points':points,'primitive_ids':np.zeros(len(points),dtype=int),'primitive_uvs':points[:,:2]}
        result,valid,_=filtered_high_normals([[100,100],[200,100]],tex,xyz,[[0,1,2]],high_normals,.1,query)
        expected=[]
        for x,y in [[100,100],[200,100]]:
            taps=np.array([[x+dx,y+dy] for dx,dy in [(.25,.25),(.75,.25),(.25,.75),(.75,.75)]])/512
            expected.append(unit(interpolate_high_normals(high_normals,[[0,1,2]],[0]*4,taps).sum(0)))
        np.testing.assert_allclose(result,expected,atol=1e-12);self.assertTrue(valid.all())


if __name__=='__main__':unittest.main()
