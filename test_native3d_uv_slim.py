import unittest
import tempfile
import json
from pathlib import Path
from unittest.mock import patch
import numpy as np
import trimesh
from native3d_uv_slim import parameterize_groups
from native3d_uv_overlap import overlap_pairs


def grid(n=4):
    x,y=np.meshgrid(np.arange(n),np.arange(n))
    v=np.column_stack((x.ravel(),y.ravel(),np.zeros(x.size))).astype(float)
    a=(y[:-1,:-1]*n+x[:-1,:-1]).ravel()
    f=np.vstack((np.column_stack((a,a+1,a+n+1)),np.column_stack((a,a+n+1,a+n))))
    return trimesh.Trimesh(v,f,process=False)


class SlimTests(unittest.TestCase):
    def verify(self,mesh,groups,reasons):
        before_v=mesh.vertices.copy();before_f=mesh.faces.copy()
        result,uv,source,source_face,receipt=parameterize_groups(mesh,groups,reasons)
        np.testing.assert_array_equal(result.vertices,mesh.vertices[source])
        np.testing.assert_array_equal(source[result.faces],mesh.faces[source_face])
        np.testing.assert_array_equal(mesh.vertices,before_v);np.testing.assert_array_equal(mesh.faces,before_f)
        self.assertEqual(overlap_pairs(result,uv),[])
        self.assertEqual(receipt['iterationsPerIsland'],20)
        self.assertTrue(np.isfinite(uv).all())
        for metric in receipt['islandMetrics']:
            self.assertEqual(metric['nonpositiveTriangles'],0)
            self.assertLessEqual(metric['areaWeightedStretchP95'],2)
            self.assertLessEqual(metric['areaFractionStretchOver3'],.01)
        return result,uv,source,source_face,receipt

    def test_disk_exact_geometry_and_single_island(self):
        mesh=grid();*_,receipt=self.verify(mesh,[np.arange(len(mesh.faces))],{})
        self.assertEqual(receipt['islands'],1);self.assertEqual(receipt['extraCutCount'],0)

    def test_annulus_one_pass_cut_to_disk(self):
        n=24;angle=np.arange(n)*2*np.pi/n
        v=np.vstack((np.column_stack((np.cos(angle),np.sin(angle),np.zeros(n))),np.column_stack((.5*np.cos(angle),.5*np.sin(angle),np.zeros(n)))))
        f=[]
        for i in range(n):
            j=(i+1)%n;f.extend(([i,j,n+j],[i,n+j,n+i]))
        mesh=trimesh.Trimesh(v,f,process=False)
        *_,receipt=self.verify(mesh,[np.arange(len(f))],{})
        self.assertEqual(receipt['islands'],1);self.assertGreater(receipt['extraCutCount'],0)

    def test_pinched_vertex_fans_split_without_position_edits(self):
        mesh=trimesh.Trimesh([[0,0,0],[1,0,0],[0,1,0],[-1,0,0],[0,-1,0]],[[0,1,2],[0,3,4]],process=False)
        result,_,source,_,receipt=self.verify(mesh,[np.arange(2)],{})
        self.assertEqual(receipt['islands'],2);self.assertEqual(np.count_nonzero(source==0),2)

    def test_group_boundary_and_explicit_interior_constraint_preserved(self):
        mesh=grid(5)
        reasons={(6,7):'manual_locked'}
        *_,receipt=self.verify(mesh,[np.arange(len(mesh.faces))],reasons)
        self.assertEqual(receipt['frozenReasonEdges'],1)
        self.assertGreater(receipt['extraCutCount'],0)
        mesh=grid(2)
        result,uv,source,sf,receipt=self.verify(mesh,[np.array([0]),np.array([1])],{})
        self.assertEqual(receipt['islands'],2)
        self.assertFalse(set(result.faces[0])&set(result.faces[1]))
        self.assertGreater(uv[result.faces[1],0].min()-uv[result.faces[0],0].max(),.5)

    def test_closed_sphere_and_invalid_inputs_reject(self):
        mesh=trimesh.creation.icosphere(subdivisions=1)
        with self.assertRaisesRegex(ValueError,'closed component'):parameterize_groups(mesh,[np.arange(len(mesh.faces))],{})
        mesh=grid(2)
        for groups in ([],[np.array([0])],[np.array([0,0,1])],[np.array([0.,1.])]):
            with self.assertRaises(ValueError):parameterize_groups(mesh,groups,{})
        with self.assertRaisesRegex(ValueError,'canonical source edge'):parameterize_groups(mesh,[np.arange(2)],{(0,99):'manual_locked'})
        broken=mesh.copy();broken.vertices[0]=np.nan
        with self.assertRaises(ValueError):parameterize_groups(broken,[np.arange(2)],{})

    def test_stretch_warning_retains_metrics_without_retry(self):
        import igl
        mesh=grid()
        original=igl.slim_solve;calls=[]
        def distorted(state,iterations):
            calls.append(iterations);uv=np.asarray(original(state,iterations)).copy();uv[:,0]*=100
            return uv
        with patch('igl.slim_solve',side_effect=distorted):
            *_,receipt=parameterize_groups(mesh,[np.arange(len(mesh.faces))],{})
        self.assertEqual(receipt['stretchPolicy']['action'],'warn_only')
        self.assertEqual(receipt['status'],'needs_review')
        self.assertEqual(receipt['stretchWarningIslandCount'],1)
        self.assertGreater(receipt['worstAreaWeightedStretchP95'],2)
        self.assertGreater(receipt['worstAreaFractionStretchOver3'],.01)
        self.assertTrue(receipt['islandMetrics'][0]['stretchWarnings'])
        self.assertEqual(calls,[20])

    def test_nonfinite_and_negative_orientation_still_reject(self):
        import igl
        mesh=grid();original=igl.slim_solve
        for mode,message in [('nonfinite','invalid coordinates'),('flip','orientation gate')]:
            def invalid(state,iterations):
                uv=np.asarray(original(state,iterations)).copy()
                if mode=='nonfinite':uv[0,0]=np.nan
                else:uv[:,0]*=-1
                return uv
            with self.subTest(mode=mode),patch('igl.slim_solve',side_effect=invalid):
                with self.assertRaisesRegex(ValueError,message):
                    parameterize_groups(mesh,[np.arange(len(mesh.faces))],{})

    def test_open_slit_shared_tip_is_a_real_seam(self):
        mesh=grid(5)
        result,uv,source,sf,receipt=parameterize_groups(mesh,[np.arange(len(mesh.faces))],{(12,13):'manual_locked'})
        self.assertGreater(receipt['sharedTipSeams'],0)
        exported=np.unique(np.sort(result.edges,axis=1),axis=0)
        mapped=np.sort(source[exported],axis=1)
        edges=exported[np.all(mapped==[12,13],axis=1)]
        self.assertEqual(len(edges),2)
        self.assertEqual(len(set(edges[0])&set(edges[1])),1)
        np.testing.assert_array_equal(source[result.faces],mesh.faces[sf])

    def test_unchanged_reason_edge_rejects_and_preserves_actual_diagnostic(self):
        mesh=grid(5)
        with tempfile.TemporaryDirectory() as folder:
            with patch('native3d_uv_slim._constrained_cuts',return_value=set()):
                with self.assertRaisesRegex(ValueError,'unchanged exported edges'):
                    parameterize_groups(mesh,[np.arange(len(mesh.faces))],{(6,12):'manual_locked'},folder)
            report=json.loads((Path(folder)/'uv-rejected-report.json').read_text())
            self.assertEqual(report['missingSeamCount'],1);self.assertFalse(report['acceptedUV'])
            self.assertTrue((Path(folder)/'uv-rejected-layout.png').is_file())
            with np.load(Path(folder)/'uv-rejected-diagnostic.npz') as data:
                np.testing.assert_array_equal(data['sourceVertex'][data['faces']],mesh.faces[data['sourceFace']])


if __name__=='__main__':unittest.main()
