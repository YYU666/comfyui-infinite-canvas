import tempfile
import unittest
from pathlib import Path
import numpy as np
import trimesh
from native3d_uv import unwrap
from native3d_uv_ao import face_ao,ao_geometry_groups,label_boundaries


def cavity():
    v=np.array([[-.7,0,1],[-.7,2,1],[0,0,0],[0,2,0],[.7,0,1],[.7,2,1]],float)
    return trimesh.Trimesh(v,[[0,2,3],[0,3,1],[2,4,5],[2,5,3]],process=False)


class AOTests(unittest.TestCase):
    def test_cavity_occlusion_is_finite_deterministic_and_exceeds_flat(self):
        m=cavity();params={'aoRaySamples':64,'aoRadiusFraction':.3}
        dark,supported,report=face_ao(m,params)
        again,_,_=face_ao(m,params)
        np.testing.assert_array_equal(dark,again)
        self.assertTrue(np.isfinite(dark).all());self.assertGreater(dark.mean(),.1)
        flat=trimesh.Trimesh([[0,0,0],[1,0,0],[0,1,0]],[[0,1,2]],process=False)
        light,_,_=face_ao(flat,params)
        self.assertEqual(light[0],0);self.assertTrue(supported.all())

    def test_ao_uv_preserves_exact_geometry_and_exports_actual_views(self):
        m=cavity()
        with tempfile.TemporaryDirectory() as folder:
            result,report=unwrap(m,{'seamStrategy':'ao_geometry','orientationConfirmed':True,'aoRaySamples':32,
                'aoRadiusFraction':.3,'diagnosticsDirectory':folder,'resolution':1024})
            source=np.asarray(result.metadata['uvSourceVertex']);faces=np.asarray(result.metadata['uvSourceFace'])
            np.testing.assert_array_equal(result.vertices,m.vertices[source])
            np.testing.assert_array_equal(source[result.faces],m.faces[faces])
            self.assertEqual(report['aoGeometry']['aoSeams'],1)
            self.assertEqual(report['overlapInteriorPixels'],0)
            for name in ('ao-view.png','seam-view.png','uv-layout.png','uv-checker.png'):
                self.assertTrue((Path(folder)/name).is_file())

    def test_labels_are_face_bound_and_no_dark_face_only_splitting(self):
        m=cavity()
        with self.assertRaises(ValueError):label_boundaries(m,[1])
        groups,reasons,report=ao_geometry_groups(m,{'orientationConfirmed':True,'aoRadiusFraction':.3,
            'aoConcaveAngleDegrees':120,'coarseAngleDegrees':100},face_labels=np.zeros(4,dtype=int))
        self.assertGreater(report['darknessMean'],.1)
        self.assertEqual(report['aoSeams'],0);self.assertEqual(len(groups),1)

    def test_reference_mismatch_cannot_add_ao_seams(self):
        m=cavity();reference=m.copy();reference.apply_translation([0,0,100])
        _,_,report=ao_geometry_groups(m,{'orientationConfirmed':True,'aoRadiusFraction':.3},reference)
        self.assertEqual(report['supportedFaceFraction'],0);self.assertEqual(report['aoSeams'],0)


if __name__=='__main__':unittest.main()
