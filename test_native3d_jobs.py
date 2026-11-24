import io
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
from native3d_jobs import Native3DJobs, validate_parameters
from project_store import ProjectStore, StoreError

class Native3DJobsTests(unittest.TestCase):
    def test_failed_uv_diagnostic_png_whitelist_and_identity(self):
        import base64
        job_id='n3d_'+'d'*32
        job={'id':job_id,'projectId':self.doc['id'],'nodeId':'failed_uv','operation':'uv','status':'failed'}
        self.jobs.jobs[job_id]=job
        output=self.root/'jobs'/job_id/'output';output.mkdir(parents=True)
        png=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jr1sAAAAASUVORK5CYII=')
        (output/'uv-rejected-atlas.png').write_bytes(png)
        (output/'uv-rejected-checker.png').write_bytes(png)
        report=output/'uv-rejected-report.json'
        report.write_text(json.dumps({'status':'rejected_needs_review','acceptedUV':False,'bakeAllowed':False}))
        self.assertEqual(self.jobs.diagnostic_preview(job_id,'layout',self.doc['id'],'failed_uv').name,'uv-rejected-atlas.png')
        self.assertEqual(self.jobs.diagnostic_preview(job_id,'checker',self.doc['id'],'failed_uv').name,'uv-rejected-checker.png')
        for mode,project,node in [('layout','prj_other','failed_uv'),('layout',self.doc['id'],'wrong'),('../request.json',self.doc['id'],'failed_uv')]:
            with self.assertRaises(StoreError):self.jobs.diagnostic_preview(job_id,mode,project,node)
        for key,value in [('operation','bake'),('status','succeeded')]:
            original=job[key];job[key]=value
            with self.assertRaises(StoreError):self.jobs.diagnostic_preview(job_id,'layout',self.doc['id'],'failed_uv')
            job[key]=original
        report.write_text(json.dumps({'status':'rejected_needs_review','acceptedUV':True,'bakeAllowed':False}))
        with self.assertRaises(StoreError):self.jobs.diagnostic_preview(job_id,'layout',self.doc['id'],'failed_uv')
        self.assertEqual(job['status'],'failed');self.assertNotIn('result',job)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.store = ProjectStore(self.root / 'projects')
        self.doc = self.store.create('fixture')
        self.asset = self.store.put_asset(self.doc['id'], 'fixture.obj', io.BytesIO(b'v 0 0 0\n'))['asset']
        self.config = self.root / 'native3d-config.json'
        self.config.write_text(json.dumps({'pythonExecutable':sys.executable}))
        self.engine = self.root / 'engine.py'
        self.engine.write_text("import argparse,json,pathlib,time\np=argparse.ArgumentParser();p.add_argument('--request');p.add_argument('--output');a=p.parse_args();r=json.load(open(a.request));o=pathlib.Path(a.output)\nif r['nodeId']=='sleep': time.sleep(20)\n(o/'mesh.obj').write_text('v 0 0 0');(o/'result.json').write_text(json.dumps({'metadata':{},'quality':{},'files':[{'name':'mesh.obj','role':'model','mime':'text/plain'}],'warnings':[]}))\n")
        self.jobs = Native3DJobs(self.root / 'jobs', self.store, self.config, self.engine, autostart=False)
        self.jobs._probe = lambda python, modules: []
        self.payload = {'opId':'test_1','projectId':self.doc['id'],'nodeId':'node_1','operation':'analyze','source':{'assetPath':self.asset['path']},'parameters':{}}
    def tearDown(self):
        self.jobs.close()
        self.store.close()
        self.temp.cleanup()
    def test_glb_layout_preflight_checks_registered_model_and_high(self):
        import struct
        def asset(materials, counts):
            document = json.dumps({'materials': [{}]*materials, 'meshes': [
                {'primitives': [{}]*count} for count in counts]}).encode()
            glb = struct.pack('<4sIIII', b'glTF', 2, 20+len(document), len(document), 0x4e4f534a) + document
            return self.store.put_asset(self.doc['id'], 'layout.glb', io.BytesIO(glb))['asset']['path']

        for materials, counts in [(3,[3]), (1,[2]), (3,[1,2])]:
            path = asset(materials, counts)
            for field, role in [('assetPath','model'),('highAssetPath','high')]:
                with self.subTest(materials=materials, counts=counts, role=role):
                    source = {**self.payload['source'], field:path}
                    with self.assertRaises(StoreError) as error:
                        self.jobs.submit({**self.payload, 'source':source})
                    self.assertEqual(error.exception.code, 'NATIVE3D_GLB_LAYOUT_UNSUPPORTED')
                    self.assertEqual(error.exception.details['materialCount'], materials)
                    self.assertEqual(error.exception.details['meshPrimitiveCounts'], counts)
                    self.assertEqual(error.exception.details['inputRole'], role)
        path = asset(1, [1])
        job = self.jobs.submit({**self.payload, 'source':{'assetPath':path}})
        self.assertEqual(job['status'], 'queued')

    def test_snapshot_idempotence_and_project_unchanged(self):
        before = self.store.get(self.doc['id'])
        job = self.jobs.submit(self.payload)
        self.assertEqual(job['id'], self.jobs.submit(self.payload)['id'])
        self.assertEqual(before, self.store.get(self.doc['id']))
        self.assertEqual(self.asset['sha256'], job['source']['sha256'])
        self.payload['nodeId'] = 'different'
        with self.assertRaises(StoreError) as error:
            self.jobs.submit(self.payload)
        self.assertEqual(409,error.exception.status)
    def test_saved_canvas_claim_is_required_before_one_durable_dispatch(self):
        from contextlib import contextmanager
        project_id = self.doc["id"]
        payload = {**self.payload,"operation":"source_lod","parameters":{"lodCount":2},
                   "source":{**self.payload["source"],"highAssetPath":self.asset["path"]}}
        page = {"origin":"agent",**{key:payload[key] for key in ("projectId","nodeId","opId")}}
        proof = {"epoch":"epoch_1","sessionId":"session_1","opId":payload["opId"]}
        active = True
        @contextmanager
        def live_page():
            if not active:
                raise StoreError("NO_VISIBLE_CANVAS","page closed",409)
            yield
        claim = (page, proof, live_page)
        with self.assertRaises(StoreError) as unsaved:
            self.jobs.submit(payload, canvas_submission=claim)
        self.assertEqual(unsaved.exception.code, "NATIVE3D_CANVAS_MISMATCH")
        document = self.store.get(project_id)
        source = {"id":"generated","type":"media","position":{"x":0,"y":0},
                  "data":{"kind":"model","assetPath":self.asset["path"]}}
        node = {"id":payload["nodeId"],"type":"native3d","position":{"x":300,"y":0},
                "data":{"operation":"source_lod","status":"submitting","nativeRun":{
                    "opId":payload["opId"],"requestOrigin":"agent","page":proof,"submission":payload,
                    "parameters":payload["parameters"],"sourceId":"generated","sourceAssetPath":self.asset["path"]}}}
        document["canvas"]["nodes"] = [source,node]
        document["canvas"]["edges"] = [{"id":"edge_1","source":"generated","target":node["id"],
                                         "sourceHandle":"model","targetHandle":"model"}]
        self.store.save(project_id, document, document["revision"])
        with self.assertRaises(StoreError) as altered:
            self.jobs.submit({**payload, "parameters":{"lodCount":3}}, canvas_submission=claim)
        self.assertEqual(altered.exception.code, "NATIVE3D_CANVAS_MISMATCH")
        active = False
        with self.assertRaises(StoreError) as closed:
            self.jobs.submit(payload, canvas_submission=claim)
        self.assertEqual(closed.exception.code, "NO_VISIBLE_CANVAS")
        self.assertEqual(list((self.root/"jobs").glob("n3d_*")),[])
        from canvas_page_bridge import CanvasPageBridge
        bridge = CanvasPageBridge()
        bridge.epoch = proof["epoch"]
        bridge.heartbeat({"sessionId":proof["sessionId"],"projectId":project_id,"visible":True})
        self.assertEqual(self.jobs.submission_status(project_id, node["id"], payload["opId"], bridge),{"status":"pending"})
        bridge.release({"sessionId":proof["sessionId"]})
        self.assertEqual(self.jobs.submission_status(project_id, node["id"], payload["opId"], bridge),{"status":"not_submitted"})
        active = True
        accepted = self.jobs.submit(payload, canvas_submission=claim)
        self.assertEqual(accepted["canvasSubmission"],page)
        self.assertEqual(self.jobs.submit(payload, canvas_submission=claim)["id"],accepted["id"])
        with self.assertRaises(StoreError) as replay:
            self.jobs.submit({**payload,"parameters":{"lodCount":3}}, canvas_submission=claim)
        self.assertEqual(replay.exception.code,"OP_ID_CONFLICT")
        active = False
        durable = self.jobs.list(project_id)
        self.assertEqual([job["id"] for job in durable],[accepted["id"]])
        self.assertEqual(durable[0]["parameters"]["lodCount"],2)
        self.assertEqual(self.jobs.submission_status(project_id, node["id"], payload["opId"], bridge)["job"]["id"],accepted["id"])
        self.assertTrue((self.root/"jobs"/accepted["id"]/"manifest.json").is_file())

    def test_source_traversal_and_hash(self):
        self.payload['source']['assetPath'] = 'assets/../../evil.obj'
        with self.assertRaises(StoreError): self.jobs.submit(self.payload)
        self.payload['source'] = {'assetPath':self.asset['path'],'sha256':'0'*64}
        with self.assertRaises(StoreError): self.jobs.submit(self.payload)
    def test_result_and_file_allowlist(self):
        job = self.jobs.submit(self.payload)
        self.jobs._run(self.jobs.jobs[job['id']])
        done = self.jobs.get(job['id'])
        self.assertEqual('succeeded', done['status'],done)
        self.assertTrue(self.jobs.output_file(job['id'],'mesh.obj').is_file())
        with self.assertRaises(StoreError): self.jobs.output_file(job['id'],'../request.json')
        with self.assertRaises(StoreError): self.jobs.output_file(job['id'],'result.json')

    def test_fbx_runtime_gate_and_immutable_snapshot(self):
        asset = self.store.put_asset(self.doc['id'], 'fixture.fbx', io.BytesIO(b'opaque FBX asset'))['asset']
        self.payload['source'] = {'assetPath': asset['path']}
        with patch('native3d_jobs.fbx_capabilities', return_value={'available': False}):
            self.assertNotIn('.fbx', self.jobs.capabilities()['sourceFormats'])
            with self.assertRaises(StoreError) as error:
                self.jobs.submit(self.payload)
            self.assertEqual(error.exception.code, 'NATIVE3D_FBX_NOT_READY')
        with patch('native3d_jobs.fbx_capabilities', return_value={'available': True, 'scope': 'bounded fixture'}):
            self.assertIn('.fbx', self.jobs.capabilities()['sourceFormats'])
            job = self.jobs.submit(self.payload)
        request = json.loads((self.root/'jobs'/job['id']/'request.json').read_text())
        self.assertEqual(Path(request['sourcePath']).suffix, '.fbx')
        self.assertEqual(Path(request['sourcePath']).read_bytes(), b'opaque FBX asset')

    def test_fbx_export_role_only(self):
        for role in ['export', 'model', 'proxy']:
            self.payload['opId'] = 'fbx_' + role
            self.engine.write_text("import argparse,json,pathlib\np=argparse.ArgumentParser();p.add_argument('--request');p.add_argument('--output');a=p.parse_args();o=pathlib.Path(a.output)\n(o/'mesh.fbx').write_bytes(b'fixture');(o/'result.json').write_text(json.dumps({'metadata':{},'quality':{},'files':[{'name':'mesh.fbx','role':%r,'mime':'application/octet-stream'}],'warnings':[]}))\n" % role)
            job = self.jobs.submit(self.payload)
            self.jobs._run(self.jobs.jobs[job['id']])
            self.assertEqual(self.jobs.get(job['id'])['status'], 'succeeded' if role == 'export' else 'failed')
    def test_restart_does_not_rerun(self):
        job = self.jobs.submit(self.payload)
        restarted = Native3DJobs(self.root/'jobs',self.store,self.config,self.engine,autostart=False)
        self.assertEqual('failed', restarted.get(job['id'])['status'])
        self.assertEqual('interrupted', restarted.get(job['id'])['stage'])
        restarted.close()
    def test_cancel_running_own_process(self):
        import threading
        self.payload['nodeId'] = 'sleep'
        job = self.jobs.submit(self.payload)
        thread = threading.Thread(target=self.jobs._run,args=(self.jobs.jobs[job['id']],))
        thread.start()
        deadline=time.time()+5
        while self.jobs.get(job['id'])['status']=='queued' and time.time()<deadline: time.sleep(.01)
        self.jobs.cancel(job['id'])
        thread.join(5)
        self.assertFalse(thread.is_alive())
        self.assertEqual('cancelled', self.jobs.get(job['id'])['status'])
    def test_strict_schema_before_compute(self):
        for operation, parameters in [('analyze', {'shell':'x'}), ('uv', {'padding':33}), ('bake',{'aoSamples':1}), ('ai_lowpoly', {'seed':True})]:
            self.payload.update(operation=operation,parameters=parameters)
            with self.assertRaises(StoreError): self.jobs.submit(self.payload)
        self.assertEqual([], list((self.root/'jobs').glob('n3d_*')))

    def test_high_source_snapshot(self):
        self.payload.update(operation='bake')
        self.payload['parameters']={'externalGeometryReviewed':True}
        self.payload['source']['highAssetPath'] = self.asset['path']
        job = self.jobs.submit(self.payload)
        request = json.loads((self.root/'jobs'/job['id']/'request.json').read_text())
        self.assertTrue(Path(request['highSourcePath']).is_file())
        self.assertEqual(self.asset['sha256'],job['source']['highSha256'])

    def test_repair_high_source_snapshot(self):
        self.payload.update(operation='repair_lod')
        self.payload['source']['highAssetPath']=self.asset['path']
        job=self.jobs.submit(self.payload)
        request=json.loads((self.root/'jobs'/job['id']/'request.json').read_text())
        self.assertTrue(Path(request['highSourcePath']).is_file())
        self.assertEqual(job['source']['highSha256'],self.asset['sha256'])
        self.assertEqual(job['parameters']['selectedLod'],800)

    def test_conditioning_and_lod_schema(self):
        self.assertEqual(validate_parameters('ai_lowpoly',{})['conditioningProfile'],'legacy_world_fp16')
        self.assertEqual(validate_parameters('ai_lowpoly',{'conditioningProfile':'legacy_world_fp16'})['conditioningProfile'],'legacy_world_fp16')
        for op,values in [('ai_lowpoly',{'conditioningProfile':'anything'}),('repair_lod',{'reviewedBoundaryMeshHash':'approve'}),('repair_lod',{'lod2':1400}),('repair_lod',{'selectedLod':777}),('repair_lod',{'lod1':True})]:
            with self.assertRaises(StoreError):validate_parameters(op,values)
        self.assertEqual(validate_parameters('repair_lod',{'reviewedBoundaryMeshHash':'a'*64})['reviewedBoundaryMeshHash'],'a'*64)

    def test_explicit_repair_plan_schema_is_bounded(self):
        plan=json.dumps({'version':1,'sourceMeshHash':'a'*64,'patches':[],'remainingBoundaryEdges':[]})
        valid=validate_parameters('repair_lod',{'reviewedRepairPlan':plan,'reviewedBoundaryMeshHash':'a'*64,'fitBoundaryMode':'reviewed_bounded'})
        self.assertEqual(valid['reviewedRepairPlan'],plan)
        self.assertEqual(validate_parameters('repair_lod',{})['fitBoundaryMode'],'fixed')
        for values in [{'fitBoundaryMode':'reviewed_bounded'}, {'reviewedRepairPlan':'x'*16385},
                       {'reviewedRepairPlan':'['*1100+'0'+']'*1100}, {'reviewedRepairPlan':'{}'},
                       {'reviewedRepairPlan':json.dumps({'version':True,'sourceMeshHash':'a'*64})}]:
            with self.subTest(values=str(values)[:80]),self.assertRaises(StoreError):
                validate_parameters('repair_lod',values)

    def test_blocked_geometry_cannot_submit_uv(self):
        document=self.store.get(self.doc['id'])
        document['nodes']=[{'id':'diagnostic','type':'native3d','data':{'assetPath':self.asset['path'],'metadata':{'geometry':{'status':'blocked'}}}}]
        self.payload.update(operation='uv')
        with patch.object(self.store,'get',return_value=document):
            with self.assertRaises(StoreError) as error:self.jobs.submit(self.payload)
        self.assertEqual(error.exception.code,'GEOMETRY_BLOCKED')

    def test_hash_provenance_survives_node_metadata_removal(self):
        self.jobs.jobs['historical']={'id':'historical','projectId':self.doc['id'],'opId':'older','status':'succeeded','operation':'ai_lowpoly','source':{},'result':{'metadata':{},'files':[{'name':'model.glb','role':'model','sha256':self.asset['sha256']}]}}
        self.payload.update(operation='uv',parameters={'externalGeometryReviewed':True})
        with self.assertRaises(StoreError) as error:self.jobs.submit(self.payload)
        self.assertEqual(error.exception.code,'GEOMETRY_BLOCKED')

    def test_accepted_selected_lod_and_uv_ancestry(self):
        geometry={'status':'accepted','selectedLod':800,'stages':[{'stage':'lod_800','mesh_hash':'f'*64}]}
        self.jobs.jobs['accepted']={'id':'accepted','status':'succeeded','operation':'repair_lod','result':{'metadata':{'geometry':geometry},'files':[{'name':'model.glb','role':'model','sha256':'a'*64},{'name':'raw_ai.glb','role':'export','sha256':'b'*64}]}}
        self.assertEqual(self.jobs._geometry_origin('a'*64),'accepted')
        self.assertEqual(self.jobs._geometry_origin('b'*64),'blocked')
        self.jobs.jobs['uv']={'id':'uv','status':'succeeded','operation':'uv','source':{'sha256':'a'*64},'result':{'files':[{'name':'model.glb','role':'model','sha256':'c'*64}]}}
        self.assertEqual(self.jobs._geometry_origin('c'*64),'accepted')

    def test_each_accepted_fit_lod_export_requires_recorded_stage(self):
        geometry={'status':'accepted','selectedLod':800,'stages':[{'stage':name,'filename':name+'.glb','mesh_hash':'f'*64} for name in ['fit','lod_1200','lod_800','lod_500','lod_300']]}
        files=[{'name':name+'.glb','role':'export','sha256':str(i)*64} for i,name in enumerate(['fit','lod_1200','lod_800','lod_500','lod_300','raw_ai','repair','lod_123'],1)]
        self.jobs.jobs['chain']={'id':'chain','status':'succeeded','operation':'repair_lod','result':{'metadata':{'geometry':geometry},'files':files}}
        for i in range(1,6):self.assertEqual(self.jobs._geometry_origin(str(i)*64),'accepted')
        for i in range(6,9):self.assertEqual(self.jobs._geometry_origin(str(i)*64),'blocked')
        geometry['status']='blocked'
        self.assertEqual(self.jobs._geometry_origin('1'*64),'blocked')

    def test_corrupt_manifest_retained_without_crashing_service(self):
        broken = self.root/'jobs'/('n3d_'+'0'*32)
        broken.mkdir()
        manifest = broken/'manifest.json'
        manifest.write_text('{broken')
        restarted = Native3DJobs(self.root/'jobs',self.store,self.config,self.engine,autostart=False)
        self.assertEqual({}, restarted.jobs)
        self.assertEqual(1,len(restarted.recovery_warnings))
        self.assertEqual('{broken',manifest.read_text())
        restarted.close()

    def test_malformed_runtime_returns_not_ready(self):
        self.config.write_text('{broken')
        capabilities = self.jobs.capabilities()
        self.assertFalse(capabilities['ready'])
        self.assertIn('malformed',capabilities['operations']['analyze']['reason'])
        self.config.write_text('[]')
        self.assertFalse(self.jobs.capabilities()['ready'])

    def test_actionable_worker_error_is_bounded_and_scrubbed(self):
        self.engine.write_text("import sys,json; print(json.dumps({'error':'Unsupported material at C:/private/mesh.glb'}),file=sys.stderr);sys.exit(1)")
        job = self.jobs.submit(self.payload)
        self.jobs._run(self.jobs.jobs[job['id']])
        error = self.jobs.get(job['id'])['error']
        self.assertIn('Unsupported material',error)
        self.assertNotIn('C:/private',error)
        self.assertLessEqual(len(error),1000)

    def test_mc256_preparation_required_without_direct_sampling_fallback(self):
        runtime = self.root/'ai-runtime'
        runtime.mkdir()
        (runtime/'load_cpu.py').write_text('# fixture')
        checkpoint = self.root/'checkpoint.pt'
        checkpoint.write_bytes(b'fixture')
        core = self.root/'core.cp39-win_amd64.pyd'
        core.write_bytes(b'fixture')
        adapter = {'meshanythingRuntime':str(runtime),'checkpoint':str(checkpoint),
                   'checkpointSha256':'a'*64,'pythonExecutable':sys.executable}
        config = {'pythonExecutable':sys.executable,'adapterConfig':adapter}
        self.config.write_text(json.dumps(config))
        capability = self.jobs.capabilities()
        self.assertTrue(capability['operations']['analyze']['ready'])
        self.assertFalse(capability['operations']['ai_lowpoly']['ready'])
        self.assertIn('mesh2sdfPythonExecutable',capability['operations']['ai_lowpoly']['reason'])
        self.assertIn('mesh2sdfCoreSha256',capability['operations']['ai_lowpoly']['reason'])
        adapter.update(mesh2sdfPythonExecutable=sys.executable,mesh2sdfCorePath=str(core),mesh2sdfCoreSha256='b'*64)
        self.config.write_text(json.dumps(config))
        calls=[]
        def probe(python,modules):
            calls.append((python,list(modules)))
            return []
        self.jobs._probe=probe
        self.assertTrue(self.jobs.capabilities()['operations']['ai_lowpoly']['ready'])
        self.assertIn((sys.executable,['numpy']),calls)
        self.assertTrue(any('skimage' in modules and 'open3d' in modules for _,modules in calls))
        self.assertTrue(all('psutil' in modules for python,modules in calls if 'trimesh' in modules and 'torch' not in modules))
        self.assertTrue(any('scipy' in modules for _,modules in calls))
        self.jobs._probe=lambda python,modules: ['Missing dependency: open3d'] if 'open3d' in modules else []
        capability=self.jobs.capabilities()
        self.assertFalse(capability['operations']['ai_lowpoly']['ready'])
        self.assertTrue(capability['operations']['analyze']['ready'])
        self.jobs._probe=lambda python,modules: ['Missing dependency: psutil'] if 'psutil' in modules else []
        self.assertFalse(self.jobs.capabilities()['operations']['analyze']['ready'])
        self.jobs._probe=lambda python,modules: ['Missing dependency: skimage'] if 'skimage' in modules else []
        capability=self.jobs.capabilities()
        self.assertFalse(capability['operations']['ai_lowpoly']['ready'])
        self.assertTrue(capability['operations']['analyze']['ready'])
        adapter['mesh2sdfCoreSha256']='invalid'
        self.config.write_text(json.dumps(config))
        self.assertIn('mesh2sdfCoreSha256',self.jobs.capabilities()['operations']['ai_lowpoly']['reason'])

    def test_independent_venv_inside_comfy_portable_checkout_is_allowed(self):
        portable = self.root/'ComfyUI_windows_portable'
        venv = portable/'video-workbench'/'.cache'/'native3d-venv'
        python = venv/'Scripts'/'python.exe'
        python.parent.mkdir(parents=True)
        python.write_bytes(b'fixture')
        (venv/'pyvenv.cfg').write_text('home = fixture')
        self.config.write_text(json.dumps({'pythonExecutable':str(python)}))
        self.assertTrue(self.jobs.capabilities()['operations']['analyze']['ready'])
        embedded = portable/'python_embeded'/'python.exe'
        embedded.parent.mkdir()
        embedded.write_bytes(b'fixture')
        self.config.write_text(json.dumps({'pythonExecutable':str(embedded)}))
        self.assertFalse(self.jobs.capabilities()['operations']['analyze']['ready'])
        comfy_env = portable/'ComfyUI'/'.venv'
        comfy_python = comfy_env/'Scripts'/'python.exe'
        comfy_python.parent.mkdir(parents=True)
        comfy_python.write_bytes(b'fixture')
        (comfy_env/'pyvenv.cfg').write_text('home = fixture')
        (comfy_env.parent/'main.py').write_text('# fixture')
        (comfy_env.parent/'custom_nodes').mkdir()
        self.config.write_text(json.dumps({'pythonExecutable':str(comfy_python)}))
        self.assertFalse(self.jobs.capabilities()['operations']['analyze']['ready'])

    def test_rejects_comfy_python_and_missing_runtime(self):
        with patch.dict(os.environ,{'H3_NATIVE3D_PYTHON':''}):
            self.config.write_text('{}')
            self.assertFalse(self.jobs.capabilities()['ready'])
            with self.assertRaises(StoreError): self.jobs.submit(self.payload)

if __name__=='__main__': unittest.main()
