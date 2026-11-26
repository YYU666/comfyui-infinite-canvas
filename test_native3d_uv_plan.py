import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import numpy as np
import trimesh
import native3d_uv_plan as planner
from native3d_partfield import prepare_samples,verify_samples,readiness,infer_features,high_evidence,sha,CHECKPOINT_SHA,COMMIT


class PlanTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=tempfile.TemporaryDirectory();cls.root=Path(cls.temp.name);cls.mesh=trimesh.creation.box()
        sample=cls.root/'samples.npz';receipt=prepare_samples(cls.mesh,sample,'1'*64);cls.data=verify_samples(cls.mesh,sample,receipt,'1'*64)
        cls.params={'orientationConfirmed':True,'partitionCount':4,'resolution':1024,'padding':8,'packingMode':'legacy_fixed'}
        def cached(high,source,cache,**kwargs):
            Path(cache).mkdir(parents=True,exist_ok=True)
            return cls.data,None,{'sampleCacheSha256':receipt['sampleCacheSha256'],'featuresSha256':'2'*64,'checkpointSha256':CHECKPOINT_SHA,'officialCommit':COMMIT,'cacheReused':True}
        def cluster(features,out,count,config):
            labels=((cls.data['query'][:,0]>0).astype(int)+2*(cls.data['query'][:,1]>0)).astype(np.int32);np.save(out,labels);return labels
        with patch('native3d_uv_plan.high_evidence',side_effect=cached),patch('native3d_uv_plan.cluster_features',side_effect=cluster),\
             patch('native3d_uv.unwrap',side_effect=AssertionError('Planner must not unwrap')),\
             patch.dict('sys.modules',{'xatlas':None}):
            cls.output=cls.root/'plan';cls.result=planner.build_plan(cls.mesh,cls.mesh,cls.output,cls.params,low_sha256='3'*64,high_sha256='1'*64)

    @classmethod
    def tearDownClass(cls):cls.temp.cleanup()

    def load(self):return planner.load_plan(self.output/'uv-plan.json',low_sha256='3'*64,high_sha256='1'*64,parameters=self.params)

    def test_real_plan_contains_no_uv_and_exact_binary_geometry(self):
        plan=self.load();self.assertFalse(plan['statistics']['unwrapExecuted'])
        self.assertNotIn('candidateEdges',self.result['metadata']['uvPlan'])
        binary=(self.output/'uv-plan-overlay.bin').read_bytes()
        for name,expected in [('positions',self.mesh.vertices.astype('f4')),('faces',self.mesh.faces.astype('u4'))]:
            a=plan['overlay']['arrays'][name];actual=np.frombuffer(binary,dtype=a['dtype'],count=a['count']*a['itemSize'],offset=a['offset']).reshape(expected.shape)
            np.testing.assert_array_equal(actual,expected)
        self.assertTrue(all(item['offset']%4==0 for item in plan['overlay']['arrays'].values()))
        self.assertEqual({p.name for p in self.output.iterdir()},{'uv-plan.json','uv-plan-overlay.bin','uv-plan-evidence.npz'})

    def test_explicit_structure_mode_has_new_settings_without_changing_legacy(self):
        old=self.load();old_hash=old['planSha256'];old_settings=dict(old['settings'])
        parameters={**self.params,'seamPlanningMode':'ai_structure_ao_v2'}
        runtime=dict(self.result['plan']['runtime'])
        with patch('native3d_uv_plan.high_evidence',return_value=(self.data,None,runtime)):
            output=self.root/'modern-plan'
            result=planner.build_plan(self.mesh,self.mesh,output,parameters,low_sha256='3'*64,high_sha256='1'*64)
        modern=planner.load_plan(output/'uv-plan.json',low_sha256='3'*64,high_sha256='1'*64,parameters=parameters)
        self.assertEqual(modern['plannerVersion'],planner.STRUCTURE_PLANNER_VERSION)
        self.assertEqual(modern['settings']['aoDarknessThreshold'],.2)
        self.assertEqual(modern['settings']['concaveAngleDegrees'],45.)
        self.assertEqual(modern['edgeReasons'][:5],old['edgeReasons'])
        self.assertIn('structureStages',result['metadata']['uvPlan']['statistics'])
        planner.consume_plan(self.mesh,modern)
        with self.assertRaisesRegex(ValueError,'unwrap setting changed: convexAngleDegrees'):
            planner.unwrap_plan(self.mesh,modern,{'convexAngleDegrees':50})
        unchanged=self.load()
        self.assertEqual(unchanged['planSha256'],old_hash);self.assertEqual(unchanged['settings'],old_settings)
        self.assertNotIn('seamPlanningMode',unchanged['settings'])

    def test_coarse_harmonic_plan_is_explicit_new_version(self):
        old=self.load();old_hash=old['planSha256']
        parameters={**self.params,'seamPlanningMode':planner.COARSE_MODE}
        runtime=dict(self.result['plan']['runtime'])
        with patch('native3d_uv_plan.high_evidence',return_value=(self.data,None,runtime)):
            output=self.root/'coarse-plan'
            planner.build_plan(self.mesh,self.mesh,output,parameters,low_sha256='3'*64,high_sha256='1'*64)
        coarse=planner.load_plan(output/'uv-plan.json',low_sha256='3'*64,high_sha256='1'*64,parameters=parameters)
        self.assertEqual(coarse['plannerVersion'],planner.COARSE_PLANNER_VERSION)
        frozen=planner.consume_plan(self.mesh,coarse)
        self.assertEqual(frozen['parameterizationBackend'],planner.COARSE_MODE)
        self.assertFalse(coarse['statistics']['structureStages']['structureChainsImposed'])
        self.assertEqual(self.load()['planSha256'],old_hash)
        owner=np.empty(len(self.mesh.faces),int)
        for i,g in enumerate(frozen['groups']):owner[g]=i
        for pair,edge in zip(self.mesh.face_adjacency,self.mesh.face_adjacency_edges):
            if tuple(sorted(edge)) in frozen['reasons']:self.assertNotEqual(owner[pair[0]],owner[pair[1]])

    def test_hashes_reject_stale_source_setting_and_artifact(self):
        with self.assertRaisesRegex(ValueError,'source changed'):
            planner.load_plan(self.output/'uv-plan.json',low_sha256='4'*64,high_sha256='1'*64)
        with self.assertRaisesRegex(ValueError,'settings changed'):
            planner.load_plan(self.output/'uv-plan.json',low_sha256='3'*64,high_sha256='1'*64,parameters={**self.params,'padding':9})
        path=self.output/'uv-plan-overlay.bin';saved=path.read_bytes()
        try:
            path.write_bytes(saved[:-1]+bytes([saved[-1]^1]))
            with self.assertRaisesRegex(ValueError,'artifact changed'):self.load()
        finally:path.write_bytes(saved)

    def test_consumption_checks_topology_and_in_memory_digest(self):
        plan=self.load();consumed=planner.consume_plan(self.mesh,plan)
        self.assertEqual(sum(map(len,consumed['groups'])),len(self.mesh.faces))
        changed=self.mesh.copy();changed.vertices[0]+=.01
        with self.assertRaisesRegex(ValueError,'topology changed'):planner.consume_plan(changed,plan)
        plan['candidateEdges'].append({'vertices':[0,99999],'reason':'manual_locked'})
        with self.assertRaisesRegex(ValueError,'in-memory plan changed'):planner.consume_plan(self.mesh,plan)

    def test_invalid_edge_topology_is_rejected_even_with_new_valid_digest(self):
        plan=self.load();plan['candidateEdges']=[{'vertices':[0,99999],'reason':'manual_locked'}]
        plan['planSha256']=planner.digest({k:v for k,v in plan.items() if k not in ('planSha256','_directory')})
        with self.assertRaisesRegex(ValueError,'invalid edge topology'):planner.consume_plan(self.mesh,plan)

    def test_probability_roundoff_compatibility_preserves_strict_bad_data_rejection(self):
        import copy
        with np.load(self.output/'uv-plan-evidence.npz') as original:
            baseline={key:original[key].copy() for key in original.files}
        for field,value,allowed in [('confidence',1.+2*np.finfo(np.float64).eps,True),
                                    ('darkness',-2*np.finfo(np.float64).eps,True),
                                    ('confidence',1.+1e-12,False),('darkness',-1e-12,False),
                                    ('confidence',1.+1e-10,False),('darkness',-.0001,False),
                                    ('confidence',np.nan,False),('supported',None,False)]:
            with self.subTest(field=field,value=value),tempfile.TemporaryDirectory() as tmp:
                plan=copy.deepcopy(self.load());data={k:v.copy() for k,v in baseline.items()}
                if field=='supported':data[field]=data[field].astype(np.uint8)
                else:data[field][0]=value
                artifact=Path(tmp)/'uv-plan-evidence.npz';np.savez_compressed(artifact,**data)
                plan['evidence'].update(sha256=sha(artifact),byteLength=artifact.stat().st_size)
                plan['_directory']=tmp
                plan['planSha256']=planner.digest({k:v for k,v in plan.items() if k not in ('planSha256','_directory')})
                before=artifact.read_bytes()
                if allowed:
                    result=planner.consume_plan(self.mesh,plan)
                    self.assertTrue(np.all((result['evidence'][field]>=0)&(result['evidence'][field]<=1)))
                else:
                    with self.assertRaisesRegex(ValueError,'invalid mapping support|evidence nonfinite'):
                        planner.consume_plan(self.mesh,plan)
                self.assertEqual(artifact.read_bytes(),before)

    def test_frozen_plan_unwrap_exact_and_distinct_auxiliary_seams(self):
        plan=self.load();result,report=planner.unwrap_plan(self.mesh,plan)
        source=np.asarray(result.metadata['uvSourceVertex']);faces=np.asarray(result.metadata['uvSourceFace'])
        np.testing.assert_array_equal(result.vertices,self.mesh.vertices[source]);np.testing.assert_array_equal(source[result.faces],self.mesh.faces[faces])
        self.assertEqual(report['reviewedPlan']['planSha256'],plan['planSha256'])
        self.assertFalse(report['reviewedPlan']['inferenceRecomputed']);self.assertEqual(report['geometricOverlapPairs'],0)
        with self.assertRaisesRegex(ValueError,'unwrap setting changed'):planner.unwrap_plan(self.mesh,plan,{'padding':9})

    def test_continuity_merges_are_bounded_and_unknown_never_assigned(self):
        mesh=trimesh.Trimesh([[0,0,0],[1,0,0],[0,1,0],[.501,.501,0]],[[0,1,2],[1,3,2]],process=False)
        regions,r=planner.merge_regions(mesh,[0,1],[1,1],[True,True],.01,35,max_merges=1)
        self.assertEqual(len(r['merges']),1);self.assertEqual(regions[0],regions[1])
        regions,r=planner.merge_regions(mesh,[0,-1],[1,0],[True,False],.01,35,max_merges=1)
        self.assertEqual(regions[1],-1);self.assertEqual(r['merges'],[])
        _,r=planner.merge_regions(mesh,[0,1],[1,1],[True,True],.01,35,max_merges=0)
        self.assertEqual(r['merges'],[])

    def test_unwrap_rejects_solver_that_rejoins_reviewed_seams(self):
        plan=self.load();frozen=planner.consume_plan(self.mesh,plan)
        interior={tuple(sorted(map(int,e))) for e in self.mesh.face_adjacency_edges}
        self.assertTrue(interior & set(frozen['reasons']))
        result=self.mesh.copy()
        result.metadata.update(uvSourceVertex=list(range(len(result.vertices))),uvSourceFace=list(range(len(result.faces))))
        with patch('native3d_uv_coherent.coherent_unwrap',return_value=(result,{})):
            with self.assertRaisesRegex(ValueError,'UV_PLAN_CONSTRAINT_LOST'):
                planner.unwrap_plan(self.mesh,plan)

    def test_no_gpu_without_server_reservation_and_config_is_required(self):
        self.assertFalse(readiness()['ready'])
        self.assertFalse(readiness({'runtimePath':'relative'})['ready'])
        with self.assertRaisesRegex(ValueError,'resource reservation'):infer_features('input','output')

    def test_zero_area_high_face_is_preserved_but_never_sampled(self):
        mesh=trimesh.Trimesh([[0,0,0],[1,0,0],[0,1,0],[0,0,0]],[[0,1,2],[0,0,3]],process=False)
        path=self.root/'zero-area.npz';r=prepare_samples(mesh,path,'5'*64);data=verify_samples(mesh,path,r,'5'*64)
        self.assertEqual(len(mesh.faces),2);self.assertTrue(np.all(data['querySourceFace']==0))

    def test_high_cache_import_checks_actual_feature_bytes_and_samples(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);previous=root/'previous';previous.mkdir()
            r=prepare_samples(self.mesh,previous/'high-samples.npz','1'*64)
            (previous/'high-input.json').write_text(json.dumps(r))
            np.save(previous/'high-query-features.npy',np.zeros((32768,448),np.float32))
            f={**r,'featuresSha256':sha(previous/'high-query-features.npy'),'checkpointSha256':CHECKPOINT_SHA,'officialCommit':COMMIT}
            (previous/'high-inference.json').write_text(json.dumps(f))
            _,features,receipt=high_evidence(self.mesh,'1'*64,root/'cache',verified_cache=previous)
            self.assertTrue(receipt['cacheReused']);self.assertEqual(features.shape,(32768,448))
            with (previous/'high-query-features.npy').open('r+b') as stream:stream.seek(-1,2);stream.write(b'\x01')
            with self.assertRaisesRegex(ValueError,'Unverified PartField cache provenance'):
                high_evidence(self.mesh,'1'*64,root/'tampered',verified_cache=previous)

    def test_server_boolean_cannot_bypass_resource_guard(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary)
            with patch('native3d_partfield.subprocess.run') as launch:
                with self.assertRaisesRegex(ValueError, 'shared GPU resource reservation'):
                    infer_features(root/'samples', root/'features.npy', gpu_authorized=True)
                launch.assert_not_called()

    def test_lod0_budget_accepts_81920_exact_faces_and_rejects_over_100k(self):
        mesh=trimesh.creation.icosphere(subdivisions=6)
        self.assertEqual(len(mesh.faces),81920)
        saved=planner.geometry_sha(mesh);planner.validate_mesh(mesh,False)
        self.assertEqual(planner.geometry_sha(mesh),saved)
        too_many=trimesh.Trimesh(mesh.vertices,np.tile(mesh.faces,(2,1)),process=False)
        with self.assertRaisesRegex(ValueError,'100000'):planner.validate_mesh(too_many,True)


if __name__=='__main__':unittest.main()
