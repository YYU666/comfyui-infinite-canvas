import hashlib
import json
import os
from pathlib import Path
import tempfile
import time
import types
import unittest
import zipfile
from unittest.mock import patch,Mock
import numpy as np
import trimesh
import native3d_lod_source as source
import native3d_lod_protected as protected
from native3d_lod_local import SourceQuality,intersection_clusters
from native3d_geometry import mesh_hash
from native3d_geometry_audit import audit_geometry


class ProtectedLodTests(unittest.TestCase):
    def settings(self):return {'lod0KeepPercent':100,'lod0FaceCap':0,'lodKeepPercents':[100]*5,'lodFaceCaps':[0]*5}

    def blocked(self,mesh,folder,params=None,progress=None,**kwargs):
        folder=Path(folder);folder.mkdir(exist_ok=True)
        manifest={'status':'blocked','chainStatus':'blocked','sourceTriangles':len(mesh.faces),'stages':[],
                  'blocker':'original failed','sourceUnchanged':True,'returnedMeshRole':'original_source_diagnostic'}
        path=folder/'source-lod-report.json';path.write_text(json.dumps(manifest))
        return mesh,manifest,[{'path':str(path),'role':'report','sha256':hashlib.sha256(path.read_bytes()).hexdigest()}]

    def test_runtime_absent_and_corrupt_are_distinct(self):
        with tempfile.TemporaryDirectory() as temp,patch.object(protected,'runtime_directory',return_value=Path(temp)/'missing'):
            self.assertFalse(protected.runtime_available())
        with tempfile.TemporaryDirectory() as temp,patch.object(protected,'runtime_directory',return_value=Path(temp)):
            with self.assertRaisesRegex(ValueError,'wheel is missing'):protected.load_runtime()
            (Path(temp)/('pymeshlab-'+protected.VERSION+'-cp310-cp310-win_amd64.whl')).write_bytes(b'corrupt')
            with self.assertRaisesRegex(ValueError,'checksum'):protected.load_runtime()

    def test_import_failure_never_becomes_success(self):
        with patch.object(protected,'load_runtime',side_effect=ImportError('missing native library')):
            candidate,receipt=protected.solve(trimesh.creation.box(),12,time.monotonic()+5)
        self.assertIsNone(candidate);self.assertEqual(receipt['status'],'blocked')
        self.assertEqual(receipt['errorType'],'ImportError');self.assertIn('missing native library',receipt['blocker'])

    def test_relocated_purelib_native_binary_corruption_is_rejected(self):
        for suffix in ('.pyd','.dll'):
            with tempfile.TemporaryDirectory() as temp,patch.object(protected,'runtime_directory',return_value=Path(temp)):
                root=Path(temp);wheel=root/('pymeshlab-'+protected.VERSION+'-cp310-cp310-win_amd64.whl')
                binary='pymeshlab/runtime'+suffix
                with zipfile.ZipFile(wheel,'w') as stream:
                    stream.writestr('pymeshlab-'+protected.VERSION+'.data/purelib/'+binary,b'expected native binary')
                installed=root/binary;installed.parent.mkdir();installed.write_bytes(b'corrupted installed binary')
                with patch.object(protected,'WHEEL_SHA256',hashlib.sha256(wheel.read_bytes()).hexdigest()),patch.object(protected.importlib,'import_module') as imported:
                    with self.assertRaisesRegex(ValueError,'installed file checksum mismatch'):protected.load_runtime()
                    imported.assert_not_called()

    def test_absent_dependency_keeps_blocked_original(self):
        with tempfile.TemporaryDirectory() as temp,patch.object(source,'_run_source_lod_core',side_effect=self.blocked),patch.object(protected,'runtime_available',return_value=False),patch.object(protected,'solve') as solve:
            _,report,_=source.run_source_lod(trimesh.creation.box(),temp,self.settings())
            self.assertEqual(report['status'],'blocked');solve.assert_not_called()

    def test_successful_original_never_calls_protected(self):
        with tempfile.TemporaryDirectory() as temp,patch.object(protected,'runtime_available',return_value=True),patch.object(protected,'solve') as solve:
            _,report,_=source.run_source_lod(trimesh.creation.box(),temp,self.settings())
            self.assertEqual(report['status'],'accepted');solve.assert_not_called()

    def test_accepted_lod0_blocks_fallback_even_selected_later(self):
        def failed_later(*args,**kwargs):
            mesh,manifest,artifacts=self.blocked(*args,**kwargs)
            manifest['stages']=[{'stage':'lod0','visible':True,'status':'accepted'}]
            return mesh,manifest,artifacts
        with tempfile.TemporaryDirectory() as temp,patch.object(source,'_run_source_lod_core',side_effect=failed_later),patch.object(protected,'runtime_available',return_value=True),patch.object(protected,'solve') as solve:
            source.run_source_lod(trimesh.creation.box(),temp,{**self.settings(),'selectedLodLevel':2});solve.assert_not_called()

    def test_nondefault_backend_or_nonzero_selection_never_falls_back(self):
        for extra in ({'selectedLodLevel':1},{'simplifierBackend':'fast_simplification'}):
            with tempfile.TemporaryDirectory() as temp,patch.object(source,'_run_source_lod_core',side_effect=self.blocked),patch.object(protected,'runtime_available',return_value=True),patch.object(protected,'solve') as solve:
                source.run_source_lod(trimesh.creation.box(),temp,{**self.settings(),**extra});solve.assert_not_called()

    def test_single_fallback_archives_only_owned_files_and_uses_core_gates(self):
        mesh=trimesh.creation.box();core=source._run_source_lod_core;calls=[]
        def first_blocked(*args,**kwargs):
            calls.append(kwargs)
            return self.blocked(*args,**kwargs) if len(calls)==1 else core(*args,**kwargs)
        receipt={'status':'complete','candidateMeshHash':mesh_hash(mesh.vertices,mesh.faces),'qemPasses':[]}
        with tempfile.TemporaryDirectory() as temp,patch.object(source,'_run_source_lod_core',side_effect=first_blocked),patch.object(protected,'runtime_available',return_value=True),patch.object(protected,'solve',return_value=(mesh,receipt)) as solve:
            marker=Path(temp)/'unknown-existing.txt';marker.write_text('keep')
            selected,report,artifacts=source.run_source_lod(mesh,temp,self.settings())
            self.assertEqual(report['status'],'accepted',report.get('blocker'));self.assertEqual(len(calls),2);self.assertEqual(solve.call_count,1)
            self.assertEqual(marker.read_text(),'keep');self.assertTrue((Path(temp)/'open3d-attempt/source-lod-report.json').is_file())
            self.assertTrue(report['open3dAttempt']['actualArtifactReferencesResolveWithinBase'])
            self.assertEqual(mesh_hash(selected.vertices,selected.faces),report['selectedMeshHash'])
            self.assertTrue(all(Path(x['path']).is_file() for x in artifacts))
            self.assertTrue(report['selectedResultProof']['canonicalFileVerified'])
            self.assertEqual(report['backend'],'mixed')

    def test_archive_blocked_stage_does_not_require_unwritten_planned_filename(self):
        mesh=trimesh.creation.box();core=source._run_source_lod_core;calls=[]
        def first_blocked(*args,**kwargs):
            calls.append(1)
            if len(calls)>1:return core(*args,**kwargs)
            selected,manifest,artifacts=self.blocked(*args,**kwargs)
            folder=Path(args[1]);diagnostic=folder/'blocked_step_003.glb'
            diagnostic.write_bytes(trimesh.exchange.gltf.export_glb(mesh))
            manifest['stages']=[{'stage':'step_003','status':'blocked','visible':False,
                                'filename':'step_003.glb','diagnosticFilename':diagnostic.name}]
            (folder/'source-lod-report.json').write_text(json.dumps(manifest))
            artifacts.append({'path':str(diagnostic),'role':'export','diagnostic':True})
            return selected,manifest,artifacts
        receipt={'status':'complete','candidateMeshHash':mesh_hash(mesh.vertices,mesh.faces),'qemPasses':[]}
        with tempfile.TemporaryDirectory() as temp,patch.object(source,'_run_source_lod_core',side_effect=first_blocked),patch.object(protected,'runtime_available',return_value=True),patch.object(protected,'solve',return_value=(mesh,receipt)):
            _,report,_=source.run_source_lod(mesh,temp,self.settings())
            self.assertEqual(report['status'],'accepted')
            archive=Path(temp)/'open3d-attempt'
            self.assertTrue((archive/'blocked_step_003.glb').is_file())
            self.assertFalse((archive/'step_003.glb').exists())
            self.assertTrue(report['open3dAttempt']['plannedBlockedFilenamesMayNotExist'])

    def test_deadline_validation_after_archive_retains_blocked_root_diagnostic(self):
        mesh=trimesh.creation.box();calls=[]
        def core(*args,**kwargs):
            calls.append(1)
            if len(calls)==1:return self.blocked(*args,**kwargs)
            raise ValueError('Shared source LOD wall budget exhausted')
        receipt={'status':'complete','candidateMeshHash':mesh_hash(mesh.vertices,mesh.faces),'qemPasses':[]}
        with tempfile.TemporaryDirectory() as temp,patch.object(source,'_run_source_lod_core',side_effect=core),patch.object(protected,'runtime_available',return_value=True),patch.object(protected,'solve',return_value=(mesh,receipt)):
            _,report,artifacts=source.run_source_lod(mesh,temp,self.settings())
            self.assertEqual(report['status'],'blocked');self.assertNotIn('selectedResultProof',report)
            self.assertIn('budget exhausted',report['protectedFallback']['exportGateFailure'])
            self.assertTrue((Path(temp)/'blocked-protected-lod0.glb').is_file())
            self.assertTrue((Path(temp)/'source-lod-report.json').is_file())
            self.assertTrue(all(Path(a['path']).is_file() for a in artifacts))

    def test_helper_cannot_bypass_final_geometry_gate(self):
        mesh=trimesh.creation.box();bad=trimesh.Trimesh(mesh.vertices,mesh.faces[[0,0]],process=False)
        core=source._run_source_lod_core;calls=[]
        def once(*args,**kwargs):
            calls.append(1);return self.blocked(*args,**kwargs) if len(calls)==1 else core(*args,**kwargs)
        receipt={'status':'complete','candidateMeshHash':mesh_hash(bad.vertices,bad.faces),'qemPasses':[]}
        with tempfile.TemporaryDirectory() as temp,patch.object(source,'_run_source_lod_core',side_effect=once),patch.object(protected,'runtime_available',return_value=True),patch.object(protected,'solve',return_value=(bad,receipt)):
            _,report,artifacts=source.run_source_lod(mesh,temp,self.settings())
            self.assertEqual(report['status'],'blocked');self.assertNotIn('selectedResultProof',report)
            self.assertFalse(any(x.get('eligibleForDownstream') for x in report['stages']))
            self.assertTrue(all(Path(a['path']).is_file() for a in artifacts))

    def test_failed_fallback_retains_true_original_diagnostic(self):
        with tempfile.TemporaryDirectory() as temp,patch.object(source,'_run_source_lod_core',side_effect=self.blocked),patch.object(protected,'runtime_available',return_value=True),patch.object(protected,'solve',return_value=(None,{'status':'blocked','blocker':'corrupt dependency'})):
            mesh=trimesh.creation.box();selected,report,artifacts=source.run_source_lod(mesh,temp,self.settings())
            self.assertEqual(report['status'],'blocked');self.assertIs(selected,mesh)
            self.assertEqual(report['protectedFallback']['blocker'],'corrupt dependency')
            self.assertFalse((Path(temp)/'open3d-attempt').exists());self.assertTrue(all(Path(x['path']).exists() for x in artifacts))

    def test_fallback_shares_original_wall_budget(self):
        clock=[100.]
        def slow(*args,**kwargs):clock[0]=104.;return self.blocked(*args,**kwargs)
        def solve(mesh,target,deadline,progress):
            self.assertEqual(deadline,105.);return None,{'status':'blocked','blocker':'one second remaining'}
        with tempfile.TemporaryDirectory() as temp,patch.object(source,'_run_source_lod_core',side_effect=slow),patch.object(protected,'runtime_available',return_value=True),patch.object(protected,'solve',side_effect=solve),patch.object(time,'monotonic',side_effect=lambda:clock[0]):
            source.run_source_lod(trimesh.creation.box(),temp,{**self.settings(),'maxSeconds':5})

    def test_complete_census_never_accepts_known_intersections(self):
        v=np.array([[-1,-1,0],[1,-1,0],[0,1,0],[0,-.5,-1],[0,-.5,1],[0,.5,0]],float);f=np.array([[0,1,2],[3,4,5]])
        report=audit_geometry(v,f,allow_boundaries=True,collect_all_intersections=True)
        self.assertTrue(report['intersectionComplete']);self.assertEqual(report['status'],'blocked')
        self.assertEqual(report['intersection_pairs_count'],1)
        clean=audit_geometry(*[np.asarray(x) for x in (trimesh.creation.box().vertices,trimesh.creation.box().faces)],collect_all_intersections=True)
        self.assertEqual(clean['status'],'accepted');self.assertEqual(clean['intersection_pairs_count'],0)

    def quality_fixture(self,strong,support):
        q=SourceQuality.__new__(SourceQuality);q.diagonal=10.;q.normal_source='verified loader-retained source NORMAL/vn'
        q.reference=Mock();q.reference.compare.return_value={'distanceP95Fraction':0.,'sampledMaxDistanceFraction':0.,'oppositeNormalFraction':.1}
        q.smooth=Mock(side_effect=[({'strongOppositeFraction':.01,'oppositeFraction':.01},None),({'strongOppositeFraction':strong,'oppositeFraction':strong},None)])
        q.neighborhood_support=Mock(return_value={'meanSupportDot':support,'sourceFaces':[{'sourceFaceId':7,'areaWeightedSupportDot':support}]})
        old=np.array([[0,0,0],[1,0,0],[0,1,0]],float);new=old.copy();new[1,2]=.01;f=np.array([[0,1,2]])
        return q,new,f,old

    def test_new_97percent_backfacing_face_is_rejected(self):
        q,v,f,old=self.quality_fixture(.97,1.)
        accepted,receipt=q.candidate(v,f,old,f,np.array([0]));self.assertFalse(accepted)
        self.assertIn('severe',receipt['changedFaces'][0]['rejected']);q.neighborhood_support.assert_not_called()

    def test_backfacing_area_growth_is_rejected_even_when_fraction_decreases(self):
        q,v,f,old=self.quality_fixture(.97,1.)
        v[1]=[4.8,0,0]
        q.smooth.side_effect=[({'strongOppositeFraction':.99,'oppositeFraction':.99},None),
                              ({'strongOppositeFraction':.97,'oppositeFraction':.97},None)]
        accepted,receipt=q.candidate(v,f,old,f,np.array([0]));self.assertFalse(accepted)
        row=receipt['changedFaces'][0]
        self.assertGreater(row['new']['stronglyOpposedArea'],4*row['old']['stronglyOpposedArea'])
        q.neighborhood_support.assert_not_called()

    def test_isolated_source_fold_requires_positive_neighborhood_evidence(self):
        q,v,f,old=self.quality_fixture(.14,.898)
        accepted,receipt=q.candidate(v,f,old,f,np.array([0]));self.assertTrue(accepted)
        self.assertTrue(receipt['warnings']);self.assertEqual(receipt['changedFaces'][0]['sourceNeighborhood']['sourceFaces'][0]['sourceFaceId'],7)
        q,v,f,old=self.quality_fixture(.14,-.8)
        accepted,_=q.candidate(v,f,old,f,np.array([0]));self.assertFalse(accepted)


if __name__=='__main__':unittest.main()
