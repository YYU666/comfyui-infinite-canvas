import unittest
import numpy as np
import trimesh
from native3d_uv_xatlas_coarse import _harmonic,parameterize_groups
from native3d_uv_overlap import overlap_pairs

class CoarseXatlasTests(unittest.TestCase):
    def test_fixed_convex_embedding(self):
        v=np.array([[0,0,0],[2,0,0],[2,1,0],[0,1,0],[.1,.5,1.]])
        f=np.array([[0,1,4],[1,2,4],[2,3,4],[3,0,4]])
        uv,metrics=_harmonic(v,f,np.arange(4))
        np.testing.assert_allclose(np.linalg.norm(uv[:4],axis=1),1.)
        self.assertEqual(metrics['nonpositiveTriangles'],0)
        self.assertFalse(overlap_pairs(trimesh.Trimesh(v,f,process=False),uv))
    def test_new_mode_reports_actual_solver_and_valid_packing(self):
        from native3d_uv_coherent import coherent_unwrap
        mesh=trimesh.Trimesh([[0,0,0],[1,0,0],[1,1,0],[0,1,0]],[[0,1,2],[0,2,3]],process=False)
        frozen={'reasons':{},'groups':[np.array([0,1])],'planSha256':'test','parameterizationBackend':'ai_coarse_harmonic_v3'}
        out,report=coherent_unwrap(mesh,{'resolution':1024,'padding':8,'alignDirection':'none','packingMode':'legacy_fixed','orientationConfirmed':True},_frozen_plan=frozen)
        self.assertIn('coarse fixed convex positive harmonic',report['backend'])
        self.assertEqual(report['geometricOverlapPairs'],0)
        self.assertEqual(report['mixedOrientationTriangles'],0)
        self.assertEqual(report['geometricPaddingViolationPairs'],0)
        self.assertIn('face density varies',report['densityPolicy'])
        self.assertEqual(report['status'],'needs_review')
        evidence={'darkness':np.array([.2,.8]),'supported':np.array([True,False]),
                  'highSourceSha256':'1'*64,'targetSourceSha256':'2'*64,
                  'raySamples':32,'queryCount':2,'raysCast':64}
        _,guided=coherent_unwrap(mesh,{'resolution':1024,'padding':8,'alignDirection':'none','packingMode':'legacy_fixed','orientationConfirmed':True},
                                high_guided_evidence=evidence,_frozen_plan=frozen)
        from native3d_engine import compact_json
        import json
        decoded=json.loads(compact_json({'metadata':{'uv':guided}}))['metadata']['uv']
        self.assertEqual(decoded['aoGeometry']['supported'],[True,False])
        self.assertEqual(decoded['aoGeometry']['referenceSupportedFaces'],[True,False])
        self.assertEqual(decoded['aoGeometry']['faceDarkness'],[.2,.8])


    def test_source_mapping_preserved(self):
        mesh=trimesh.creation.icosphere(subdivisions=1)
        groups=[np.arange(len(mesh.faces))]
        out,uv,vertex,face,report=parameterize_groups(mesh,groups,{})
        np.testing.assert_array_equal(out.vertices,mesh.vertices[vertex])
        np.testing.assert_array_equal(vertex[out.faces],mesh.faces[face])
        np.testing.assert_array_equal(np.sort(face),np.arange(len(mesh.faces)))
        self.assertFalse(overlap_pairs(out,uv))
        self.assertFalse(report['faceIsolation'])

if __name__=='__main__':unittest.main()
