"""Registered blocked-stage previews are read-only diagnostics, never acceptance."""
import base64
import copy
import hashlib
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import test_native3d_jobs as fixtures
from project_store import StoreError


class DiagnosticStagePreviewTests(unittest.TestCase):
    def setUp(self):
        fixtures.Native3DJobsTests.setUp(self)
        self.job_id='n3d_'+'b'*32
        self.output=self.root/'jobs'/self.job_id/'output'
        self.output.mkdir(parents=True)
        self.source=self.output/'blocked_lod3.glb'
        self.source.write_bytes(b'registered diagnostic GLB fixture; renderer mocked')
        self.digest=hashlib.sha256(self.source.read_bytes()).hexdigest()
        self.record={'stage':'lod3','filename':'lod3.glb','diagnosticFilename':'blocked_lod3.glb',
                     'diagnosticFileSha256':self.digest,'status':'blocked','eligibleForDownstream':False,
                     'receipt':{'geometry':{'status':'blocked','triangles':2,'vertices':4,
                         'intersection_pairs':[[0,1]],'intersectionComplete':False}}}
        self.file={'name':'blocked_lod3.glb','role':'export','sha256':self.digest}
        self.job={'id':self.job_id,'projectId':self.doc['id'],'nodeId':'source_lod',
                  'operation':'source_lod','status':'succeeded','result':{
                      'metadata':{'geometry':{'status':'accepted','stages':[self.record]}},'files':[self.file]}}
        self.jobs.jobs[self.job_id]=self.job
        self.png=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jr1sAAAAASUVORK5CYII=')

    def tearDown(self):
        fixtures.Native3DJobsTests.tearDown(self)

    def render_stub(self,command,**kwargs):
        self.assertEqual(Path(command[command.index('--source')+1]),self.source)
        evidence=json.loads(Path(command[command.index('--diagnostic')+1]).read_text(encoding='utf-8'))
        self.assertEqual(evidence['meshSha256'],self.digest)
        self.assertEqual(evidence['intersection_pairs'],[[0,1]])
        self.assertFalse(evidence['intersectionComplete'])
        Path(command[command.index('--output')+1]).write_bytes(self.png)
        return SimpleNamespace(returncode=0)

    def test_default_rejects_blocked_and_explicit_true_renders_without_mutation(self):
        before_job=copy.deepcopy(self.job);before_project=self.store.get(self.doc['id']);before_source=self.source.read_bytes()
        with patch('native3d_jobs.subprocess.run',side_effect=self.render_stub) as run:
            with self.assertRaises(StoreError):self.jobs.stage_preview(self.job_id,'lod3')
            run.assert_not_called()
            result=self.jobs.stage_preview(self.job_id,'lod3',diagnostic=True)
            self.assertEqual(result.read_bytes(),self.png)
            self.assertIn('-diagnostic-',result.name)
            self.assertEqual(self.jobs.stage_preview(self.job_id,'lod3',diagnostic=True),result)
            self.assertEqual(run.call_count,1)
        self.assertEqual(self.job,before_job)
        self.assertEqual(self.store.get(self.doc['id']),before_project)
        self.assertEqual(self.source.read_bytes(),before_source)
        self.assertNotIn('accepted',self.record['status'])

    def test_both_registered_hashes_are_checked(self):
        for target,key in [(self.file,'sha256'),(self.record,'diagnosticFileSha256')]:
            with self.subTest(key=key),patch('native3d_jobs.subprocess.run') as run:
                old=target[key];target[key]='0'*64
                try:
                    with self.assertRaises(StoreError):self.jobs.stage_preview(self.job_id,'lod3',diagnostic=True)
                    run.assert_not_called()
                finally:target[key]=old
        self.source.write_bytes(self.source.read_bytes()+b'changed')
        with patch('native3d_jobs.subprocess.run') as run:
            with self.assertRaises(StoreError):self.jobs.stage_preview(self.job_id,'lod3',diagnostic=True)
            run.assert_not_called()

    def test_status_eligibility_and_explicit_boolean_required(self):
        cases=[(self.record,'status','accepted'),(self.record,'eligibleForDownstream',True),
               (self.record,'eligibleForDownstream',None),(self.job,'status','failed'),
               (self.job,'operation','repair_lod'),(self.record,'diagnosticFilename','blocked_lod2.glb')]
        for target,key,value in cases:
            with self.subTest(key=key,value=value),patch('native3d_jobs.subprocess.run') as run:
                old=target[key];target[key]=value
                try:
                    with self.assertRaises(StoreError):self.jobs.stage_preview(self.job_id,'lod3',diagnostic=True)
                    run.assert_not_called()
                finally:target[key]=old
        for invalid in ('true',1,None):
            with self.subTest(flag=invalid),self.assertRaises(StoreError):
                self.jobs.stage_preview(self.job_id,'lod3',diagnostic=invalid)

    def test_unregistered_or_duplicate_artifacts_rejected(self):
        for entries in ([],[self.file,self.file]):
            self.job['result']['files']=entries
            with self.assertRaises(StoreError):self.jobs.stage_preview(self.job_id,'lod3',diagnostic=True)

    def configure_single_failed_retry(self):
        target=self.output/'blocked_lod1.glb';self.source.rename(target);self.source=target
        self.record.update(stage='lod1',filename=None,diagnosticFilename='blocked_lod1.glb')
        self.file['name']='blocked_lod1.glb'
        self.job['result']['metadata']['geometry'].update(status='blocked',chainStatus='blocked',chainComplete=False)

    def test_single_failed_retry_diagnostic_renders_without_promoting_stage(self):
        self.configure_single_failed_retry()
        before=copy.deepcopy(self.job);project=self.store.get(self.doc['id']);source=self.source.read_bytes()
        with patch('native3d_jobs.subprocess.run',side_effect=self.render_stub) as run:
            with self.assertRaises(StoreError):self.jobs.stage_preview(self.job_id,'lod1')
            run.assert_not_called()
            result=self.jobs.stage_preview(self.job_id,'lod1',diagnostic=True)
            self.assertEqual(result.read_bytes(),self.png);self.assertEqual(run.call_count,1)
        self.assertEqual(self.job,before);self.assertEqual(self.store.get(self.doc['id']),project)
        self.assertEqual(self.source.read_bytes(),source)
        from native3d_jobs import accepted_source_lod_stage
        self.assertFalse(accepted_source_lod_stage(self.record))

    def test_single_failed_retry_unregistered_or_forged_hashes_still_rejected(self):
        self.configure_single_failed_retry()
        for entries in ([],[self.file,self.file]):
            self.job['result']['files']=entries
            with patch('native3d_jobs.subprocess.run') as run:
                with self.assertRaises(StoreError):self.jobs.stage_preview(self.job_id,'lod1',diagnostic=True)
                run.assert_not_called()
        self.job['result']['files']=[self.file]
        for target,key in ((self.file,'sha256'),(self.record,'diagnosticFileSha256')):
            with self.subTest(key=key),patch('native3d_jobs.subprocess.run') as run:
                old=target[key];target[key]='0'*64
                try:
                    with self.assertRaises(StoreError):self.jobs.stage_preview(self.job_id,'lod1',diagnostic=True)
                    run.assert_not_called()
                finally:target[key]=old

    def test_ordinary_preview_still_requires_overall_accepted_geometry(self):
        self.job['result']['metadata']['geometry']['status']='blocked'
        self.record.update(status='accepted',eligibleForDownstream=True)
        self.record['receipt'].update(geometry={'status':'accepted','intersectionComplete':True,'intersection_pairs_count':0,'mesh_hash':'fixture'},fidelity={'accepted':True})
        self.record['mesh_hash']='fixture';self.record['filename']=self.source.name.replace('blocked_','')
        normal=self.output/self.record['filename'];normal.write_bytes(self.source.read_bytes())
        self.job['result']['files']=[{'name':normal.name,'role':'export','sha256':self.digest}]
        with patch('native3d_jobs.subprocess.run') as run:
            with self.assertRaises(StoreError):self.jobs.stage_preview(self.job_id,'lod3')
            run.assert_not_called()

    def test_renderer_rejects_wrong_triangle_indices(self):
        import trimesh
        from native3d_lod_diagnostic import render_diagnostic
        mesh=trimesh.Trimesh([[0,0,0],[1,0,0],[0,1,0]],[[0,1,2]],process=False)
        for pairs in ([[0,1]],[[-1,0]],[[False,0]],[[0.0,0]],[[0]]):
            with self.subTest(pairs=pairs),self.assertRaisesRegex(ValueError,'triangle index'):
                render_diagnostic(mesh,{'triangles':1,'intersection_pairs':pairs})
        with self.assertRaisesRegex(ValueError,'triangle identity'):
            render_diagnostic(mesh,{'triangles':2,'intersection_pairs':[]})

    def test_renderer_failure_never_changes_job_or_project(self):
        before=copy.deepcopy(self.job);project=self.store.get(self.doc['id'])
        with patch('native3d_jobs.subprocess.run',return_value=SimpleNamespace(returncode=1)):
            with self.assertRaises(StoreError):self.jobs.stage_preview(self.job_id,'lod3',diagnostic=True)
        self.assertEqual(self.job,before);self.assertEqual(self.store.get(self.doc['id']),project)


if __name__=='__main__':unittest.main()
