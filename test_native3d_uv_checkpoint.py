import contextlib
import copy
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
import trimesh

import native3d_uv_checkpoint as checkpoint


class CheckpointTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = trimesh.Trimesh([[0,0,0],[1,0,0],[0,1,0]], [[0,1,2]], process=False)
        self.mesh = self.source.copy()
        self.mesh.visual = trimesh.visual.TextureVisuals(uv=[[.1,.1],[.8,.1],[.1,.8]])
        self.mesh.metadata.update(uvSourceVertex=[0,1,2],uvSourceFace=[0],nativeSourceUV=True)
        self.plan = {'planSha256':'a'*64,'source':{'lowSha256':'b'*64,'highSha256':'c'*64},
                     'settings':{'resolution':1024,'padding':8}}
        self.report = {'status':'needs_review','qualityFlags':dict.fromkeys(
            ['exactGeometry','rasterOverlapFree','nondegenerateUV','noMixedFlip','paddingPixelCenters',
             'geometricOverlapFree','geometricPadding','geometricBounds'],True),
            'reviewedPlan':{'planSha256':'a'*64,'missingConstraintEdges':0}}
        self.key = checkpoint.identity(self.source,self.plan)

    def tearDown(self):
        self.temp.cleanup()

    def test_roundtrip_keeps_geometry_uv_normals_and_review_status(self):
        checkpoint.save(self.root,self.key,self.mesh,self.report,self.plan)
        mesh,report = checkpoint.load(self.root,self.key,self.source,self.plan)
        np.testing.assert_array_equal(mesh.vertices,self.mesh.vertices)
        np.testing.assert_array_equal(mesh.faces,self.mesh.faces)
        np.testing.assert_array_equal(mesh.visual.uv,self.mesh.visual.uv)
        np.testing.assert_array_equal(mesh.vertex_normals,self.source.vertex_normals)
        self.assertEqual(report['status'],'needs_review')

    def test_input_plan_setting_code_and_dependency_changes_invalidate(self):
        for field,value in [('planSha256','d'*64),('settings',{'resolution':4096,'padding':8}),
                            ('source',{'lowSha256':'d'*64,'highSha256':'c'*64})]:
            plan=copy.deepcopy(self.plan);plan[field]=value
            self.assertNotEqual(checkpoint.identity(self.source,plan),self.key)
        mesh=self.source.copy();mesh.vertices[0,0]=.01
        self.assertNotEqual(checkpoint.identity(mesh,self.plan),self.key)
        with patch.object(checkpoint,'sha',return_value='changed-source'):
            self.assertNotEqual(checkpoint.identity(self.source,self.plan),self.key)
        with patch.object(checkpoint.importlib.metadata,'version',return_value='new-version'):
            self.assertNotEqual(checkpoint.identity(self.source,self.plan),self.key)

    def test_corrupt_payload_and_report_are_misses(self):
        checkpoint.save(self.root,self.key,self.mesh,self.report,self.plan)
        payload=self.root/self.key/'mesh.npz';saved=payload.read_bytes()
        payload.write_bytes(saved[:-1]+bytes([saved[-1]^1]))
        self.assertIsNone(checkpoint.load(self.root,self.key,self.source,self.plan))
        payload.write_bytes(saved)
        manifest=self.root/self.key/'manifest.json'
        doc=json.loads(manifest.read_text(encoding='utf8'));doc['report']['status']='accepted'
        manifest.write_text(json.dumps(doc),encoding='utf8')
        self.assertIsNone(checkpoint.load(self.root,self.key,self.source,self.plan))

    def test_reject_incomplete_gates_nonfinite_and_unserializable_reports(self):
        report=copy.deepcopy(self.report);report['qualityFlags']['geometricOverlapFree']=False
        with self.assertRaisesRegex(ValueError,'quality gate'):
            checkpoint.save(self.root,self.key,self.mesh,report,self.plan)
        for invalid in [float('nan'),np.array([True,False])]:
            report=copy.deepcopy(self.report);report['invalid']=invalid
            with self.assertRaises((ValueError,TypeError)):
                checkpoint.save(self.root,self.key,self.mesh,report,self.plan)
        self.assertFalse((self.root/self.key).exists())

    def test_legacy_unchecked_output_is_never_promoted(self):
        (self.root/self.key).mkdir()
        np.savez(self.root/self.key/'packed-uv-unchecked.npz',uv=self.mesh.visual.uv)
        self.assertIsNone(checkpoint.load(self.root,self.key,self.source,self.plan))

    def test_invalid_manifest_structures_are_cache_misses(self):
        (self.root/self.key).mkdir()
        for value in [[],None,3,'bad',{'schema':1,'key':self.key,'report':[],'files':{}}]:
            (self.root/self.key/'manifest.json').write_text(json.dumps(value),encoding='utf8')
            self.assertIsNone(checkpoint.load(self.root,self.key,self.source,self.plan))

    def test_source_mapping_and_nonfinite_uv_rejected_even_with_valid_payload_hash(self):
        for change in ('geometry','nan'):
            with tempfile.TemporaryDirectory() as folder:
                mesh=self.mesh.copy()
                if change=='geometry':mesh.vertices[0,0]=.25
                else:mesh.visual.uv[0,0]=float('nan')
                checkpoint.save(folder,self.key,mesh,self.report,self.plan)
                self.assertIsNone(checkpoint.load(folder,self.key,self.source,self.plan))

    def test_progress_is_monotonic_and_names_actual_stage(self):
        from native3d_engine import uv_progress_callback
        stream=io.StringIO()
        with contextlib.redirect_stdout(stream):
            callback=uv_progress_callback()
            callback('uv_parameterization','start',0)
            callback('uv_final_geometry','start',0)
            callback('uv_parameterization','start',0)
        values=[json.loads(line) for line in stream.getvalue().splitlines()]
        self.assertEqual([r['progress'] for r in values],[.3,.78,.78])
        self.assertEqual(values[1]['stage'],'核对最终UV几何')


class FrozenStageIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Real small frozen plan, no expensive user's asset or GPU inference.
        import open3d  # Keep native extension loaded outside fixture's sys.modules patch.
        from test_native3d_uv_plan import PlanTests
        cls.fixture=PlanTests
        cls.fixture.setUpClass()

    @classmethod
    def tearDownClass(cls):
        cls.fixture.tearDownClass()

    def test_second_attempt_skips_solver_but_preserves_review_and_artifacts(self):
        import native3d_uv_plan as planner
        from native3d_uv_coherent import coherent_unwrap
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);first=root/'first';second=root/'second';first.mkdir();second.mkdir()
            plan=self.fixture().load()
            with patch('native3d_uv_coherent.coherent_unwrap',wraps=coherent_unwrap) as solver:
                mesh,report=planner.unwrap_plan(self.fixture.mesh,plan,output=first,checkpoint_root=root/'cache')
                self.assertEqual(solver.call_count,1)
                self.assertEqual(report['stageReuse']['status'],'stored')
            with patch('native3d_uv_coherent.coherent_unwrap',side_effect=AssertionError('Must reuse validated stage')):
                restored,restored_report=planner.unwrap_plan(self.fixture.mesh,self.fixture().load(),output=second,checkpoint_root=root/'cache')
            np.testing.assert_array_equal(mesh.vertices,restored.vertices)
            np.testing.assert_array_equal(mesh.visual.uv,restored.visual.uv)
            self.assertEqual(restored_report['reviewedPlan'],report['reviewedPlan'])
            self.assertEqual(restored_report['status'],'needs_review')
            self.assertEqual(restored_report['stageReuse']['status'],'reused_verified_stage')
            self.assertEqual((first/'uv-layout.png').read_bytes(),(second/'uv-layout.png').read_bytes())

    def test_export_failure_then_new_job_resumes_and_produces_normal_manifest(self):
        import native3d_engine as engine
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);source=root/'source.glb';source.write_bytes(self.fixture.mesh.export(file_type='glb'))
            first=root/'job1'/'output';second=root/'job2'/'output'
            request={'operation':'uv','sourcePath':str(source),'highSourcePath':str(source),
                'parameters':{'planSha256':self.fixture().load()['planSha256'],'planJobId':'fixture'},
                'uvPlanPath':str(self.fixture.output/'uv-plan.json')}
            validated_plan=self.fixture().load()
            # Fixtures exercise the actual engine/export boundary; plan loading's
            # source/hash refusal is separately covered by PlanTests.
            with patch('native3d_engine.read_mesh',side_effect=lambda path:self.fixture.mesh.copy()), \
                 patch('native3d_uv_plan.load_plan',side_effect=lambda *a,**kw:copy.deepcopy(validated_plan)), \
                 patch('native3d_fbx.capabilities',return_value={'available':False}), \
                 contextlib.redirect_stdout(io.StringIO()):
                with patch('native3d_engine.poster',side_effect=OSError('injected export failure')):
                    with self.assertRaisesRegex(OSError,'injected export failure'):
                        engine.run(request,first)
                self.assertFalse((first/'result.json').exists())
                with patch('native3d_uv_coherent.coherent_unwrap',side_effect=AssertionError('No UV recomputation')):
                    result=engine.run(request,second)
            self.assertEqual(result['metadata']['uv']['stageReuse']['status'],'reused_verified_stage')
            self.assertEqual(result['quality']['status'],'needs_review')
            manifest=json.loads((second/'result.json').read_text(encoding='utf8'))
            for entry in manifest['files']:
                self.assertTrue((second/entry['name']).is_file())
            self.assertFalse((first/'result.json').exists())

    def test_cache_ineligibility_does_not_add_solver_quality_gate(self):
        import native3d_uv_plan as planner
        from native3d_uv_coherent import coherent_unwrap
        def pending(*args,**kwargs):
            mesh,report=coherent_unwrap(*args,**kwargs)
            report['qualityFlags']['geometricPadding']=False
            return mesh,report
        with tempfile.TemporaryDirectory() as folder:
            with patch('native3d_uv_coherent.coherent_unwrap',side_effect=pending):
                mesh,report=planner.unwrap_plan(self.fixture.mesh,self.fixture().load(),checkpoint_root=folder)
            self.assertEqual(report['stageReuse']['status'],'not_cacheable')
            self.assertFalse(report['qualityFlags']['geometricPadding'])
            self.assertEqual(report['status'],'needs_review')


if __name__ == '__main__':
    unittest.main()
