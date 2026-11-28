import native3d_geometry_audit as geometry_audit
import copy
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch, Mock
import numpy as np
import trimesh
import native3d_lod_local as local
import native3d_lod_protected as protected
import native3d_lod_retry as retry
from native3d_geometry import mesh_hash
from native3d_geometry_audit import audit_geometry
from native3d_lod_source import _canonical_mesh, resolve_lod_settings


def coarse_star():
    # Regression fixture: a coarse complete star with one shared-vertex crossing.
    v=np.array([[6.368898391723633,3.4875261783599854,-1.9330984354019165],
    [6.4135026931762695,3.6307363510131836,-2.012376070022583],
    [6.480251789093018,3.893486499786377,-2.152566432952881],
    [6.377809524536133,3.535431385040283,-1.9388314485549927],
    [6.406603813171387,3.57250714302063,-1.9887351989746094],
    [6.296286106109619,3.508516788482666,-1.791252851486206],
    [6.423028469085693,3.6328959465026855,-2.0272459983825684],
    [6.328554630279541,3.748836040496826,-1.7963294982910156]])
    f=np.array([[7,5,3],[3,1,6],[1,3,4],[3,5,0],[2,3,6],[3,2,7],[4,3,0]])
    return v,f


class FixedTopologyTests(unittest.TestCase):
    def run_star(self,v=None,f=None,normal=True,diagonal=16.277810746267658):
        if v is None:v,f=coarse_star()
        census=audit_geometry(v,f,allow_boundaries=True,collect_all_intersections=True)
        quality=Mock();quality.candidate.return_value=(normal,{'accepted':normal})
        with patch.object(local,'SourceQuality',return_value=quality):
            result=local.relocate_fixed_topology(v,f,None,SimpleNamespace(diagonal=diagonal),census,lambda:None)
        return result,quality

    def test_coarse_complete_star_small_move_real_intersection_check(self):
        v,f=coarse_star();(nv,nf,r),quality=self.run_star()
        self.assertGreater(r['clusters'][0]['diameter'],.02*16.277810746267658)
        self.assertEqual(r['status'],'complete');self.assertEqual(r['clusters'][0]['relocation']['fraction'],.125)
        np.testing.assert_array_equal(f,nf);np.testing.assert_array_equal(v[np.arange(8)!=3],nv[np.arange(8)!=3])
        self.assertLess(np.linalg.norm(nv-v,axis=1).max(),.002*16.277810746267658)
        self.assertEqual(audit_geometry(nv,nf,allow_boundaries=True,collect_all_intersections=True)['status'],'accepted')
        self.assertEqual(quality.candidate.call_count,1)

    def test_source_normal_rejection_cannot_be_bypassed(self):
        v,f=coarse_star();(nv,nf,r),quality=self.run_star(normal=False)
        self.assertEqual(r['status'],'blocked');np.testing.assert_array_equal(v,nv)
        self.assertTrue(any(t.get('rejected')=='original smooth normal quality' for t in r['clusters'][0]['trials']))

    def test_all_moves_over_budget_are_skipped(self):
        v,f=coarse_star();(nv,nf,r),quality=self.run_star(diagonal=.1)
        self.assertEqual(r['status'],'blocked');quality.candidate.assert_not_called()
        self.assertTrue(all(t['rejected']=='displacement' for t in r['clusters'][0]['trials']))
        np.testing.assert_array_equal(v,nv)

    def test_unchanged_existing_flip_footprint_guard(self):
        v,f=coarse_star();c=audit_geometry(v,f,allow_boundaries=True,collect_all_intersections=True)
        with patch.object(local,'SourceQuality'),self.assertRaisesRegex(ValueError,'2percent'):
            local.repair_candidates(v,f,None,SimpleNamespace(diagonal=16.277810746267658),c,lambda:None)

    def test_complete_census_and_canonical_input_required(self):
        v,f=coarse_star()
        with self.assertRaisesRegex(ValueError,'complete census'):
            local.relocate_fixed_topology(v,f,None,SimpleNamespace(diagonal=16),{},lambda:None)
        v[0,0]+=1e-9
        with self.assertRaisesRegex(ValueError,'canonical'):
            local.relocate_fixed_topology(v,f,None,SimpleNamespace(diagonal=16),{},lambda:None)

    def test_outside_patch_crossing_rejects_move(self):
        with patch.object(local,'patch_intersections',return_value=[[0,99]]):
            (nv,nf,r),quality=self.run_star()
        self.assertEqual(r['status'],'blocked');quality.candidate.assert_not_called()

    def test_non_disk_or_incomplete_star_rejected(self):
        v,f=coarse_star();f=np.concatenate([f,[[3,0,1]]])
        with self.assertRaises(ValueError):self.run_star(v,f)

    def test_two_disjoint_stars_preserve_all_fixed_positions(self):
        v,f=coarse_star();v2=(v+[1.,0.,0.]).astype(np.float32).astype(float)
        both=np.concatenate([v,v2]);ff=np.concatenate([f,f+8])
        (nv,nf,r),quality=self.run_star(both,ff)
        self.assertEqual(r['status'],'complete');self.assertEqual(len(r['clusters']),2)
        fixed=np.ones(16,bool);fixed[[3,11]]=False
        np.testing.assert_array_equal(nv[fixed],both[fixed]);np.testing.assert_array_equal(ff,nf)
        for row in r['clusters']:
            trial=row['relocation']
            self.assertLessEqual(trial['cumulativeCanonicalDisplacementMeters'],.002*16.277810746267658)
        for args in quality.candidate.call_args_list:
            cv=args.args[0];np.testing.assert_array_equal(cv,cv.astype(np.float32).astype(float))

    def test_relocation_deadline_checked_before_work(self):
        v,f=coarse_star();c=audit_geometry(v,f,allow_boundaries=True,collect_all_intersections=True)
        with patch.object(local,'SourceQuality') as quality,self.assertRaisesRegex(ValueError,'deadline'):
            local.relocate_fixed_topology(v,f,None,SimpleNamespace(diagonal=16),c,Mock(side_effect=ValueError('deadline')))
        quality.assert_not_called()


