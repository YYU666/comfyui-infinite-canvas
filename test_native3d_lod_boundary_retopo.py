import copy
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch,Mock
import numpy as np
import trimesh
import native3d_lod_boundary_retopo as retopo
from native3d_lod_boundary import OriginalBoundaryReference
from native3d_lod_source import _canonical_mesh
from native3d_geometry_audit import audit_geometry
from native3d_geometry import mesh_hash


class BoundaryRetopologyTests(unittest.TestCase):
    def fixture(self):
        v=np.array([[0.,0.,0.],[1.,0.,0.],[0.,1.,0.]])
        f=np.array([[0,1,2]]);m=_canonical_mesh(v,f)
        boundary=OriginalBoundaryReference(v,f);census=audit_geometry(v,f,allow_boundaries=True,collect_all_intersections=True)
        return m,boundary,census

    def marker(self,m):
        return {'meshHash':mesh_hash(m.vertices,m.faces),'markers':[{'classification':'certification_incomplete',
                'candidateEdgeVertexIds':[0,1],'adjacentFaceIds':[0],'candidatePoint':[.5,0,0],
                'originalPoint':[.5,.004,0],'distanceMeters':.004}]}

    def test_split_preserves_orientation_fixed_interface_and_reconstructs_before(self):
        m,_,_=self.fixture();v,f,mapping=retopo._split(m.vertices,m.faces,0,[0,1],[.5,.001,0])
        np.testing.assert_array_equal(v[:-1],m.vertices)
        np.testing.assert_array_equal(f,[[0,3,2],[3,1,2]])
        restored=np.insert(f[:-2],mapping['removedFaceId'],mapping['removedFaceVertices'],axis=0)
        self.assertEqual(mesh_hash(v[:-1],restored),mesh_hash(m.vertices,m.faces))
        self.assertEqual(audit_geometry(v,f,allow_boundaries=True,collect_all_intersections=True)['status'],'accepted')

    def test_hardcap_refuses_addition_before_localization(self):
        m,b,c=self.fixture()
        with patch.object(retopo,'locate_boundary_issue') as locate:
            got,r=retopo.repair_boundary_certificate(m,m,b,c,1,time.monotonic()+10)
        self.assertIs(got,m);self.assertEqual(r['status'],'blocked');self.assertIn('hard cap',r['blocker']);locate.assert_not_called()

    def test_incomplete_or_wrong_mesh_census_never_repaired(self):
        m,b,c=self.fixture()
        for change in ({'intersectionComplete':False},{'intersection_pairs_count':1},{'mesh_hash':'wrong'},{'status':'blocked'}):
            with patch.object(retopo,'locate_boundary_issue') as locate:
                _,r=retopo.repair_boundary_certificate(m,m,b,{**c,**change},2,time.monotonic()+10)
            self.assertEqual(r['status'],'blocked');locate.assert_not_called()

    def test_expired_deadline_refuses_work(self):
        m,b,c=self.fixture()
        with patch.object(retopo,'locate_boundary_issue') as locate:
            _,r=retopo.repair_boundary_certificate(m,m,b,c,2,time.monotonic()-1)
        self.assertIn('deadline',r['blocker']);locate.assert_not_called()

    def test_true_exceedance_and_multiple_regions_are_not_blindly_repaired(self):
        m,b,c=self.fixture();location=self.marker(m)
        for kind in ('confirmed','multiple'):
            modified=copy.deepcopy(location)
            if kind=='confirmed':modified['markers'][0]['classification']='confirmed_issue'
            else:modified['markers'].append({**modified['markers'][0],'candidateEdgeVertexIds':[1,2]})
            with patch.object(retopo,'locate_boundary_issue',return_value=modified),patch.object(retopo,'_split') as split:
                _,r=retopo.repair_boundary_certificate(m,m,b,c,2,time.monotonic()+10)
            self.assertEqual(r['status'],'blocked');split.assert_not_called()

    def test_boundary_vertex_is_not_insertion_site(self):
        m,b,c=self.fixture();location=self.marker(m);location['markers'][0]['candidatePoint']=[0,0,0]
        with patch.object(retopo,'locate_boundary_issue',return_value=location),patch.object(retopo,'_split') as split:
            _,r=retopo.repair_boundary_certificate(m,m,b,c,2,time.monotonic()+10)
        self.assertIn('inside boundary edge',r['blocker']);split.assert_not_called()

    def test_locator_certifies_identical_boundary_and_is_hash_bound(self):
        m,b,c=self.fixture();r=retopo.locate_boundary_issue(m.vertices,m.faces,b,time.monotonic()+10)
        self.assertEqual(r['meshHash'],mesh_hash(m.vertices,m.faces))
        self.assertTrue(all(x['classification']=='certified' for x in r['markers']))
        self.assertTrue(all(x['distanceMeters']<1e-12 for x in r['markers']))

    def test_locator_rejects_perimeter_topology_changes(self):
        m,b,c=self.fixture()
        with self.assertRaisesRegex(ValueError,'perimeter'):
            retopo.locate_boundary_issue(m.vertices*2,m.faces,b,time.monotonic()+10)

    def test_only_certificate_errors_are_eligible(self):
        self.assertNotIn('Original boundary perimeter changed by more than5percent',retopo.CERTIFICATE_FAILURES)
        self.assertNotIn('Original boundary distance exceeds independent shape budget',retopo.CERTIFICATE_FAILURES)

    def test_successful_local_split_with_real_quality_checks(self):
        m,b,c=self.fixture()
        # Original high = input plane; inserted point moves in-plane. Verified
        # normals are explicit so source-quality interpolation remains real.
        m.metadata['nativeNormalSource']='verified loader-retained source NORMAL/vn'
        with patch.object(retopo,'locate_boundary_issue',return_value=self.marker(m)):
            result,r=retopo.repair_boundary_certificate(m,m,b,c,2,time.monotonic()+20)
        self.assertEqual(r['status'],'complete',r.get('blocker'));self.assertEqual(len(r['candidates']),1)
        row=r['candidates'][0];self.assertTrue(row['sourceNormalQuality']['accepted']);self.assertTrue(row['fidelity']['accepted'])
        self.assertEqual(row['geometry']['intersection_pairs_count'],0);self.assertEqual(len(result.faces),2)
        self.assertNotEqual(r['beforeMeshHash'],r['afterMeshHash'])

    def test_failed_boundary_keeps_before_and_stops_after_two(self):
        m,b,c=self.fixture();m.metadata['nativeNormalSource']='verified loader-retained source NORMAL/vn'
        with patch.object(retopo,'locate_boundary_issue',return_value=self.marker(m)),patch.object(b,'compare',side_effect=ValueError('still uncertain')):
            result,r=retopo.repair_boundary_certificate(m,m,b,c,2,time.monotonic()+20)
        self.assertIs(result,m);self.assertEqual(r['status'],'blocked');self.assertEqual(len(r['candidates']),2)

    def test_over_displacement_budget_skips_gates(self):
        m,b,c=self.fixture();m.metadata['nativeNormalSource']='verified loader-retained source NORMAL/vn';location=self.marker(m);location['markers'][0]['originalPoint']=[.5,1.,0]
        with patch.object(retopo,'locate_boundary_issue',return_value=location),patch.object(retopo,'audit_geometry') as audit:
            _,r=retopo.repair_boundary_certificate(m,m,b,c,2,time.monotonic()+20)
        self.assertEqual(len(r['candidates']),2);audit.assert_not_called();self.assertEqual(r['status'],'blocked')

    def test_original_normal_gate_rejection_is_not_waived(self):
        from native3d_lod_local import SourceQuality
        m,b,c=self.fixture();m.metadata['nativeNormalSource']='verified loader-retained source NORMAL/vn'
        with patch.object(retopo,'locate_boundary_issue',return_value=self.marker(m)),patch.object(SourceQuality,'candidate',return_value=(False,{'changedFaces':[]})):
            result,r=retopo.repair_boundary_certificate(m,m,b,c,2,time.monotonic()+20)
        self.assertIs(result,m);self.assertEqual(r['status'],'blocked');self.assertEqual(len(r['candidates']),2)

    def test_fixed_vertex_mutation_is_rejected(self):
        m,b,c=self.fixture();m.metadata['nativeNormalSource']='verified loader-retained source NORMAL/vn';real=retopo._split
        def changed(*args):
            v,f,mapping=real(*args);v[0,0]+=.01;return v,f,mapping
        with patch.object(retopo,'locate_boundary_issue',return_value=self.marker(m)),patch.object(retopo,'_split',side_effect=changed):
            result,r=retopo.repair_boundary_certificate(m,m,b,c,2,time.monotonic()+20)
        self.assertIs(result,m);self.assertIn('fixed geometry',r['blocker'])

    def test_child_only_dispatches_certificate_failure_after_zero_census(self):
        import native3d_lod_protected as protected
        import native3d_lod_source as source
        parent=trimesh.creation.icosphere(subdivisions=1)
        class Mesh:
            def __init__(self,vertex_matrix,face_matrix):self.v=vertex_matrix;self.f=face_matrix
            def vertex_matrix(self):return self.v
            def face_matrix(self):return self.f
        class MeshSet:
            def add_mesh(self,m):self.m=m
            def current_mesh(self):return self.m
            def filter_parameter_values(self,name):return {k:None for k in ('qualitythr','preserveboundary','boundaryweight','preservenormal','preservetopology','optimalplacement','planarquadric','planarweight','qualityweight','autoclean','selected','targetperc')}
            def apply_filter(self,name,targetfacenum,**kwargs):self.m.f=self.m.f[:targetfacenum]
        runtime=SimpleNamespace(Mesh=Mesh,MeshSet=MeshSet)
        metrics={'distanceP95Fraction':0.,'sampledMaxDistanceFraction':0.,'oppositeNormalFraction':0.}
        def audit(v,f,**kwargs):
            return {'status':'accepted','intersectionComplete':True,'intersection_pairs_count':0,
                    'mesh_hash':mesh_hash(v,f),'componentCount':1,'signedVolume':1.,
                    **{k:0 for k in ('duplicate_faces','degenerate_faces_count','nonmanifold_edges_count','nonmanifold_vertices_count','inconsistent_winding_edges')}}
        for failure,expected in ((retopo.CERTIFICATE_FAILURES[0],1),('Original boundary perimeter changed by more than5percent',0)):
            boundary=Mock(diagonal=4.,mesh_hash='original');boundary.compare.side_effect=[{'accepted':True},ValueError(failure),{'accepted':True}]
            def repair(candidate,high,boundary,census,cap,deadline,progress):
                self.assertEqual(cap,40);self.assertEqual(census['intersection_pairs_count'],0)
                return candidate,{'status':'complete','localization':{'meshHash':mesh_hash(candidate.vertices,candidate.faces)}}
            with patch.object(protected,'load_runtime',return_value=(runtime,{'version':'test'})),patch.object(protected,'audit_geometry',side_effect=audit),patch.object(protected,'OriginalBoundaryReference',return_value=boundary),patch.object(source,'_Reference') as reference,patch.object(retopo,'repair_boundary_certificate',side_effect=repair) as call:
                reference.return_value.compare.return_value=metrics
                _,receipt=protected.solve_child(parent,parent,40,9,time.monotonic()+20)
            self.assertEqual(call.call_count,expected)
            self.assertEqual(receipt['status'],'complete' if expected else 'blocked')

if __name__=='__main__':unittest.main()


