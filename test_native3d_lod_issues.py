import copy,hashlib,json,tempfile,threading,unittest
from pathlib import Path
from native3d_lod_issues import issue_summary,validate_markers,render
from native3d_jobs import Native3DJobs
from project_store import StoreError
class IssuesTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name);self.source=self.root/'blocked_lod3.glb';self.source.write_bytes(b'fixture');self.sha=hashlib.sha256(b'fixture').hexdigest()
  self.record={'stage':'lod3','status':'blocked','eligibleForDownstream':False,'diagnosticFilename':self.source.name,'diagnosticFileSha256':self.sha,'mesh_hash':'a'*64,'receipt':{'geometry':{'mesh_hash':'a'*64,'triangles':10,'vertices':8,'intersectionComplete':True,'intersection_pairs_count':0,'intersection_pairs':[]}}}
  self.job={'id':'n3d_'+'1'*32,'operation':'source_lod','status':'succeeded','result':{'files':[{'name':self.source.name,'role':'export','sha256':self.sha}],'metadata':{'geometry':{'blocker':'Boundary distance upper bound could not be certified within budget','stages':[self.record]}}}}
 def tearDown(self):self.tmp.cleanup()
 def test_old_candidate_excluded_and_unlocalized(self):
  self.record['receipt']['childFallback']={'originalAttempt':{'intersection_pairs':[[277,2422]]}}
  s=issue_summary(self.job,'lod3',self.record,self.sha);self.assertEqual(s['intersectionCount'],0);self.assertEqual(s['localization'],'unlocalized');self.assertFalse(any(i['classification']=='confirmed_issue' for i in s['items']))
 def test_marker_final_binding_and_indices(self):
  self.record['receipt']['boundaryIssueMarkers']={'meshHash':'a'*64,'faceCount':10,'markers':[{'kind':'boundary','classification':'certification_incomplete','faceIds':[3],'candidateEdgeVertexIds':[1,2]}]}
  s=issue_summary(self.job,'lod3',self.record,self.sha);self.assertEqual(s['localization'],'recorded_markers')
  self.record['receipt']['boundaryIssueMarkers']['meshHash']='b'*64
  with self.assertRaises(ValueError):issue_summary(self.job,'lod3',self.record,self.sha)
  self.record['receipt']['boundaryIssueMarkers']['meshHash']='a'*64;self.record['receipt']['boundaryIssueMarkers']['markers'][0]['faceIds']=[10]
  with self.assertRaises(ValueError):issue_summary(self.job,'lod3',self.record,self.sha)
 def test_confirmed_boundary_not_mislabeled_uncertain(self):
  for blocker in ['Original boundary distance exceeds independent shape budget: 2 > 1','Original boundary perimeter changed by more than5percent','Original boundary component Euler characteristic or loop count changed']:
   self.job['result']['metadata']['geometry']['blocker']=blocker
   summary=issue_summary(self.job,'lod3',self.record,self.sha)
   self.assertIn('已确认',summary['summary']);self.assertTrue(any(i['classification']=='confirmed_issue' for i in summary['items']))
  self.job['result']['metadata']['geometry']['blocker']='Boundary distance upper bound could not be certified within budget'
  self.record['receipt']['boundaryIssueMarkers']={'meshHash':'a'*64,'markers':[{'classification':'confirmed_issue','kind':'boundary','faceIds':[1]}]}
  self.assertIn('已确认',issue_summary(self.job,'lod3',self.record,self.sha)['summary'])
 def test_child_fallback_marker_requires_same_final_geometry(self):
  fallback={'geometry':{'mesh_hash':'a'*64},'boundaryIssueMarkers':{'meshHash':'a'*64,'faceCount':10,'markers':[{'classification':'certification_incomplete','kind':'boundary','faceIds':[2]}]}}
  self.record['receipt']['childFallback']={'receipt':fallback}
  self.assertEqual(issue_summary(self.job,'lod3',self.record,self.sha)['localization'],'recorded_markers')
  fallback['geometry']['mesh_hash']='b'*64
  summary=issue_summary(self.job,'lod3',self.record,self.sha)
  self.assertTrue(summary['historicalMarkersOmitted']);self.assertEqual(summary['localization'],'unlocalized')
 def test_endpoint_source_guard(self):
  jobs=Native3DJobs.__new__(Native3DJobs);jobs.get=lambda job:self.job;jobs.output_file=lambda job,name:self.source
  s=jobs.lod_issues(self.job['id'],'lod3');self.assertEqual(s['diagnosticFileSha256'],self.sha)
  with self.assertRaises(StoreError):jobs.lod_issues(self.job['id'],'../lod3')
  self.source.write_bytes(b'changed')
  with self.assertRaises(StoreError):jobs.lod_issues(self.job['id'],'lod3')
 def test_render_real_fixture(self):
  import trimesh
  from native3d_engine import read_mesh
  from native3d_geometry import mesh_hash
  from PIL import Image
  trimesh.creation.box().export(self.source);m=read_mesh(self.source);self.sha=hashlib.sha256(self.source.read_bytes()).hexdigest();self.record['mesh_hash']=mesh_hash(m.vertices,m.faces);self.record['receipt']['geometry'].update(mesh_hash=self.record['mesh_hash'],triangles=len(m.faces),vertices=len(m.vertices))
  s=issue_summary(self.job,'lod3',self.record,self.sha);e=self.root/'e.json';e.write_text(json.dumps({'summary':s,'geometry':self.record['receipt']['geometry']}));out=self.root/'out.png';render(self.source,e,out)
  with Image.open(out) as im:self.assertEqual(im.size,(1200,900))
if __name__=='__main__':unittest.main()