class ChildRetryTests(unittest.TestCase):
    def setup_case(self):
        parent=_canonical_mesh(*self.sphere_arrays(3))
        context={'retryJobId':'old','retryStage':'lod3','parentStage':'lod2',
                 'parentMeshHash':mesh_hash(parent.vertices,parent.faces),'parentFileSha256':'a'*64,
                 'originalSourceSha256':'b'*64,'lod0Triangles':len(parent.faces)*4,'settings':resolve_lod_settings({'lod1KeepPercent':50,'lod2KeepPercent':25,'lod3KeepPercent':12.5,'lod4KeepPercent':6.25})}
        return parent,{'retryJobId':'old','retryStage':'lod3','seed':29},context

    def sphere_arrays(self,n):
        m=trimesh.creation.icosphere(subdivisions=n);return m.vertices,m.faces

    def test_original_success_never_calls_fallback(self):
        m,p,c=self.setup_case()
        with tempfile.TemporaryDirectory() as tmp,patch.object(protected,'solve_child') as solve:
            _,report,_=retry.run_retry(m,m,tmp,p,c)
        self.assertEqual(report['status'],'accepted');solve.assert_not_called()

    def reject_first(self):
        real=geometry_audit.audit_geometry;calls=[]
        def audit(*a,**k):
            r=real(*a,**k);calls.append(1)
            if len(calls)==2:r.update(status='blocked',blocker='forced first candidate failure')
            return r
        return audit

    def test_fallback_once_same_parent_seed_deadline_and_independent_final_gates(self):
        m,p,c=self.setup_case();observed=[]
        def helper(parent,high,target,seed,deadline,progress):
            observed.append((parent,high,target,seed,deadline))
            # Intentionally return the parent, violating target. Never trust helper status.
            return parent,{'status':'complete','runtime':{'version':'test'},'algorithm':'test QEM'}
        with tempfile.TemporaryDirectory() as tmp,patch.object(geometry_audit,'audit_geometry',side_effect=self.reject_first()),patch.object(protected,'child_runtime_available',return_value=True),patch.object(protected,'solve_child',side_effect=helper) as solve:
            _,report,files=retry.run_retry(m,m,tmp,p,c)
            self.assertEqual(report['status'],'blocked');self.assertIn('exceeds effective target',report['blocker'])
            self.assertTrue((Path(tmp)/'blocked_open3d_lod3.glb').is_file())
        self.assertEqual(solve.call_count,1);self.assertIs(observed[0][0],m);self.assertIs(observed[0][1],m)
        self.assertEqual(observed[0][3],29);self.assertLessEqual(observed[0][4]-time.monotonic(),900)
        self.assertNotIn('selectedStage',report)

    def test_helper_success_has_single_stage_and_actual_algorithm(self):
        m,p,c=self.setup_case()
        with tempfile.TemporaryDirectory() as tmp:
            good,_,_=retry.run_retry(m,m,tmp,p,c)
        def helper(*args):return good,{'status':'complete','runtime':{'version':'test'},'algorithm':'PyMeshLab QEM; not AI'}
        with tempfile.TemporaryDirectory() as tmp,patch.object(geometry_audit,'audit_geometry',side_effect=self.reject_first()),patch.object(protected,'child_runtime_available',return_value=True),patch.object(protected,'solve_child',side_effect=helper):
            result,report,files=retry.run_retry(m,m,tmp,p,c)
            self.assertEqual(report['status'],'accepted');self.assertEqual(report['backend'],'pymeshlab')
            self.assertEqual(len(report['stages']),1);self.assertEqual(report['stages'][0]['stage'],'lod3')
            reload=trimesh.load(Path(tmp)/'lod3.glb',force='mesh',process=False)
            self.assertEqual(mesh_hash(reload.vertices,reload.faces),report['selectedMeshHash'])
            self.assertEqual(len(files),2)

    def test_unavailable_runtime_and_failed_helper_stay_blocked(self):
        for available in (False,True):
            m,p,c=self.setup_case()
            with tempfile.TemporaryDirectory() as tmp,patch.object(geometry_audit,'audit_geometry',side_effect=self.reject_first()),patch.object(protected,'child_runtime_available',return_value=available),patch.object(protected,'solve_child',return_value=(None,{'status':'blocked','blocker':'runtime corrupt'})) as solve:
                _,report,_=retry.run_retry(m,m,tmp,p,c)
            self.assertEqual(report['status'],'blocked');self.assertEqual(solve.call_count,int(available))

    def test_parent_lineage_rejected_before_any_solver(self):
        m,p,c=self.setup_case();c['parentStage']='lod0'
        with tempfile.TemporaryDirectory() as tmp,patch.object(protected,'solve_child') as solve,self.assertRaisesRegex(ValueError,'lineage'):
            retry.run_retry(m,m,tmp,p,c)
        solve.assert_not_called()

    def test_expired_child_deadline_never_loads_runtime(self):
        m,p,c=self.setup_case()
        with patch.object(protected,'load_runtime') as load:
            candidate,r=protected.solve_child(m,m,100,29,time.monotonic()-1)
        self.assertIsNone(candidate);self.assertEqual(r['status'],'blocked');load.assert_not_called()

    def test_child_runtime_failure_is_diagnostic(self):
        m,p,c=self.setup_case()
        with patch.object(protected,'load_runtime',side_effect=ValueError('checksum mismatch')):
            candidate,r=protected.solve_child(m,m,100,29,time.monotonic()+30)
        self.assertIsNone(candidate);self.assertEqual(r['status'],'blocked');self.assertIn('checksum',r['blocker'])

    def test_retry_deadline_exhaustion_skips_fallback(self):
        m,p,c=self.setup_case();clock=[10.];calls=[];real=geometry_audit.audit_geometry
        def audit(*a,**k):
            r=real(*a,**k);calls.append(1)
            if len(calls)==2:
                clock[0]=911.;r.update(status='blocked',blocker='first candidate rejected after budget')
            return r
        with tempfile.TemporaryDirectory() as tmp,patch.object(retry.time,'monotonic',side_effect=lambda:clock[0]),patch.object(geometry_audit,'audit_geometry',side_effect=audit),patch.object(protected,'child_runtime_available',return_value=True),patch.object(protected,'solve_child') as solve:
            _,report,_=retry.run_retry(m,m,tmp,p,c)
        self.assertEqual(report['status'],'blocked');solve.assert_not_called()
        self.assertFalse(report['stages'][0]['receipt']['childFallback']['attempted'])

if __name__=='__main__':unittest.main()
