import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import numpy as np
import trimesh
from native3d_geometry import mesh_hash
from native3d_lod_source import (resolve_lod_settings, logical_target, run_source_lod,
                                 normalize_source_geometry, separate_existing_vertex_fans)
from native3d_lod_source import _triangulate_boundary_3d, _triangulate_boundary, _prove_selected_result
from native3d_lod_source import _local_repair_face_ids, repair_source_local_patch
from native3d_geometry_audit import audit_geometry


class SourceLodTests(unittest.TestCase):
    def test_crossing_shared_vertex_closes_exact_incident_star_only(self):
        faces=np.array([[0,1,2],[0,2,3],[0,3,4],[0,4,1],[1,5,2],[5,6,7]])
        removed,shared=_local_repair_face_ids(faces,{},[[0,2]])
        self.assertEqual(shared,[0])
        self.assertEqual(removed.tolist(),[0,1,2,3])
        # A disjoint crossing pair cannot silently grow an arbitrary patch.
        removed,shared=_local_repair_face_ids(faces,{},[[0,5]])
        self.assertEqual(shared,[])
        self.assertEqual(removed.tolist(),[0,5])

    def test_crossing_star_retains_fixed_face_budget(self):
        count=257
        ring=np.column_stack((np.cos(np.arange(count)*2*np.pi/count),np.sin(np.arange(count)*2*np.pi/count),np.zeros(count)))
        vertices=np.vstack(([0.,0.,0.],ring))
        faces=np.array([[0,i+1,(i+1)%count+1] for i in range(count)])
        report={'intersectionStatus':'defect_found_search_stopped','intersection_pairs':[[0,128]]}
        with self.assertRaisesRegex(ValueError,'exceeds256'):
            repair_source_local_patch(vertices,faces,{},report)

    def test_percentage_references_and_explicit_cap_conflict(self):
        s = resolve_lod_settings({'lod1FaceCap':10000})
        r = logical_target(1,1000024,100000,100000,s)
        self.assertEqual(r['percentageTargetTriangles'],50000)
        self.assertEqual(r['effectiveTargetTriangles'],10000)
        self.assertEqual(r['effectiveTargetKeepPercent'],10)
        self.assertTrue(r['budgetClampedPercentage'])
        s = resolve_lod_settings({'lodPercentReference':'previous','lodKeepPercents':[100,50,50,50,50]})
        self.assertEqual(logical_target(3,1000,100,25,s)['effectiveTargetTriangles'],12)
        s = resolve_lod_settings({'lodKeepPercents':[100,50,25,12.5,6.25]})
        self.assertEqual(logical_target(3,1000,100,25,s)['effectiveTargetTriangles'],12)
        with self.assertRaises(ValueError):resolve_lod_settings({'lodKeepPercents':[100,25,50,10,5]})
        with self.assertRaises(ValueError):resolve_lod_settings({'lod0KeepPercent':True})
        with self.assertRaises(ValueError):resolve_lod_settings({'selectedLodLevel':True})

    def test_small_input_never_upsamples_and_aliases_are_honest(self):
        m = trimesh.creation.box(); m.vertices += [.123456789,0,0]
        m.visual = trimesh.visual.TextureVisuals(uv=np.tile([.2,.4],(len(m.vertices),1)))
        before = mesh_hash(m.vertices,m.faces); uv=m.visual.uv.copy()
        with tempfile.TemporaryDirectory() as out:
            selected,r,artifacts=run_source_lod(m,out,{'lod0KeepPercent':100,'lodKeepPercents':[100]*5})
            self.assertEqual(r['status'],'accepted')
            self.assertEqual(len(r['logicalLevels']),5)
            self.assertEqual([x['triangles'] for x in r['logicalLevels']],[12]*5)
            self.assertEqual(len([a for a in artifacts if a['role']=='export']),1)
            self.assertTrue(all(not x['receipt']['reductionPerformed'] for x in r['stages']))
            self.assertEqual(r['stages'][-1]['aliasOfStage'],'lod0')
            loaded=trimesh.load(Path(out)/'lod0.glb',force='mesh',process=False)
            self.assertEqual(mesh_hash(loaded.vertices,loaded.faces),r['selectedMeshHash'])
            self.assertEqual(mesh_hash(selected.vertices,selected.faces),r['selectedMeshHash'])
            self.assertEqual(r['naniteLod0File'],'lod0.glb')
            self.assertFalse(r['nanite']['built'])
            self.assertEqual(r['attributePolicy'],'geometry_only_requires_uv_and_bake')
            with self.assertRaises(FileExistsError):run_source_lod(m,out,{'lod0KeepPercent':100})
        self.assertEqual(mesh_hash(m.vertices,m.faces),before)
        np.testing.assert_array_equal(m.visual.uv,uv)

    def test_sequential_real_parents_canonical_export_and_reduction_bounds(self):
        # A dense sphere makes moderate reductions meaningful and remains
        # within the small deterministic fidelity fixture budget.
        m=trimesh.creation.icosphere(subdivisions=3)
        with tempfile.TemporaryDirectory() as out:
            selected,r,_=run_source_lod(m,out,{'lod0KeepPercent':80,'lod0FaceCap':0,
                  'lodKeepPercents':[100,80,65,55,45]})
            self.assertEqual(r['status'],'accepted',r.get('blocker'))
            prior=r['source_mesh_hash'];prior_count=len(m.faces)
            for entry in r['stages']:
                self.assertEqual(entry['parent_mesh_hash'],prior)
                child=trimesh.load(Path(out)/entry['filename'],force='mesh',process=False)
                self.assertEqual(mesh_hash(child.vertices,child.faces),entry['mesh_hash'])
                count=len(child.faces)
                self.assertLessEqual(count,prior_count)
                self.assertGreaterEqual(count,np.ceil(prior_count*.5)-1)
                prior=entry['mesh_hash'];prior_count=count
            self.assertEqual(len(r['logicalLevels']),5)
            self.assertEqual(len(selected.faces),r['logicalLevels'][0]['triangles'])

    def test_stalled_and_overaggressive_simplifiers_fail_closed(self):
        m=trimesh.creation.icosphere(subdivisions=1)
        cases=[lambda v,f,**kw:(v,f),lambda v,f,**kw:(v,f[:2])]
        for fake in cases:
            with tempfile.TemporaryDirectory() as out,patch('fast_simplification.simplify',side_effect=fake):
                _,r,artifacts=run_source_lod(m,out,{'lod0KeepPercent':20,'simplifierBackend':'fast_simplification'})
                self.assertEqual(r['status'],'blocked')
                self.assertNotIn('selectedStage',r)
                self.assertEqual(len([a for a in artifacts if a['role']=='export']),0)

    def test_dirty_unchanged_source_cannot_be_accepted(self):
        m=trimesh.creation.box();m.faces=np.r_[m.faces,m.faces[:1]]
        with tempfile.TemporaryDirectory() as out,patch('fast_simplification.simplify') as backend:
            _,r,_=run_source_lod(m,out,{'lod0KeepPercent':100})
            self.assertEqual(r['status'],'blocked')
            backend.assert_not_called()

    def test_exact_position_normalization_preserves_all_source_triangle_coordinates(self):
        m=trimesh.creation.box()
        v=m.vertices[m.faces].reshape(-1,3);f=np.arange(len(v)).reshape(-1,3)
        a,b,r=normalize_source_geometry(v,f)
        self.assertEqual(len(a),8)
        np.testing.assert_array_equal(a[b],v[f])
        self.assertEqual(r['sourceTrianglePositionsSha256'],r['normalizedTrianglePositionsSha256'])
        self.assertEqual(r['joinedDuplicatePositionVertices'],28)

    def test_existing_fans_split_without_face_deletion_or_geometry_change(self):
        v=np.array([[0,0,0],[1,0,0],[.5,1,0],[.5,0,1],[.5,-1,0],[.5,0,-1]],float)
        f=np.array([[0,1,2],[0,1,3],[0,1,4],[0,1,5]])
        before=audit_geometry(v,f,allow_boundaries=True)
        a,b,r=separate_existing_vertex_fans(v,f,before)
        np.testing.assert_array_equal(a[b],v[f])
        self.assertEqual(len(b),len(f))
        after=audit_geometry(a,b,allow_boundaries=True,permitted_contact_edges=r['permittedContactEdges'])
        self.assertEqual(after['status'],'accepted',after.get('blocker'))
        self.assertFalse(after['watertight'])
        self.assertGreater(after['boundary_edges'],0)

    def test_nonplanar_disk_candidate_preserves_directed_boundary_and_still_needs_audit(self):
        # A skew polygon need not be a graph over its XY projection.
        v=np.array([[0,0,0],[1,1,1],[0,1,0],[1,0,-1]],float)
        tris=_triangulate_boundary_3d(v,[0,1,2,3])
        self.assertEqual(len(tris),2)
        edge_counts={}
        for face in tris:
            for a,b in zip(face,np.roll(face,-1)):
                key=tuple(sorted((int(a),int(b))))
                edge_counts.setdefault(key,[]).append((int(a),int(b)))
        boundary={owners[0] for owners in edge_counts.values() if len(owners)==1}
        self.assertEqual(boundary,{(0,1),(1,2),(2,3),(3,0)})
        # A truly crossed planar boundary is never certified by triangulation;
        # the independent embedded audit must and does reject its overlap.
        crossed=np.array([[0,0,0],[1,1,0],[0,1,0],[1,0,0]],float)
        with self.assertRaises(ValueError):_triangulate_boundary(crossed,[0,1,2,3])

    def test_failed_real_candidate_is_diagnostic_never_a_completed_level(self):
        m=trimesh.creation.icosphere(subdivisions=2);calls=[]
        def fail_candidate(*args,**kwargs):
            result=audit_geometry(*args,**kwargs);calls.append(True)
            if len(calls)==2:
                result.update(status='blocked',blocker='geometry_intersection',
                              intersectionStatus='defect_found_search_stopped',intersectionComplete=False,
                              intersection_pairs=[[0,1]],intersection_pairs_count=1)
            return result
        with tempfile.TemporaryDirectory() as out,patch('native3d_lod_source.audit_geometry',side_effect=fail_candidate):
            selected,r,artifacts=run_source_lod(m,out,{'lod0KeepPercent':50})
            self.assertEqual(r['status'],'blocked')
            self.assertEqual(r['logicalLevels'],[])
            self.assertNotIn('selectedStage',r)
            self.assertLess(len(selected.faces),len(m.faces))
            self.assertTrue((Path(out)/'blocked_lod0.glb').is_file())
            self.assertEqual(r['stages'][0]['status'],'blocked')
            self.assertTrue(next(a for a in artifacts if a['role']=='export')['diagnostic'])

    def test_hidden_intersection_is_not_an_asset_and_visible_level_rechecks_clean(self):
        m=trimesh.creation.icosphere(subdivisions=3);calls=[]
        def inherited_intersection(*args,**kwargs):
            result=audit_geometry(*args,**kwargs);calls.append(True)
            if len(calls)==2:
                result.update(status='blocked',blocker='geometry_intersection',
                              intersectionStatus='defect_found_search_stopped',intersectionComplete=False,
                              intersection_pairs=[[0,1]],intersection_pairs_count=1)
            return result
        with tempfile.TemporaryDirectory() as out,patch('native3d_lod_source.audit_geometry',side_effect=inherited_intersection):
            _,r,artifacts=run_source_lod(m,out,{'lod0KeepPercent':40,'lodKeepPercents':[100]*5})
            self.assertEqual(r['status'],'accepted',r.get('blocker'))
            transient=r['stages'][0]
            self.assertEqual(transient['status'],'diagnostic_intermediate')
            self.assertIsNone(transient['filename'])
            self.assertFalse(transient['eligibleForDownstream'])
            self.assertEqual(transient['receipt']['geometry']['status'],'blocked')
            self.assertTrue((Path(out)/transient['diagnosticFilename']).is_file())
            self.assertFalse((Path(out)/'step_001.glb').exists())
            lod0=next(s for s in r['stages'] if s.get('lodLevel')==0)
            self.assertEqual(lod0['parent_mesh_hash'],transient['mesh_hash'])
            self.assertEqual(lod0['receipt']['geometry']['status'],'accepted')
            self.assertTrue(lod0['receipt']['geometry']['intersectionComplete'])
            self.assertEqual(lod0['receipt']['geometry']['intersection_pairs_count'],0)
            self.assertTrue(lod0['eligibleForDownstream'])
            self.assertFalse(any(a.get('name')=='step_001.glb' for a in artifacts))

    def test_later_failed_level_preserves_only_strict_selected_product(self):
        m=trimesh.creation.icosphere(subdivisions=3);calls=[]
        def later_failure(*args,**kwargs):
            result=audit_geometry(*args,**kwargs);calls.append(True)
            if len(calls)==3:
                result.update(status='blocked',blocker='geometry_intersection',
                              intersectionStatus='defect_found_search_stopped',intersectionComplete=False,
                              intersection_pairs=[[0,1]],intersection_pairs_count=1)
            return result
        with tempfile.TemporaryDirectory() as out,patch('native3d_lod_source.audit_geometry',side_effect=later_failure):
            selected,r,_=run_source_lod(m,out,{'lod0KeepPercent':80,
                  'lodKeepPercents':[100,80,60,50,40],'selectedLodLevel':0})
            self.assertEqual(r['status'],'accepted',r.get('blocker'))
            self.assertEqual(r['acceptanceScope'],'selected_lod_and_recorded_accepted_stages')
            self.assertEqual(r['chainStatus'],'blocked')
            self.assertFalse(r['chainComplete'])
            self.assertIn('geometry_intersection',r['chainBlocker'])
            self.assertNotIn('blocker',r)
            self.assertEqual(mesh_hash(selected.vertices,selected.faces),r['selectedMeshHash'])
            self.assertEqual(r['selectedStage'],'lod0')
            self.assertTrue(r['selectedResultProof']['canonicalFileVerified'])
            failed=next(s for s in r['stages'] if s['stage']=='lod1')
            self.assertEqual(failed['status'],'blocked')
            self.assertFalse(failed['eligibleForDownstream'])
            self.assertTrue((Path(out)/failed['diagnosticFilename']).is_file())
            with self.assertRaises(ValueError):
                bad=selected.copy();bad.vertices[0]+=.1
                _prove_selected_result(bad,r,out)

    def test_failed_chain_cannot_accept_an_unproduced_selected_level(self):
        m=trimesh.creation.icosphere(subdivisions=3);calls=[]
        def later_failure(*args,**kwargs):
            result=audit_geometry(*args,**kwargs);calls.append(True)
            if len(calls)==3:
                result.update(status='blocked',blocker='geometry_intersection',
                              intersectionStatus='defect_found_search_stopped',intersectionComplete=False,
                              intersection_pairs=[[0,1]],intersection_pairs_count=1)
            return result
        with tempfile.TemporaryDirectory() as out,patch('native3d_lod_source.audit_geometry',side_effect=later_failure):
            _,r,_=run_source_lod(m,out,{'lod0KeepPercent':80,
                 'lodKeepPercents':[100,80,60,50,40],'selectedLodLevel':4})
            self.assertEqual(r['status'],'blocked')
            self.assertFalse(r['chainComplete'])
            self.assertNotIn('selectedResultProof',r)
            self.assertNotIn('selectedStage',r)


if __name__ == '__main__':
    unittest.main()
