import copy
import hashlib
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace

import numpy as np
from native3d_geometry import mesh_hash
from native3d_geometry_audit import audit_geometry
from native3d_jobs import validate_parameters
from native3d_lod_boundary import OriginalBoundaryReference
from native3d_lod_boundary_retopo import repair_boundary_measured, locate_boundary_issue
from native3d_lod_repair import freeze_repair_context, run_local_repair
from native3d_lod_source import _canonical_mesh, _save_mesh


class LocalRepairTests(unittest.TestCase):
    def fixture(self):
        v=np.array([[0.,0.,0.],[1.,0.,0.],[0.,1.,0.]])
        low=_canonical_mesh(v,[[0,1,2]])
        high=_canonical_mesh(np.vstack((v,[.5,-.0074,0.])),[[0,3,2],[3,1,2]])
        high.metadata['nativeNormalSource']='verified loader-retained source NORMAL/vn'
        return low,high

    def context(self,low):
        return {'localRepairJobId':'n3d_'+'1'*32,'localRepairStage':'lod4',
                'candidateMeshHash':mesh_hash(low.vertices,low.faces),'candidateFileSha256':'a'*64,
                'originalSourceSha256':'b'*64,'hardCap':5,'plan':{'effectiveTargetTriangles':5},'settings':{}}

    def test_parameter_pair_and_retry_exclusion(self):
        good={'localRepairJobId':'n3d_'+'1'*32,'localRepairStage':'lod4'}
        self.assertEqual(validate_parameters('source_lod',good)['localRepairStage'],'lod4')
        for value in ({'localRepairJobId':good['localRepairJobId']},{'localRepairStage':'lod4'},
                      {**good,'seed':1},{**good,'retryKeepPercent':2}):
            with self.assertRaises(Exception):validate_parameters('source_lod',value)

    def test_manual_repair_settings_defaults_bounds_and_scope(self):
        from project_store import StoreError
        manual={'localRepairJobId':'n3d_'+'1'*32,'localRepairStage':'lod4'}
        defaults={'localRepairMaxPatches':4,'localRepairDisplacementFraction':.002,'localRepairCorrectionFraction':.375}
        self.assertEqual({k:validate_parameters('source_lod',manual)[k] for k in defaults},defaults)
        self.assertTrue(all(k not in validate_parameters('source_lod',{}) for k in defaults))
        for key,default in defaults.items():
            with self.assertRaises(StoreError):validate_parameters('source_lod',{key:default})
            with self.assertRaises(StoreError):validate_parameters('uv',{key:default})
        for key,bad in [('localRepairMaxPatches',0),('localRepairMaxPatches',5),('localRepairMaxPatches',True),('localRepairDisplacementFraction',.00001),('localRepairDisplacementFraction',.011),('localRepairCorrectionFraction',.09),('localRepairCorrectionFraction',1.01)]:
            with self.assertRaises(StoreError):validate_parameters('source_lod',{**manual,key:bad})
        low,high=self.fixture();boundary=OriginalBoundaryReference(high.vertices,high.faces)
        census=audit_geometry(low.vertices,low.faces,allow_boundaries=True,collect_all_intersections=True)
        result,receipt=repair_boundary_measured(low,high,boundary,census,5,time.monotonic()+20,max_patches=1,displacement_fraction=.0001,correction_fraction=.5)
        self.assertIs(result,low);self.assertEqual(receipt['maximumCandidates'],1)
        self.assertEqual(receipt['fractions'],[.5]);self.assertEqual(receipt['localDisplacementLimitFraction'],.0001)
        self.assertEqual(receipt['localFidelityLimitFraction'],.002)
        self.assertIn('displacement cap',receipt['blocker'])

    def test_real_measured_repair_and_canonical_acceptance(self):
        low,high=self.fixture();bound=OriginalBoundaryReference(high.vertices,high.faces)
        location=locate_boundary_issue(low.vertices,low.faces,bound,time.monotonic()+10)
        self.assertTrue(any(m['classification']=='confirmed_issue' for m in location['markers']))
        with tempfile.TemporaryDirectory() as folder:
            result,manifest,_=run_local_repair(low,high,folder,{'localRepairJobId':'n3d_'+'1'*32,'localRepairStage':'lod4'},self.context(low))
            self.assertEqual(manifest['status'],'accepted',manifest.get('blocker'))
            row=manifest['stages'][0]['receipt'];repair=row['localBoundaryRepair']
            self.assertEqual(repair['profile'],'local-boundary-measured-v1')
            self.assertTrue(row['boundaryPreservation']['accepted']);self.assertTrue(row['fidelity']['accepted'])
            self.assertTrue(row['geometry']['intersectionComplete']);self.assertEqual(row['geometry']['intersection_pairs_count'],0)
            self.assertTrue(repair['candidates'][0]['sourceNormalQuality']['accepted'])
            np.testing.assert_array_equal(result.vertices[:3],low.vertices)
            self.assertEqual(len(result.faces),2)

    def test_hard_cap_retains_original_diagnostic_with_bound_markers(self):
        low,high=self.fixture();context=self.context(low);context['hardCap']=1
        with tempfile.TemporaryDirectory() as folder:
            result,manifest,_=run_local_repair(low,high,folder,{'localRepairJobId':context['localRepairJobId'],'localRepairStage':'lod4'},context)
            self.assertIs(result,low);self.assertEqual(manifest['status'],'blocked')
            row=manifest['stages'][0]
            self.assertFalse(row['eligibleForDownstream']);self.assertIn('hard cap',manifest['blocker'])
            self.assertEqual(row['receipt']['boundaryIssueMarkers']['meshHash'],context['candidateMeshHash'])

    def test_deadline_wrong_census_and_displacement_cannot_promote(self):
        low,high=self.fixture();boundary=OriginalBoundaryReference(high.vertices,high.faces)
        census=audit_geometry(low.vertices,low.faces,allow_boundaries=True,collect_all_intersections=True)
        for report,deadline in (({**census,'mesh_hash':'bad'},time.monotonic()+20),(census,time.monotonic()-1)):
            result,receipt=repair_boundary_measured(low,high,boundary,report,5,deadline)
            self.assertIs(result,low);self.assertEqual(receipt['status'],'blocked')
        high.vertices[3,1]=-.012;boundary=OriginalBoundaryReference(high.vertices,high.faces)
        result,receipt=repair_boundary_measured(low,high,boundary,census,5,time.monotonic()+20)
        self.assertIs(result,low);self.assertIn('displacement cap',receipt['blocker'])

    def test_freeze_binds_registered_final_file_and_original_high(self):
        low,high=self.fixture();ctx=self.context(low);jobid=ctx['localRepairJobId']
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);path=root/'blocked_lod4.glb';digest=_save_mesh(low,path)
            record={'stage':'lod4','status':'blocked','eligibleForDownstream':False,'diagnosticFilename':path.name,
                    'diagnosticFileSha256':digest,'mesh_hash':ctx['candidateMeshHash'],'plan':ctx['plan'],
                    'receipt':{'parentTriangles':10,'geometry':{'mesh_hash':ctx['candidateMeshHash'],'triangles':1}}}
            prior={'id':jobid,'projectId':'p','operation':'source_lod','status':'succeeded','result':{
                'files':[{'name':path.name,'role':'export','sha256':digest}],
                'metadata':{'geometry':{'sourceFileSha256':'b'*64,'stages':[record],'settings':{}}}}}
            manager=SimpleNamespace(jobs={jobid:prior},output_file=lambda *_:path)
            job={'projectId':'p','parameters':{'localRepairJobId':jobid,'localRepairStage':'lod4'},
                 'source':{'sha256':digest,'highSha256':'b'*64}}
            target=root/'request';target.mkdir();frozen=freeze_repair_context(manager,job,target)
            self.assertEqual(Path(frozen['candidatePath']).read_bytes(),path.read_bytes())
            self.assertEqual(frozen['candidateFileSha256'],digest)
            self.assertEqual(frozen['hardCap'],5)
            record['plan']['effectiveTargetTriangles']=1
            second=root/'soft';second.mkdir();self.assertEqual(freeze_repair_context(manager,job,second)['hardCap'],5)
            record['plan']['faceCap']=1
            third=root/'hard';third.mkdir();self.assertEqual(freeze_repair_context(manager,job,third)['hardCap'],1)
            record['plan'].pop('faceCap')
            custom=copy.deepcopy(job);custom['parameters'].update(localRepairMaxPatches=1,localRepairDisplacementFraction=.001,localRepairCorrectionFraction=.25)
            fourth=root/'custom';fourth.mkdir();custom_context=freeze_repair_context(manager,custom,fourth)
            self.assertEqual(custom_context['hardCap'],2)
            self.assertEqual(custom_context['targetPolicy']['maximumPatchGrowthTriangles'],1)
            self.assertEqual(custom_context['repairSettings']['localRepairCorrectionFraction'],.25)
            for mutation in ('high','input','record','registered','project','accepted'):
                altered=copy.deepcopy(job);old=copy.deepcopy(prior)
                if mutation=='high':altered['source']['highSha256']='c'*64
                if mutation=='input':altered['source']['sha256']='c'*64
                if mutation=='record':record['diagnosticFileSha256']='c'*64
                if mutation=='registered':prior['result']['files'][0]['sha256']='c'*64
                if mutation=='project':altered['projectId']='other'
                if mutation=='accepted':record['status']='accepted'
                with self.assertRaises(Exception):freeze_repair_context(manager,altered,target)
                prior.clear();prior.update(old);record=prior['result']['metadata']['geometry']['stages'][0]
            path.write_bytes(b'changed')
            with self.assertRaises(Exception):freeze_repair_context(manager,job,target)


if __name__=='__main__':unittest.main()
