import unittest
from unittest.mock import patch
import numpy as np
import trimesh
from native3d_geometry import diagnose, triangle_intersection_3d
from native3d_geometry_audit import audit_geometry, _intersection_flags


class IndexedAuditTests(unittest.TestCase):
    def test_clean_closed_mesh_parity_and_complete(self):
        for mesh in (trimesh.creation.box(), trimesh.creation.icosphere(subdivisions=2)):
            a = diagnose(mesh.vertices, mesh.faces)
            b = audit_geometry(mesh.vertices, mesh.faces)
            self.assertEqual(b['status'], 'accepted')
            self.assertTrue(b['intersectionComplete'])
            self.assertEqual(b['intersection_pairs_count'], len(a['intersection_pairs']))
            self.assertEqual(b['nonmanifold_vertices_count'], len(a['nonmanifold_vertices']))
            self.assertEqual(b['boundary_edges'], a['boundary_edges'])
            self.assertEqual(b['inconsistent_winding_edges'], a['inconsistent_winding_edges'])

    def test_crossing_closed_components_and_coplanar_overlap_block(self):
        one = trimesh.creation.box()
        two = trimesh.creation.box(); two.apply_translation([.4, .4, .4])
        mesh = trimesh.util.concatenate([one, two])
        b = audit_geometry(mesh.vertices, mesh.faces)
        self.assertEqual(b['status'], 'blocked')
        self.assertEqual(b['blocker'], 'geometry_intersection')
        self.assertGreater(b['intersection_pairs_count'], 0)
        v = np.array([[0,0,0],[2,0,0],[0,2,0],[.2,.2,0],[1,.2,0],[.2,1,0]])
        b = audit_geometry(v, [[0,1,2],[3,4,5]], allow_boundaries=True)
        self.assertEqual(b['intersectionStatus'], 'defect_found_search_stopped')

    def test_point_contact_and_shared_edge_do_not_become_area_overlap(self):
        v = [[0,0,0],[1,0,0],[0,1,0],[1,0,0],[2,0,0],[1,-1,0]]
        b = audit_geometry(v, [[0,1,2],[3,4,5]], allow_boundaries=True)
        self.assertEqual(b['status'], 'accepted')

    def test_bow_tie_vertex_winding_duplicate_and_boundary_gates(self):
        v = [[0,0,0],[1,0,0],[0,1,0],[-1,0,0],[0,-1,0]]
        b = audit_geometry(v, [[0,1,2],[0,3,4]], allow_boundaries=True)
        self.assertEqual(b['nonmanifold_vertices_count'], 1)
        self.assertEqual(b['status'], 'blocked')
        box = trimesh.creation.box()
        f = box.faces.copy(); f[0] = f[0, ::-1]
        self.assertGreater(audit_geometry(box.vertices, f)['inconsistent_winding_edges'], 0)
        self.assertEqual(audit_geometry(box.vertices, np.r_[box.faces, box.faces[:1]])['duplicate_faces'], 1)
        self.assertIn('boundary_intent', audit_geometry(box.vertices, box.faces[:-1])['blocker'])

    def test_budget_exhaustion_is_unknown_and_never_clean(self):
        m = trimesh.creation.icosphere(subdivisions=2)
        for settings in ({'max_pairs': 1}, {'max_sphere_pairs': 1}):
            report = audit_geometry(m.vertices, m.faces, **settings)
            self.assertEqual(report['status'], 'blocked')
            self.assertFalse(report['intersectionComplete'])
            self.assertIsNone(report['intersection_pairs_count'])
            self.assertEqual(report['intersectionStatus'], 'unknown_budget_exhausted')
        with patch('native3d_geometry_audit.time.monotonic', side_effect=[0., 2., 2.]):
            report = audit_geometry(m.vertices, m.faces, max_seconds=1.)
        self.assertEqual(report['status'], 'blocked')
        self.assertEqual(report['blocker'], 'audit_time_budget_exhausted')

    def test_large_sparse_mesh_does_not_use_quadratic_small_audit(self):
        # 12000 faces exceeds the legacy audit cap. Each component remains
        # independent and spatially separated, so broad phase stays bounded.
        box = trimesh.creation.box()
        v = (box.vertices[None]+np.column_stack((np.arange(1000)*3., np.zeros(1000), np.zeros(1000)))[:,None]).reshape(-1,3)
        f = (box.faces[None]+np.arange(1000)[:,None,None]*8).reshape(-1,3)
        report = audit_geometry(v, f, max_seconds=30)
        self.assertEqual(report['status'], 'accepted')
        self.assertEqual(report['componentCount'], 1000)
        self.assertLess(report['candidatePairs'], 100000)

    def test_vectorized_segments_match_existing_float64_semantics(self):
        rng = np.random.default_rng(145)
        triangles = rng.normal(size=(800,3,3))
        f = np.arange(2400).reshape(-1,3)
        cross = np.cross(triangles[:,1]-triangles[:,0], triangles[:,2]-triangles[:,0])
        n = cross/np.linalg.norm(cross,axis=1,keepdims=True)
        first, second = np.arange(0,800,2), np.arange(1,800,2)
        flags = _intersection_flags(triangles,f,n,first,second,1e-8,lambda:None)
        expected = [bool(triangle_intersection_3d(triangles[a],triangles[b],1e-8)) for a,b in zip(first,second)]
        np.testing.assert_array_equal(flags, expected)

    def test_source_contact_exception_is_exact_edge_only_and_never_positive_area(self):
        edge=[[[0.,0,0],[1.,0,0]]]
        # Two open sheets share that exact whole boundary edge with separate
        # topological vertices. The ledger permits that contact, not a crossing.
        v=np.array([[0,0,0],[1,0,0],[.5,1,0],[0,0,0],[1,0,0],[.5,0,1]],float)
        f=np.array([[0,1,2],[3,4,5]])
        self.assertEqual(audit_geometry(v,f,allow_boundaries=True)['status'],'blocked')
        self.assertEqual(audit_geometry(v,f,allow_boundaries=True,permitted_contact_edges=edge)['status'],'accepted')
        # Positive-area coplanar overlap remains blocked even with that ledger.
        v[5]=[.5,.5,0]
        r=audit_geometry(v,f,allow_boundaries=True,permitted_contact_edges=edge)
        self.assertEqual(r['blocker'],'geometry_intersection')
        # An unrelated nomination cannot hide a generic interior crossing.
        v=np.array([[0,0,0],[1,0,0],[0,1,0],[.2,.2,-1],[.2,.2,1],[.8,.2,0]])
        r=audit_geometry(v,f,allow_boundaries=True,permitted_contact_edges=edge)
        self.assertEqual(r['blocker'],'geometry_intersection')


if __name__ == '__main__':
    unittest.main()
