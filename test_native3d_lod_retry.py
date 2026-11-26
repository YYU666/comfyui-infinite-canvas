import tempfile
import unittest
from pathlib import Path
import numpy as np
import trimesh
from native3d_lod_retry import seeded_order, run_retry, validate_retry_context
from unittest.mock import patch
import copy, hashlib
from types import SimpleNamespace
from project_store import StoreError
from native3d_geometry import mesh_hash
from native3d_lod_source import resolve_lod_settings

class RetryTests(unittest.TestCase):
    def test_retry_provenance(self):
        from native3d_jobs import validate_parameters
        with self.assertRaises(StoreError):validate_parameters('source_lod',{'seed':True})
        with self.assertRaises(StoreError):validate_parameters('source_lod',{'retryStage':'lod3'})
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'lod2.glb'; mesh=trimesh.creation.icosphere(subdivisions=1);mesh.export(path)
            mesh=trimesh.load(path,force='mesh',process=False);mh=mesh_hash(mesh.vertices,mesh.faces)
            sha=hashlib.sha256(path.read_bytes()).hexdigest()
            record={'stage':'lod2','status':'accepted','visible':True,'eligibleForDownstream':True,'filename':'lod2.glb','file_sha256':sha,'mesh_hash':mh,
                    'receipt':{'geometry':{'status':'accepted','intersectionComplete':True,'intersection_pairs_count':0,'mesh_hash':mh},'fidelity':{'accepted':True}}}
            prior={'id':'old','projectId':'p','operation':'source_lod','status':'succeeded','result':{'metadata':{'geometry':{
                'stages':[record],'sourceFileSha256':'high','settings':resolve_lod_settings(),'logicalLevels':[{'lodLevel':0,'triangles':1000}]}}}}
            manager=SimpleNamespace(jobs={'old':prior},_safe_file=lambda *args:path)
            job={'projectId':'p','parameters':{'retryJobId':'old','retryStage':'lod3','seed':2},'source':{'sha256':sha,'highSha256':'high'}}
            self.assertEqual(validate_retry_context(manager,job)['parentStage'],'lod2')
            for changed in ({'projectId':'other'},{'source':{'sha256':'wrong','highSha256':'high'}},{'source':{'sha256':sha,'highSha256':'wrong'}}):
                with self.assertRaises(StoreError):validate_retry_context(manager,{**job,**changed})
            # Another attempt keeps the same immutable anchor parent.
            second=copy.deepcopy(job);second['parameters']['seed']=3
            self.assertEqual(validate_retry_context(manager,second)['parentFileSha256'],sha)
            # A successful retried stage can be the next logical stage's parent.
            geometry=prior['result']['metadata']['geometry']
            geometry['retry']={'originalSourceSha256':'high','lod0Triangles':1000}
            geometry['logicalLevels']=[]
            record['stage']='lod3'
            next_job=copy.deepcopy(job);next_job['parameters']['retryStage']='lod4'
            self.assertEqual(validate_retry_context(manager,next_job)['lod0Triangles'],1000)
            record['stage']='lod2'
            record['receipt']['geometry']['intersectionComplete']=False
            with self.assertRaises(StoreError):validate_retry_context(manager,job)

    def test_blocked_returns_candidate(self):
        mesh=trimesh.creation.icosphere(subdivisions=2)
        params={'retryJobId':'old','retryStage':'lod3','seed':12}
        context={'retryJobId':'old','retryStage':'lod3','parentStage':'lod2','parentMeshHash':mesh_hash(mesh.vertices,mesh.faces),
                 'parentFileSha256':'a'*64,'originalSourceSha256':'b'*64,'lod0Triangles':len(mesh.faces)*4,'settings':resolve_lod_settings()}
        from native3d_geometry_audit import audit_geometry as real_audit
        calls=[]
        def audit(*args,**kwargs):
            result=real_audit(*args,**kwargs);calls.append(1)
            if len(calls)>1:result.update(status='blocked',blocker='test_rejection')
            return result
        with tempfile.TemporaryDirectory() as tmp, patch('native3d_geometry_audit.audit_geometry',side_effect=audit):
            result,report,files=run_retry(mesh,mesh,tmp,params,context)
            self.assertEqual(report['status'],'blocked');self.assertLess(len(result.faces),len(mesh.faces))
            self.assertFalse(report['stages'][0]['eligibleForDownstream'])
            self.assertEqual(Path(files[0]['path']).name,'blocked_lod3.glb')
            self.assertNotIn('selectedStage',report)

    def test_permutation(self):
        mesh=trimesh.creation.icosphere(subdivisions=2)
        a=seeded_order(mesh.vertices,mesh.faces,7);b=seeded_order(mesh.vertices,mesh.faces,7);c=seeded_order(mesh.vertices,mesh.faces,8)
        np.testing.assert_array_equal(a[0],b[0]);np.testing.assert_array_equal(a[1],b[1])
        self.assertNotEqual(a[2]['permutationSha256'],c[2]['permutationSha256'])
        for bad in (-1,4294967296,True,1.1):
            with self.assertRaises(ValueError):seeded_order(mesh.vertices,mesh.faces,bad)
    def test_single_stage_and_reproducibility(self):
        mesh=trimesh.creation.icosphere(subdivisions=3)
        params={'retryJobId':'n3d_'+'a'*32,'retryStage':'lod3','seed':7}
        context={'retryJobId':params['retryJobId'],'retryStage':'lod3','parentStage':'lod2',
                 'parentMeshHash':mesh_hash(mesh.vertices,mesh.faces),'parentFileSha256':'a'*64,
                 'originalSourceSha256':'b'*64,'lod0Triangles':len(mesh.faces)*4,
                 'settings':resolve_lod_settings()}
        hashes=[]
        for seed in (7,7,8):
            with tempfile.TemporaryDirectory() as tmp:
                result,report,artifacts=run_retry(mesh,mesh,tmp,{**params,'seed':seed},context)
                self.assertEqual([r['stage'] for r in report['stages']],['lod3'])
                self.assertEqual(len(result.faces),len(mesh.faces)//2)
                self.assertEqual(report['stages'][0]['parent_mesh_hash'],context['parentMeshHash'])
                self.assertTrue(Path(artifacts[0]['path']).is_file())
                hashes.append(mesh_hash(result.vertices,result.faces))
        self.assertEqual(hashes[0],hashes[1]);self.assertNotEqual(hashes[0],hashes[2])

if __name__=='__main__':unittest.main()
