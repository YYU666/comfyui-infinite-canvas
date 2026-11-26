import copy,hashlib,io,json,sys,tempfile,threading,unittest
from pathlib import Path
from unittest.mock import Mock,patch
import numpy as np
import trimesh
from native3d_geometry import mesh_hash
from native3d_lod_source import _canonical_mesh,_save_mesh
from native3d_lod_boundary_retopo import _split
from native3d_lod_repair_preview import official_evidence,reconstruct,render
from native3d_jobs import Native3DJobs
from native3d_api import Native3DAPI
from project_store import StoreError

class RepairPreviewTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name);self.jobid='n3d_'+'a'*32
        folder=self.root/self.jobid/'output';folder.mkdir(parents=True);self.source=folder/'lod3.glb'
        before=_canonical_mesh(np.array([[0.,0,0],[1,0,0],[0,1,0]]),np.array([[0,1,2]]))
        v,f,mapping=_split(before.vertices,before.faces,0,[0,1],[.5,.001,0]);after=_canonical_mesh(v,f);sha=_save_mesh(after,self.source)
        bh=mesh_hash(before.vertices,before.faces);ah=mesh_hash(after.vertices,after.faces)
        geom={'status':'accepted','intersectionComplete':True,'intersection_pairs_count':0,'mesh_hash':ah,'triangles':2}
        chosen={'status':'complete','afterMeshHash':ah,'patchMap':mapping,'newVertexPosition':v[-1].tolist(),'analyticLocalHausdorffUpperMeters':.001,'allOldVerticesExact':True,'outsideFacesExact':True,'geometry':geom,'localFidelity':{'accepted':True},'sourceNormalQuality':{'accepted':True},'fidelity':{'accepted':True},'boundaryPreservation':{'accepted':True,'candidateMeshHash':ah}}
        repair={'profile':'local-boundary-retopology-v1','status':'complete','beforeMeshHash':bh,'afterMeshHash':ah,'beforeTriangles':1,'beforeGeometry':{'mesh_hash':bh},'localization':{'meshHash':bh,'markers':[{'classification':'certification_incomplete'}]},'candidates':[chosen],'selectedCandidate':0}
        self.record={'stage':'lod3','status':'accepted','visible':True,'eligibleForDownstream':True,'filename':'lod3.glb','file_sha256':sha,'mesh_hash':ah,'receipt':{'geometry':geom,'fidelity':{'accepted':True},'childFallback':{'receipt':{'status':'complete','candidateMeshHash':ah,'boundaryRetopology':repair}}}}
        self.job={'id':self.jobid,'operation':'source_lod','status':'succeeded','result':{'metadata':{'geometry':{'stages':[self.record]}},'files':[{'name':'lod3.glb','role':'export','sha256':sha}]}}
        self.evidence=official_evidence(self.job,'lod3',sha)
        self.manager=Native3DJobs.__new__(Native3DJobs);self.manager.root=self.root;self.manager.preview_lock=threading.Lock();self.manager.get=lambda _:copy.deepcopy(self.job);self.manager.output_file=lambda *args:self.source;self.manager.config=lambda:{'pythonExecutable':sys.executable}
    def tearDown(self):self.temp.cleanup()
    def test_exact_reconstruction_and_unchanged_file(self):
        raw=self.source.read_bytes();before,after=reconstruct(self.source,self.evidence)
        self.assertEqual(mesh_hash(before.vertices,before.faces),self.evidence['beforeMeshHash']);self.assertEqual(mesh_hash(after.vertices,after.faces),self.evidence['afterMeshHash']);self.assertEqual(self.source.read_bytes(),raw)
    def test_tampered_patch_hash_and_file_refused(self):
        for key,value in [('beforeMeshHash','0'*64),('afterMeshHash','0'*64),('finalFileSha256','0'*64)]:
            e=copy.deepcopy(self.evidence);e[key]=value
            with self.assertRaises(ValueError):reconstruct(self.source,e)
        for key,value in [('removedFaceId',-1),('newVertexId',0),('newFaceIds',[0,0]),('removedFaceVertices',[0,1,3]),('newFaces',[[0,1,2],[0,1,2]])]:
            e=copy.deepcopy(self.evidence);e['selected']['patchMap'][key]=value
            with self.assertRaises(ValueError):reconstruct(self.source,e)
    def test_only_registered_accepted_repair(self):
        for key,value in [('status','blocked'),('eligibleForDownstream',False),('filename','other.glb')]:
            j=copy.deepcopy(self.job);j['result']['metadata']['geometry']['stages'][0][key]=value
            with self.assertRaises(ValueError):official_evidence(j,'lod3',self.evidence['finalFileSha256'])
        j=copy.deepcopy(self.job);j['result']['metadata']['geometry']['stages'].append(copy.deepcopy(self.record))
        with self.assertRaises(ValueError):official_evidence(j,'lod3',self.evidence['finalFileSha256'])
    def test_receipt_hashes_and_selected_index_bound(self):
        for key,value in [('beforeMeshHash','0'*64),('afterMeshHash','0'*64),('selectedCandidate',True),('selectedCandidate',9)]:
            j=copy.deepcopy(self.job);j['result']['metadata']['geometry']['stages'][0]['receipt']['childFallback']['receipt']['boundaryRetopology'][key]=value
            with self.assertRaises(ValueError):official_evidence(j,'lod3',self.evidence['finalFileSha256'])
    def test_renderer_four_by_three_and_ids(self):
        from PIL import Image
        e=self.root/'e.json';e.write_text(json.dumps(self.evidence));png=self.root/'p.png';s=self.root/'s.json';render(self.source,e,png,s)
        with Image.open(png) as image:self.assertEqual(image.size,(1200,900))
        summary=json.loads(s.read_text(encoding='utf-8'));self.assertEqual(summary['beforeFaceIds'],[0]);self.assertEqual(summary['afterFaceIds'],[0,1]);self.assertTrue(summary['sameLocalCamera']);self.assertEqual(summary['beforeClassification'],'certification_incomplete')
    def fake_renderer(self,args,**kwargs):
        self.assertEqual(kwargs['timeout'],25)
        values={args[i][2:]:args[i+1] for i in range(2,len(args),2)};render(values['source'],values['evidence'],values['output'],values['summary']);return Mock(returncode=0)
    def test_endpoint_reads_official_evidence_and_caches_without_job_mutation(self):
        saved=copy.deepcopy(self.job);raw=self.source.read_bytes()
        with patch('native3d_jobs.subprocess.run',side_effect=self.fake_renderer) as call:
            s=self.manager.lod_repair_preview(self.jobid,'lod3');image=self.manager.lod_repair_preview(self.jobid,'lod3',True)
        self.assertEqual(call.call_count,1);self.assertTrue(image.is_file());self.assertEqual(s['jobId'],self.jobid);self.assertEqual(saved,self.job);self.assertEqual(raw,self.source.read_bytes())
    def test_unregistered_digest_and_bad_stage_rejected(self):
        with self.assertRaises(StoreError):self.manager.lod_repair_preview(self.jobid,'../../lod3')
        self.job['result']['files'][0]['sha256']='0'*64
        with self.assertRaises(StoreError):self.manager.lod_repair_preview(self.jobid,'lod3')
    def test_symlink_cache_refused(self):
        folder=self.root/self.jobid/'repair-previews';other=self.root/'elsewhere';other.mkdir()
        try:folder.symlink_to(other,target_is_directory=True)
        except OSError:self.skipTest('Symlink unavailable')
        with self.assertRaises(StoreError):self.manager.lod_repair_preview(self.jobid,'lod3')
    def test_renderer_timeout_is_failure_not_acceptance(self):
        import subprocess
        with patch('native3d_jobs.subprocess.run',side_effect=subprocess.TimeoutExpired('renderer',25)):
            with self.assertRaises(StoreError):self.manager.lod_repair_preview(self.jobid,'lod3')
        self.assertEqual(self.record['status'],'accepted')
    def test_cache_symlink_guard_without_platform_symlink_privilege(self):
        real=Path.is_symlink
        with patch.object(Path,'is_symlink',lambda p:True if p.name=='repair-previews' else real(p)):
            with self.assertRaises(StoreError):self.manager.lod_repair_preview(self.jobid,'lod3')
    def test_face_and_file_budgets(self):
        j=copy.deepcopy(self.job);j['result']['metadata']['geometry']['stages'][0]['receipt']['geometry']['triangles']=100001
        with self.assertRaises(ValueError):official_evidence(j,'lod3',self.evidence['finalFileSha256'])
        with self.source.open('ab') as stream:stream.truncate(16*1024**2+1)
        with self.assertRaises(StoreError):self.manager.lod_repair_preview(self.jobid,'lod3')
    def test_cache_corruption_regenerates_and_source_change_refused(self):
        with patch('native3d_jobs.subprocess.run',side_effect=self.fake_renderer) as call:
            self.manager.lod_repair_preview(self.jobid,'lod3');png=next((self.root/self.jobid/'repair-previews').glob('*.png'));png.write_bytes(b'corrupt')
            self.manager.lod_repair_preview(self.jobid,'lod3');self.assertEqual(call.call_count,2)
        self.source.write_bytes(self.source.read_bytes()+b'change')
        with self.assertRaises(StoreError):self.manager.lod_repair_preview(self.jobid,'lod3')
    def test_route_summary_and_image(self):
        jobs=Mock();api=Native3DAPI(jobs);h=Mock();h.wfile=io.BytesIO();route=f'/api/native3d/jobs/{self.jobid}/repair-preview/lod3';jobs.lod_repair_preview.return_value={'version':1};api.handle_get(h,route);jobs.lod_repair_preview.assert_called_with(self.jobid,'lod3');h.send_json.assert_called_with(200,{'version':1})
        png=self.root/'route.png';png.write_bytes(b'PNG');jobs.lod_repair_preview.return_value=png;api.handle_get(h,route+'/image');jobs.lod_repair_preview.assert_called_with(self.jobid,'lod3',image=True);self.assertEqual(h.wfile.getvalue(),b'PNG')

if __name__=='__main__':unittest.main()
