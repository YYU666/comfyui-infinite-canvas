import copy
import hashlib
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from native3d_geometry_review import freeze_boundary_review,apply_review_metadata
from native3d_jobs import validate_parameters
from project_store import StoreError


class BoundaryReviewTests(unittest.TestCase):
    def fixture(self,root):
        path=root/'blocked_lod4.glb';path.write_bytes(b'canonical fixture bytes')
        sha=hashlib.sha256(path.read_bytes()).hexdigest();jid='n3d_'+'1'*32
        blocker='Original boundary distance exceeds independent shape budget: 0.101 > 0.081'
        row={'stage':'lod4','status':'blocked','eligibleForDownstream':False,'diagnosticFilename':path.name,
             'diagnosticFileSha256':sha,'mesh_hash':'a'*64,'receipt':{'geometry':{
                 'status':'accepted','mesh_hash':'a'*64,'intersectionComplete':True,'intersection_pairs_count':0}}}
        job={'id':jid,'projectId':'p','operation':'source_lod','status':'succeeded','result':{
            'files':[{'name':path.name,'role':'export','sha256':sha}],
            'metadata':{'geometry':{'status':'blocked','sourceFileSha256':'b'*64,'stages':[row],'blocker':blocker}}}}
        manager=SimpleNamespace(jobs={jid:job},output_file=lambda *_:path)
        source={'sha256':sha,'highSha256':'b'*64};params={'reviewedBoundaryJobId':jid,'reviewedBoundaryStage':'lod4'}
        return manager,source,params,job,row,path

    def test_explicit_parameters_are_paired_and_no_default_authorization(self):
        for operation in ('uv_plan','uv','bake'):
            self.assertNotIn('reviewedBoundaryJobId',validate_parameters(operation,{}))
            with self.assertRaises(StoreError):validate_parameters(operation,{'reviewedBoundaryJobId':'n3d_'+'1'*32})
            with self.assertRaises(StoreError):validate_parameters(operation,{'reviewedBoundaryStage':'lod4'})

    def test_receipt_is_experimental_does_not_promote_original_quality(self):
        with tempfile.TemporaryDirectory() as folder:
            manager,source,params,job,row,path=self.fixture(Path(folder));before=copy.deepcopy(job)
            receipt=freeze_boundary_review(manager,'p',source,params)
            self.assertEqual(receipt['geometryStatus'],'blocked');self.assertEqual(receipt['status'],'experimental_reviewed')
            self.assertEqual(job,before)
            metadata={};warnings=[];apply_review_metadata(metadata,warnings,receipt)
            self.assertEqual(metadata['geometryReview']['geometryStatus'],'blocked');self.assertIn('remains blocked',warnings[0])

    def test_hard_invalid_geometry_and_nonboundary_rejections_cannot_override(self):
        with tempfile.TemporaryDirectory() as folder:
            manager,source,params,job,row,path=self.fixture(Path(folder));audit=row['receipt']['geometry']
            for change in ({'intersectionComplete':False},{'intersection_pairs_count':1},{'status':'blocked'},{'mesh_hash':'wrong'}):
                original=copy.deepcopy(audit);audit.update(change)
                with self.assertRaises(StoreError):freeze_boundary_review(manager,'p',source,params)
                audit.clear();audit.update(original)
            geometry=job['result']['metadata']['geometry'];original=geometry['blocker']
            for blocker in ('Boundary distance upper bound could not be certified within budget','Original boundary perimeter changed by more than5percent','Nonfinite vertices'):
                geometry['blocker']=blocker
                with self.assertRaises(StoreError):freeze_boundary_review(manager,'p',source,params)
            geometry['blocker']=original
            row['receipt']['childFallback']={'attempted':True,'receipt':{'blocker':'Intersection found'}}
            with self.assertRaises(StoreError):freeze_boundary_review(manager,'p',source,params)

    def test_identity_and_registered_file_mismatch_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            manager,source,params,job,row,path=self.fixture(Path(folder))
            for project,changed in [('other',source),('p',{**source,'sha256':'c'*64}),('p',{**source,'highSha256':'c'*64})]:
                with self.assertRaises(StoreError):freeze_boundary_review(manager,project,changed,params)
            path.write_bytes(b'changed')
            with self.assertRaises(StoreError):freeze_boundary_review(manager,'p',source,params)

    def test_only_registered_derivative_with_same_review_lineage_can_bake(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);manager,source,params,job,row,path=self.fixture(root)
            receipt=freeze_boundary_review(manager,'p',source,params)
            model=root/'model.glb';model.write_bytes(b'UV derivative');sha=hashlib.sha256(model.read_bytes()).hexdigest()
            uv={'id':'uv','projectId':'p','operation':'uv','status':'succeeded','source':source,
                'result':{'metadata':{'geometryReview':receipt},'files':[{'name':'model.glb','role':'model','sha256':sha}]}}
            manager.jobs['uv']=uv;manager.output_file=lambda jid,name:model if jid=='uv' else path
            target={**source,'sha256':sha};r=freeze_boundary_review(manager,'p',target,params)
            self.assertEqual(r['derivedFromJobId'],'uv');self.assertEqual(r['geometryStatus'],'blocked')
            uv['result']['metadata']['geometryReview']['diagnosticMeshHash']='wrong'
            with self.assertRaises(StoreError):freeze_boundary_review(manager,'p',target,params)

    def test_separate_bake_material_reference_needs_explicit_hash(self):
        with tempfile.TemporaryDirectory() as folder:
            manager,source,params,job,row,path=self.fixture(Path(folder))
            material={**source,'highSha256':'c'*64}
            with self.assertRaises(StoreError):freeze_boundary_review(manager,'p',material,params,'bake')
            explicit={**params,'reviewedBoundaryBakeHighSha256':'c'*64}
            for operation in ('uv','uv_plan'):
                with self.assertRaises(StoreError):freeze_boundary_review(manager,'p',material,explicit,operation)
            receipt=freeze_boundary_review(manager,'p',material,explicit,'bake')
            self.assertEqual(receipt['originalSourceSha256'],'b'*64)
            self.assertEqual(receipt['bakeHighSha256'],'c'*64)
            self.assertEqual(receipt['geometryStatus'],'blocked')

    def test_review_parameters_are_frozen_into_uv_plan_settings(self):
        from native3d_uv_plan import settings,digest
        from native3d_jobs import Native3DJobs
        params={'reviewedBoundaryJobId':'n3d_'+'1'*32,'reviewedBoundaryStage':'lod4'}
        original=settings({});reviewed=settings(params)
        self.assertNotIn('reviewedBoundaryJobId',original)
        self.assertEqual(reviewed['reviewedBoundaryJobId'],params['reviewedBoundaryJobId'])
        self.assertNotEqual(digest(original),digest(reviewed))
        with self.assertRaises(ValueError):settings({'reviewedBoundaryStage':'lod4'})
        prior={'projectId':'p','operation':'uv_plan','status':'succeeded','parameters':params,
               'source':{'sha256':'a','highSha256':'b'},'result':{'metadata':{'uvPlan':{'planSha256':'c'}}}}
        manager=SimpleNamespace(jobs={'plan':prior})
        job={'projectId':'p','source':prior['source'],'parameters':{**params,'planJobId':'plan','planSha256':'c','reviewedBoundaryStage':'lod3'}}
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaisesRegex(StoreError,'UV settings changed'):
                Native3DJobs._snapshot_plan(manager,job,Path(folder))

    def test_worker_plan_report_retains_blocked_review_and_checks_snapshot(self):
        import trimesh
        from unittest.mock import patch
        from native3d_engine import run
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);source=root/'source.glb';trimesh.creation.box().export(source)
            sha=hashlib.sha256(source.read_bytes()).hexdigest()
            params={'reviewedBoundaryJobId':'n3d_'+'1'*32,'reviewedBoundaryStage':'lod4'}
            review={**params,'profile':'reviewed-boundary-deviation-v1','status':'experimental_reviewed',
                    'geometryStatus':'blocked','sourceSha256':sha,'originalSourceSha256':sha,
                    'originalBlocker':'Original boundary distance exceeds independent shape budget: 0.101 > 0.081'}
            request={'operation':'uv_plan','sourcePath':str(source),'highSourcePath':str(source),
                     'source':{'sha256':sha,'highSha256':sha},'parameters':params,'geometryReview':review}
            planned={'metadata':{'uvPlan':{}},'plan':{'limitations':[]},'files':[]}
            with patch('native3d_uv_plan.build_plan',return_value=planned) as build:
                result=run(request,str(root/'output'))
            self.assertEqual(build.call_args.args[3]['reviewedBoundaryJobId'],params['reviewedBoundaryJobId'])
            self.assertEqual(result['metadata']['geometryReview']['geometryStatus'],'blocked')
            self.assertTrue(any('remains blocked' in x for x in result['warnings']))
            request['geometryReview']={**review,'sourceSha256':'wrong'}
            with patch('native3d_uv_plan.build_plan') as build:
                with self.assertRaisesRegex(ValueError,'snapshot identity'):run(request,str(root/'rejected'))
                build.assert_not_called()

    def test_submit_computes_optional_high_hash_before_review_and_is_idempotent(self):
        import io,json,trimesh
        from unittest.mock import patch
        from test_native3d_jobs import Native3DJobsTests
        case=Native3DJobsTests();case.setUp()
        try:
            manager,source,params,prior,row,path=self.fixture(case.root)
            raw=trimesh.creation.box().export(file_type='glb');sha=hashlib.sha256(raw).hexdigest()
            asset=case.store.put_asset(case.doc['id'],'candidate.glb',io.BytesIO(raw))['asset']
            prior['projectId']=case.doc['id'];prior['opId']='previous';prior['result']['metadata']['geometry']['sourceFileSha256']=sha
            prior['result']['files'][0]['sha256']=sha;row['diagnosticFileSha256']=sha
            directory=case.jobs.root/prior['id']/'output';directory.mkdir(parents=True)
            (directory/'blocked_lod4.glb').write_bytes(raw);case.jobs.jobs[prior['id']]=prior
            payload={**case.payload,'operation':'uv_plan','parameters':params,
                     'source':{'assetPath':asset['path'],'highAssetPath':asset['path']}}
            before=case.store.get(case.doc['id'])
            capabilities={'operations':{'uv_plan':{'ready':True}},'sourceFormats':['.glb']}
            with patch.object(case.jobs,'capabilities',return_value=capabilities):
                submitted=case.jobs.submit(payload)
                self.assertEqual(case.jobs.submit(payload)['id'],submitted['id'])
            request=json.loads((case.jobs.root/submitted['id']/'request.json').read_text(encoding='utf-8'))
            self.assertEqual(request['source']['highSha256'],sha)
            self.assertEqual(request['geometryReview']['originalSourceSha256'],sha)
            self.assertEqual(request['geometryReview']['geometryStatus'],'blocked')
            self.assertEqual(case.store.get(case.doc['id']),before)
        finally:case.tearDown()


if __name__=='__main__':unittest.main()
