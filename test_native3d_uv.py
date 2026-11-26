import unittest
import numpy as np
import trimesh
from native3d_uv import structural_groups, unwrap, uv_metrics


def trough(inverted=False):
    # Two longitudinal panels sharing central crease; +Z normals.
    vertices=np.array([[-1,0,1],[-1,2,1],[0,0,0],[0,2,0],[1,0,1],[1,2,1]],float)
    if inverted: vertices[:,2]*=-1
    faces=np.array([[0,2,3],[0,3,1],[2,4,5],[2,5,3]])
    return trimesh.Trimesh(vertices,faces,process=False)

class StructuralUVTest(unittest.TestCase):
    def test_diagonal_euclidean_padding_violation(self):
        vertices=np.array([[0.,0,0],[1,0,0],[0,1,0],[3,0,0],[4,0,0],[3,1,0]])
        faces=np.array([[0,1,2],[3,4,5]])
        uv=np.array([[10,10],[11.4,10],[10,11.4],[15,15],[16.4,15],[15,16.4]])/1024
        report,_=uv_metrics(trimesh.Trimesh(vertices,faces,process=False),uv,1024,8)
        self.assertAlmostEqual(report['interIslandPixelCenterGapWithinSearchPixels'],np.sqrt(50))
        self.assertGreater(report['paddingCollisionPixels'],0)

    def test_inward_closed_shell_rejected_without_global_flip(self):
        box=trimesh.creation.box()
        inward=trimesh.Trimesh(box.vertices,box.faces[:,::-1],process=False)
        original=inward.faces.copy()
        with self.assertRaisesRegex(ValueError,'outward shell'):
            structural_groups(inward,{'orientationConfirmed':True})
        np.testing.assert_array_equal(inward.faces,original)
        mixed=trimesh.util.concatenate([box,inward.copy().apply_translation([3,0,0])])
        with self.assertRaisesRegex(ValueError,'outward shell'):
            structural_groups(mixed,{'orientationConfirmed':True})

    def test_signed_concave_not_all_sharp_edges(self):
        params={'orientationConfirmed':True,'concaveAngleDegrees':25,'sharpAngleDegrees':120}
        concave,reasons=structural_groups(trough(),params)
        convex,other=structural_groups(trough(True),params)
        self.assertEqual(reasons,{(2,3):'signed_concave'})
        self.assertEqual(other,{})
        self.assertEqual(sorted(map(len,concave)),[2,2])
        self.assertEqual(list(map(len,convex)),[4])

    def test_open_requires_confirmed_orientation(self):
        with self.assertRaisesRegex(ValueError,'orientationConfirmed'):
            structural_groups(trough(),{})
        broken=trough();broken.faces[0]=broken.faces[0,::-1];broken._cache.clear()
        with self.assertRaisesRegex(ValueError,'consistent'):
            structural_groups(broken,{'orientationConfirmed':True})

    def test_actual_atlas_seam_lineage_and_quality(self):
        mesh=trough()
        result,report=unwrap(mesh,{'orientationConfirmed':True,'resolution':1024,'padding':8,'sharpAngleDegrees':120})
        self.assertEqual(report['enforcedInteriorSeams'],1)
        self.assertEqual(report['structuralGroups'],2)
        source=np.asarray(result.metadata['uvSourceVertex']);face_source=np.asarray(result.metadata['uvSourceFace'])
        np.testing.assert_array_equal(source[result.faces],mesh.faces[face_source])
        np.testing.assert_array_equal(result.vertices,mesh.vertices[source])
        self.assertEqual(report['overlapInteriorPixels'],0)
        self.assertEqual(report['mixedOrientationTriangles'],0)
        self.assertEqual(report['degenerateUVTriangles'],0)
        self.assertLess(report['stretchRatioP95'],1.01)
        self.assertLess(report['islands'],len(mesh.faces))
        self.assertTrue(report['paddingVerifiedAtPixelCenters'])
        self.assertGreaterEqual(report['tileEdgeMarginPixels'],8)

    def test_manual_nonseparating_seam_cannot_rejoin(self):
        mesh=trimesh.creation.icosphere(subdivisions=1)
        edge=mesh.face_adjacency_edges[0].tolist()
        result,report=unwrap(mesh,{'seamEdges':[edge],'concaveAngleDegrees':179,'sharpAngleDegrees':179,'resolution':1024})
        self.assertEqual(report['enforcedInteriorSeams'],1)
        self.assertGreater(report['structuralGroups'],1)
        self.assertTrue(report['exactTriangleMapping'])

if __name__=='__main__':unittest.main()
