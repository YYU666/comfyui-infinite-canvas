import unittest
import json
import tempfile
from pathlib import Path
from unittest.mock import patch
from types import SimpleNamespace
import numpy as np
import trimesh
from native3d_uv import unwrap, uv_geometry_metrics
from native3d_uv_coherent import _pack_rectangles, _pack_efficient, _pack_contours, coherent_unwrap


class CoherentTests(unittest.TestCase):
    def frozen_fixture(self):
        mesh=trimesh.Trimesh([[0,0,0],[1,0,0],[1,1,0],[0,1,0]],[[0,1,2],[0,2,3]],process=False)
        plan={'groups':[[0],[1]],'reasons':{(0,2):'reviewed'},'planSha256':'a'*64}
        source=np.asarray(mesh.faces).reshape(-1)
        output=trimesh.Trimesh(mesh.vertices[source],np.arange(6).reshape(-1,3),process=False)
        uv=np.array([[0.,0.],[1.,0.],[1.,1.],[2.,0.],[3.,1.],[2.,1.]])
        receipt={'backend':'libigl SLIM','iterations':20,'extraCuts':[],
                 'stretchPolicy':{'version':'experimental-stretch-review-v1','action':'warn_only'},
                 'stretchWarningIslandCount':1}
        return mesh,plan,(output,uv,source,np.arange(2),receipt)

    def test_frozen_slim_integration_preserves_mapping_seams_and_quality_gates(self):
        mesh,plan,answer=self.frozen_fixture()
        original=repr(plan)
        with patch.dict('sys.modules',{'native3d_uv_slim':SimpleNamespace(parameterize_groups=lambda *args:answer)}):
            result,report=coherent_unwrap(mesh,{'packingMode':'legacy_fixed','chartMergeCost':100,'orientationConfirmed':True},_frozen_plan=plan)
        np.testing.assert_array_equal(result.vertices,mesh.vertices[np.asarray(result.metadata['uvSourceVertex'])])
        self.assertEqual(report['geometricOverlapPairs'],0)
        self.assertEqual(report['overlapInteriorPixels'],0)
        self.assertTrue(report['reviewedSeamsVerified'])
        self.assertTrue(report['frozenPlanUnchanged'])
        self.assertEqual(report['parameterization']['iterations'],20)
        self.assertFalse(report['overlapRepair']['enabled'])
        self.assertEqual(report['stretchPolicy']['action'],'warn_only')
        self.assertEqual(report['stretchWarningIslandCount'],1)
        self.assertEqual(report['status'],'needs_review')
        self.assertNotIn('chartMergeCostMeaning',report)
        self.assertNotIn('chartMergeCost',report)
        self.assertNotIn('xatlas',report['backend'])
        self.assertEqual(repr(plan),original)

    def test_frozen_slim_rejects_overlap_without_face_isolation_retry(self):
        mesh,plan,answer=self.frozen_fixture()
        answer=list(answer);answer[1]=np.tile([[0.,0.],[1.,0.],[0.,1.]],(2,1))
        with tempfile.TemporaryDirectory() as folder:
            with patch.dict('sys.modules',{'native3d_uv_slim':SimpleNamespace(parameterize_groups=lambda *args:answer)}):
                with self.assertRaisesRegex(ValueError,'SLIM.*overlap.*repair disabled'):
                    coherent_unwrap(mesh,{'orientationConfirmed':True,'diagnosticsDirectory':folder},_frozen_plan=plan)
            diagnostic=json.loads((Path(folder)/'uv-rejected-report.json').read_text())
            self.assertFalse(diagnostic['acceptedUV']);self.assertFalse(diagnostic['bakeAllowed'])
            self.assertTrue(diagnostic['reason'])
            self.assertEqual(diagnostic['status'],'rejected_needs_review')
            self.assertTrue((Path(folder)/'uv-rejected-layout.png').is_file())
            with np.load(Path(folder)/'uv-rejected-diagnostic.npz') as saved:
                np.testing.assert_array_equal(saved['uv'],answer[1])

    def test_frozen_slim_rejects_missing_reviewed_seam_and_changed_geometry(self):
        mesh,plan,answer=self.frozen_fixture()
        uncut=(mesh.copy(),np.asarray(mesh.vertices)[:,:2],np.arange(4),np.arange(2),answer[-1])
        with patch.dict('sys.modules',{'native3d_uv_slim':SimpleNamespace(parameterize_groups=lambda *args:uncut)}):
            with self.assertRaisesRegex(ValueError,'missing reviewed UV seams'):
                coherent_unwrap(mesh,{'orientationConfirmed':True},_frozen_plan=plan)
        answer=list(answer);answer[0]=answer[0].copy();answer[0].vertices[0]+=.1
        with patch.dict('sys.modules',{'native3d_uv_slim':SimpleNamespace(parameterize_groups=lambda *args:answer)}):
            with self.assertRaisesRegex(ValueError,'exact source geometry'):
                coherent_unwrap(mesh,{'orientationConfirmed':True},_frozen_plan=plan)

    def test_coherent_exact_geometry_no_overlap_no_local_flip(self):
        m=trimesh.creation.icosphere(subdivisions=1)
        result,report=unwrap(m,{'seamStrategy':'coherent','chartMergeCost':8,'resolution':1024})
        source=np.asarray(result.metadata['uvSourceVertex']);faces=np.asarray(result.metadata['uvSourceFace'])
        np.testing.assert_array_equal(result.vertices,m.vertices[source]);np.testing.assert_array_equal(source[result.faces],m.faces[faces])
        self.assertEqual(report['overlapInteriorPixels'],0);self.assertEqual(report['mixedOrientationTriangles'],0)
        self.assertTrue(report['paddingVerifiedAtPixelCenters']);self.assertLess(report['islands'],len(m.faces))
        self.assertTrue(np.isfinite(result.visual.uv).all())

    def test_world_up_and_horizontal_axis_fallback_are_explicit(self):
        vertical=trimesh.Trimesh([[0,0,0],[2,0,0],[2,3,0],[0,3,0]],[[0,1,2],[0,2,3]],process=False)
        _,r=unwrap(vertical,{'seamStrategy':'coherent','orientationConfirmed':True})
        self.assertEqual(r['chartDirections'][0]['referenceAxis'],[0.,1.,0.])
        self.assertLess(r['worldUpAngleP95Degrees'],.01)
        self.assertEqual(r['worldUpOppositeAreaFraction'],0)
        horizontal=trimesh.Trimesh([[0,0,0],[2,0,0],[2,0,3],[0,0,3]],[[0,1,2],[0,2,3]],process=False)
        _,r=unwrap(horizontal,{'seamStrategy':'coherent','orientationConfirmed':True})
        self.assertNotEqual(r['chartDirections'][0]['referenceAxis'],[0.,1.,0.])

    def test_rectangle_pack_is_nonrotating_deterministic(self):
        extents=np.array([[10.,2],[3,7],[4,5]])
        a,p=_pack_rectangles(extents,1024,8);b,q=_pack_rectangles(extents,1024,8)
        self.assertEqual(a,b);np.testing.assert_array_equal(p,q)
        self.assertTrue(np.all(p+np.ceil(extents*a)+16<=1024))
        for i in range(len(extents)):
            for j in range(i):
                size=np.ceil(extents*a)+16
                self.assertFalse(np.all(p[i]<p[j]+size[j]) and np.all(p[j]<p[i]+size[i]))

    def test_chart_density_normalization_is_uniform_without_geometry_changes(self):
        m=trimesh.creation.icosphere(subdivisions=1)
        result,report=unwrap(m,{'seamStrategy':'coherent','chartMergeCost':8})
        ratios=[]
        for component in trimesh.graph.connected_components(result.face_adjacency,nodes=np.arange(len(result.faces)),min_len=1):
            ids=np.asarray(component);tri=result.visual.uv[result.faces[ids]];edges=tri[:,1:]-tri[:,:1]
            area=.5*np.abs(edges[:,0,0]*edges[:,1,1]-edges[:,0,1]*edges[:,1,0]).sum()
            ratios.append(area/result.area_faces[ids].sum())
        self.assertLess(np.max(ratios)/np.min(ratios),1.000001)
        self.assertEqual(report['mixedOrientationTriangles'],0)

    def test_contour_search_has_explicit_island_budget(self):
        with self.assertRaisesRegex(ValueError,'256 islands'):
            _pack_contours(None,[None]*257,1024,8)

    def test_efficient_rectangles_never_reduce_legacy_common_scale(self):
        extents=np.array([[10.,2],[3,7],[4,5],[1,8]])
        legacy,_=_pack_rectangles(extents,1024,8)
        scale,positions,turns=_pack_efficient(extents,1024,8)
        self.assertGreaterEqual(scale,legacy)
        sizes=np.ceil(extents*scale).astype(int)+16
        sizes[turns]=sizes[turns,::-1]
        self.assertTrue(np.all(positions+sizes<=1024))

    def test_triangle_area_and_subpixel_geometry_checks(self):
        mesh=trimesh.Trimesh([[0,0,0],[1,0,0],[0,1,0],[0,0,1],[1,0,1],[0,1,1]],[[0,1,2],[3,4,5]],process=False)
        uv=np.array([[.1,.1],[.2,.1],[.1,.2],[.10001,.10001],[.1001,.10001],[.10001,.1001]])
        metrics=uv_geometry_metrics(mesh,uv,1024,8)
        self.assertEqual(metrics['geometricOverlapPairs'],1)
        self.assertIsNone(metrics['triangleAreaOccupancyRatio'])
        self.assertAlmostEqual(metrics['triangleUVAreaSumRatio'],.00500000405)
        uv[3:]=[[.203,.1],[.3,.1],[.203,.2]]
        metrics=uv_geometry_metrics(mesh,uv,1024,8)
        self.assertEqual(metrics['geometricOverlapPairs'],0)
        self.assertEqual(metrics['geometricPaddingViolationPairs'],1)
        uv[3,0]=1.01
        self.assertGreater(uv_geometry_metrics(mesh,uv,1024,8)['geometricOutOfBoundsTriangles'],0)

    def test_legacy_option_is_explicit_and_geometric_checks_reported(self):
        _,r=unwrap(trimesh.creation.box(),{'seamStrategy':'coherent','packingMode':'legacy_fixed'})
        self.assertEqual(r['packingMode'],'legacy_fixed')
        self.assertEqual(r['geometricOverlapPairs'],0)
        self.assertEqual(r['geometricPaddingViolationPairs'],0)
        self.assertEqual(r['geometricOutOfBoundsTriangles'],0)
        self.assertGreater(r['triangleAreaOccupancyRatio'],0)

    def test_labels_preserved_and_invalid_cost_rejected(self):
        m=trimesh.creation.box()
        result,r=unwrap(m,{'seamStrategy':'coherent'},face_labels=np.arange(12)//2)
        self.assertGreaterEqual(r['structuralGroups'],6)
        face_source=np.asarray(result.metadata['uvSourceFace'])
        for component in trimesh.graph.connected_components(result.face_adjacency,nodes=np.arange(len(result.faces)),min_len=1):
            self.assertEqual(len(set((face_source[np.asarray(component)]//2).tolist())),1)
        with self.assertRaises(ValueError):unwrap(m,{'seamStrategy':'coherent','chartMergeCost':100})


if __name__=='__main__':unittest.main()
