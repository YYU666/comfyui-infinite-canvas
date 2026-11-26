import copy
import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from native3d_jobs import Native3DJobs, validate_parameters
from project_store import ProjectStore, StoreError


class PlanIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
        self.store=ProjectStore(self.root/'projects');self.doc=self.store.create('plan fixture')
        self.jobs=Native3DJobs(self.root/'jobs',self.store,autostart=False)
        self.planid='n3d_'+'a'*32
        out=self.root/'jobs'/self.planid/'output';out.mkdir(parents=True)
        file=out/'uv-plan.json';file.write_text('{}')
        self.digest=hashlib.sha256(file.read_bytes()).hexdigest()
        self.params=validate_parameters('uv',{'planJobId':self.planid,'planSha256':'b'*64})
        self.prior={'id':self.planid,'projectId':self.doc['id'],'operation':'uv_plan','status':'succeeded',
                    'source':{'sha256':'c'*64,'highSha256':'d'*64},'parameters':dict(self.params),
                    'result':{'metadata':{'uvPlan':{'planSha256':'b'*64}},'files':[
                        {'name':'uv-plan.json','role':'plan','sha256':self.digest}]}}
        self.jobs.jobs[self.planid]=self.prior
        self.job={'projectId':self.doc['id'],'parameters':self.params,'source':dict(self.prior['source'])}
        self.directory=self.root/'snapshot';self.directory.mkdir()

    def tearDown(self):
        self.jobs.close();self.store.close();self.tmp.cleanup()

    def test_snapshot_copies_only_registered_pinned_artifact(self):
        path=self.jobs._snapshot_plan(self.job,self.directory)
        self.assertEqual(path.read_text(),'{}')
        (self.root/'jobs'/self.planid/'output/uv-plan.json').write_text('changed')
        self.assertEqual(path.read_text(),'{}')

    def test_rejects_cross_project_changed_settings_source_or_confirmation(self):
        for change in ('project','resolution','source','confirmation','file'):
            with self.subTest(change=change):
                job=copy.deepcopy(self.job)
                if change=='project':job['projectId']='other'
                if change=='resolution':job['parameters']['resolution']=4096
                if change=='source':job['source']['sha256']='e'*64
                if change=='confirmation':job['parameters']['planSha256']='e'*64
                if change=='file':(self.root/'jobs'/self.planid/'output/uv-plan.json').write_text('changed')
                folder=self.root/change;folder.mkdir()
                with self.assertRaises(StoreError):self.jobs._snapshot_plan(job,folder)

    def test_percentage_and_plan_schema(self):
        values=validate_parameters('source_lod',{})
        self.assertEqual(values['lod4KeepPercent'],6.25)
        for params in ({'lod2KeepPercent':80},{'lod0KeepPercent':float('nan')},{'lod0FaceCap':True}):
            with self.assertRaises(StoreError):validate_parameters('source_lod',params)
        with self.assertRaises(StoreError):validate_parameters('uv',{'planJobId':self.planid})
        with self.assertRaises(StoreError):validate_parameters('uv_plan',{'runtimePath':'C:/untrusted'})

    def test_structural_plan_schema_and_legacy_confirmation(self):
        plan=validate_parameters('uv_plan',{})
        self.assertEqual(plan['seamPlanningMode'],'ai_structure_ao_v2')
        self.assertEqual(plan['convexAngleDegrees'],45)
        self.assertEqual(plan['concaveAngleDegrees'],45)
        self.assertEqual(plan['aoDarknessThreshold'],0.2)
        self.assertNotIn('seamPlanningMode',validate_parameters('uv',{}))
        self.job['parameters']['concaveAngleDegrees']=25
        self.assertTrue(self.jobs._snapshot_plan(self.job,self.directory).is_file())
        for key,value in [('seamPlanningMode','ai_structure_ao_v2'),('convexAngleDegrees',45),('concaveAngleDegrees',45)]:
            with self.subTest(key=key):
                job=copy.deepcopy(self.job);job['parameters'][key]=value
                folder=self.root/('new-setting-'+key);folder.mkdir()
                with self.assertRaises(StoreError):self.jobs._snapshot_plan(job,folder)

    def test_structural_plan_settings_are_frozen(self):
        fields={'seamPlanningMode':'ai_structure_ao_v2','convexAngleDegrees':45,
                'concaveAngleDegrees':45,'structureScaleFraction':0.02,'structureMinChainLengthFraction':0.04}
        self.prior['parameters'].update(fields);self.job['parameters'].update(fields)
        self.assertTrue(self.jobs._snapshot_plan(self.job,self.directory).is_file())
        job=copy.deepcopy(self.job);job['parameters']['convexAngleDegrees']=50
        folder=self.root/'changed-structural-plan';folder.mkdir()
        with self.assertRaises(StoreError):self.jobs._snapshot_plan(job,folder)

    def test_source_lod_provenance_requires_accepted_actual_stage(self):
        self.jobs.jobs['lod']={'status':'succeeded','operation':'source_lod','result':{
            'metadata':{'geometry':{'status':'accepted','selectedLodLevel':0,'stages':[{'stage':'lod0','mesh_hash':'x','visible':True,'status':'accepted','eligibleForDownstream':True,'receipt':{'geometry':{'status':'accepted','intersectionComplete':True,'intersection_pairs_count':0,'mesh_hash':'x'},'fidelity':{'accepted':True}}}]}},
            'files':[{'name':'model.glb','role':'model','sha256':'f'*64}]}}
        self.assertEqual(self.jobs._geometry_origin('f'*64),'accepted')
        self.jobs.jobs['lod']['result']['files'].append({'name':'proxy.glb','role':'proxy','sha256':'f'*64})
        self.assertEqual(self.jobs._geometry_origin('f'*64),'accepted')
        self.jobs.jobs['lod']['result']['metadata']['geometry']['status']='blocked'
        self.assertEqual(self.jobs._geometry_origin('f'*64),'external')
        other=copy.deepcopy(self.jobs.jobs['lod']);other['result']['metadata']['geometry']['status']='accepted'
        self.jobs.jobs['verified']=other
        self.assertEqual(self.jobs._geometry_origin('f'*64),'accepted')
        self.jobs.jobs['lod']['result']['metadata']['geometry']['stages'][0]['status']='blocked'
        self.assertEqual(self.jobs._geometry_origin('f'*64),'blocked')

    def test_passive_plan_upload_whitelist_and_digest(self):
        from workbench_security import valid_content_type
        headers={'Content-Length':'100','Content-Type':'application/json'}
        self.assertTrue(valid_content_type('PUT','/api/projects/prj_test/assets/uv-plan.json',headers))
        self.assertFalse(valid_content_type('PUT','/api/projects/prj_test/assets/arbitrary.json',headers))
        plan={'kind':'native3d_uv_plan','version':1,'source':{},'settings':{},'overlay':{},'evidence':{}}
        plan['planSha256']=hashlib.sha256(json.dumps(plan,sort_keys=True,separators=(',',':')).encode()).hexdigest()
        result=self.store.put_asset(self.doc['id'],'uv-plan.json',io.BytesIO(json.dumps(plan).encode()))
        self.assertEqual(result['asset']['mime'],'application/octet-stream')
        plan['settings']['bad']=True
        with self.assertRaises(StoreError):self.store.put_asset(self.doc['id'],'uv-plan.json',io.BytesIO(json.dumps(plan).encode()))
        with self.assertRaises(StoreError):self.store.put_asset(self.doc['id'],'anything.bin',io.BytesIO(b'1234'))
        with self.assertRaises(StoreError):self.store.put_asset(self.doc['id'],'uv-plan-overlay.bin',io.BytesIO(b'123'))

    def test_engine_plan_finishes_without_export_or_unwrap(self):
        import trimesh
        from native3d_engine import run
        source=self.root/'source.glb';source.write_bytes(trimesh.creation.box().export(file_type='glb'))
        planned={'metadata':{'uvPlan':{'planSha256':'b'*64}},'plan':{'limitations':['research']},'files':[]}
        with patch('native3d_uv_plan.build_plan',return_value=planned) as planner,patch('native3d_engine.export_glb',side_effect=AssertionError('planner exported mesh')):
            result=run({'operation':'uv_plan','sourcePath':str(source),'highSourcePath':str(source),
                        'parameters':{'externalGeometryReviewed':True,'resolution':4096,
                            'seamPlanningMode':'ai_structure_ao_v2','convexAngleDegrees':45,
                            'concaveAngleDegrees':45,'structureScaleFraction':0.02,
                            'structureMinChainLengthFraction':0.04}},self.root/'planned')
        self.assertFalse(result['quality']['unwrapExecuted'])
        self.assertNotIn('externalGeometryReviewed',planner.call_args.args[3])
        self.assertEqual(planner.call_args.args[3]['seamPlanningMode'],'ai_structure_ao_v2')
        self.assertEqual(planner.call_args.args[3]['convexAngleDegrees'],45)
        self.assertEqual(planner.call_args.args[3]['structureScaleFraction'],0.02)
        self.assertFalse((self.root/'planned/model.glb').exists())

    def test_engine_rejects_frozen_settings_changed_even_direct_worker(self):
        import trimesh
        from native3d_engine import run
        source=self.root/'source.glb';source.write_bytes(trimesh.creation.box().export(file_type='glb'))
        plan={'settings':{'resolution':4096}}
        with patch('native3d_uv_plan.load_plan',return_value=plan),patch('native3d_uv_plan.unwrap_plan',side_effect=AssertionError('must reject before compute')):
            with self.assertRaisesRegex(ValueError,'UV_PLAN_STALE'):
                run({'operation':'uv','sourcePath':str(source),'highSourcePath':str(source),
                     'uvPlanPath':str(self.root/'pinned.json'),'parameters':{'resolution':1024,'planSha256':'b'*64}},self.root/'stale-worker')

