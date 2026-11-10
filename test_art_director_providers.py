import io,json,os,tempfile,unittest,urllib.error,ctypes,zipfile,hashlib
from pathlib import Path
from unittest.mock import patch
from art_director import ArtDirectorAPI,NoRedirect
from art_director_credentials import ArtCredentialStore,CredentialError,MAGIC,private_acl
from art_director_providers import PROFILES,profile_for,build_chat_request
from test_art_director import Store,Handler,fixture,png
from project_store import StoreError,ProjectStore
from scripts.build_update_package import assert_public_path

ENV_NAMES=('QWEN_API_KEY','DASHSCOPE_API_KEY','MOONSHOT_API_KEY','KIMI_API_KEY','ARK_API_KEY','DOUBAO_API_KEY','DEEPSEEK_API_KEY')

class ProviderTests(unittest.TestCase):
 def setUp(self):
  self.env=patch.dict(os.environ,{name:'' for name in ENV_NAMES});self.env.start();self.addCleanup(self.env.stop)
  self.temp=tempfile.TemporaryDirectory(prefix='h3-provider-v2-');self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name)
  self.creds=ArtCredentialStore(directory=self.root/'private',forbidden_roots=[self.root/'projects'])
 def payload(self,provider,model):
  return {'projectId':'prj_fixture','provider':provider,'model':model,'sourceVersion':'v1','brief':'合成审图','preserve':'原图','images':[{'slot':'artwork','purpose':'作品','image':png()}]}
 def test_fixed_profiles_contract_and_capability(self):
  for provider,profile in PROFILES.items():
   with self.subTest(provider=provider):
    def opener(request,timeout):
     self.assertEqual(request.full_url,profile['endpoint']);self.assertEqual(timeout,45)
     body=json.loads(request.data);self.assertEqual(body['model'],profile['defaultModel']);self.assertEqual(body['response_format'],{'type':'json_object'})
     self.assertEqual(body['messages'][1]['content'][-1]['type'],'image_url')
     if provider=='qwen': self.assertIs(body['enable_thinking'],False)
     else:self.assertNotIn('enable_thinking',body)
     if provider=='kimi':self.assertEqual(body['reasoning_effort'],'low');self.assertNotIn('thinking',body)
     if provider=='doubao':self.assertEqual(body['thinking'],{'type':'disabled'})
     self.assertEqual(request.get_header('Authorization'),'Bearer synthetic-'+provider+'-credential')
     return io.BytesIO(json.dumps({'choices':[{'finish_reason':'stop','message':{'content':json.dumps(fixture())}}]}).encode())
    api=ArtDirectorAPI(Store(),credentials=self.creds,opener=opener);api.session_keys[provider]='synthetic-'+provider+'-credential'
    result=api.analyze(self.payload(provider,profile['defaultModel']));self.assertEqual(result['provider'],provider);self.assertNotIn('credential',json.dumps(result))
  for provider,model in [('deepseek','deepseek-v4-pro'),('deepseek','deepseek-chat'),('kimi','unverified-model'),('unknown','arbitrary')]:
   with self.assertRaises(StoreError):profile_for(provider,model)
 def test_endpoint_rejection_and_no_redirect(self):
  api=ArtDirectorAPI(Store(),credentials=self.creds,opener=lambda *a,**k:self.fail('No network expected'));api.session_key='synthetic-qwen-credential'
  for value in ('https://untrusted.example','http://127.0.0.1','file:///private'):
   payload=self.payload('qwen','qwen3-vl-plus');payload['endpoint']=value
   with self.assertRaises(StoreError):api.analyze(payload)
  with self.assertRaises(urllib.error.HTTPError):NoRedirect().redirect_request(type('Req',(),{'full_url':'https://fixed.example'})(),None,302,'redirect',{},'https://untrusted.example')
 def test_config_redaction_provider_isolation(self):
  api=ArtDirectorAPI(Store(),credentials=self.creds)
  h=Handler({'provider':'kimi','key':'synthetic-kimi-value','persistence':'session'});api.handle_post(h,'/api/art-director/config');self.assertEqual(h.output[0],200);self.assertNotIn('synthetic-kimi-value',json.dumps(h.output));self.assertFalse(api.status('qwen')['configured']);self.assertTrue(api.status('kimi')['configured'])
  self.assertIn('synthetic-kimi-value',api.redaction_secrets())
  h=Handler({'provider':'qwen','endpoint':'https://untrusted.example','key':'synthetic-test'});api.handle_post(h,'/api/art-director/config');self.assertEqual(h.output[0],400)
 def test_path_boundaries_dynamic_projects_and_external_projects(self):
  repo=Path(__file__).resolve().parent
  for directory,forbidden in [(repo/'.cache'/'do-not-write',[]),(self.root/'projects'/'runtime',[self.root/'projects'])]:
   store=ArtCredentialStore(directory=directory,forbidden_roots=forbidden)
   with self.assertRaises(CredentialError):store.set('qwen','synthetic-path-test')
   self.assertFalse(store.available());self.assertFalse(store.path.exists())
  store=Store();store.root=self.root/'projects';store._opened_paths={}
  api=ArtDirectorAPI(store,credentials=self.creds);api.status();self.assertNotIn(self.root,self.creds.forbidden_roots)
  store.root=self.root;self.assertTrue(api.status()['storageError'])
  store.root=self.root/'projects';store._opened_paths={'external':self.root/'project.json'};self.assertTrue(api.status()['storageError'])
 def test_encrypt_and_acl_fail_closed(self):
  def fail(*args):raise OSError('synthetic failure text never returned')
  for protect,secure in [(fail,lambda p:None),(lambda d:b'encrypted-fixture',fail)]:
   store=ArtCredentialStore(directory=self.root/('fail-'+str(id(protect))),protect=protect,secure=secure)
   with self.assertRaisesRegex(CredentialError,'未写入明文'):store.set('qwen','synthetic-never-plaintext')
   self.assertFalse(store.path.exists())
 @unittest.skipUnless(os.name=='nt','Windows DPAPI and ACL')
 def test_real_dpapi_acl_roundtrip_corrupt_foreign_failure(self):
  secret='synthetic-test-only-no-real-key'
  self.creds.set('qwen',secret);self.assertEqual(self.creds.get('qwen'),secret);raw=self.creds.path.read_bytes();self.assertTrue(raw.startswith(MAGIC));self.assertNotIn(secret.encode(),raw)
  restored=ArtCredentialStore(directory=self.creds.directory);self.assertEqual(restored.get('qwen'),secret)
  # Inspect actual DACL protection and exactly one current-user grant.
  from ctypes import wintypes
  adv=ctypes.WinDLL('advapi32',use_last_error=True);kernel=ctypes.WinDLL('kernel32');needed=wintypes.DWORD()
  adv.GetFileSecurityW.argtypes=[wintypes.LPCWSTR,wintypes.DWORD,ctypes.c_void_p,wintypes.DWORD,ctypes.POINTER(wintypes.DWORD)];adv.GetFileSecurityW.restype=wintypes.BOOL
  adv.ConvertSecurityDescriptorToStringSecurityDescriptorW.argtypes=[ctypes.c_void_p,wintypes.DWORD,wintypes.DWORD,ctypes.POINTER(wintypes.LPWSTR),ctypes.c_void_p];adv.ConvertSecurityDescriptorToStringSecurityDescriptorW.restype=wintypes.BOOL;kernel.LocalFree.argtypes=[ctypes.c_void_p]
  for target in (self.creds.directory,self.creds.path):
   adv.GetFileSecurityW(str(target),4,None,0,ctypes.byref(needed));buffer=ctypes.create_string_buffer(needed.value);self.assertTrue(adv.GetFileSecurityW(str(target),4,buffer,needed,ctypes.byref(needed)))
   text=wintypes.LPWSTR();self.assertTrue(adv.ConvertSecurityDescriptorToStringSecurityDescriptorW(buffer,1,4,ctypes.byref(text),None))
   try:self.assertIn('D:P',text.value);self.assertEqual(text.value.count('(A;'),1);self.assertNotIn(';;;WD)',text.value)
   finally:kernel.LocalFree(ctypes.cast(text,ctypes.c_void_p))
  # Wrong entropy/foreign-user equivalent decryption rejection is deliberately generic.
  broken=ArtCredentialStore(directory=self.creds.directory,unprotect=lambda raw:(_ for _ in ()).throw(OSError('foreign-user-test')))
  with self.assertRaises(CredentialError):broken.get('qwen')
  self.creds.path.write_bytes(b'corrupt synthetic credential file')
  with self.assertRaises(CredentialError):self.creds.get('qwen')
  self.assertNotIn(secret.encode(),self.creds.path.read_bytes())
 @unittest.skipUnless(os.name=='nt','Windows DPAPI persistence')
 def test_api_persist_session_relaunch_and_project_export_boundary(self):
  projectroot=self.root/'projects';store=ProjectStore(projectroot);self.addCleanup(store.close)
  document=store.create('Synthetic provider export',{'nodes':[],'edges':[],'viewport':{'x':0,'y':0,'zoom':1}})
  api=ArtDirectorAPI(store,credentials=self.creds);api.session_key='synthetic-persistence-only'
  h=Handler({'provider':'qwen','action':'persist-session','persistence':'local'});api.handle_post(h,'/api/art-director/config');self.assertEqual(h.output[0],200);self.assertEqual(h.output[1]['credentialSource'],'encrypted-local');self.assertEqual(api.session_key,'')
  relaunched=ArtDirectorAPI(store,credentials=ArtCredentialStore(directory=self.creds.directory));self.assertEqual(relaunched.status()['credentialSource'],'encrypted-local')
  self.assertNotIn('synthetic-persistence-only',json.dumps(store.get(document['id'])))
  for path in [self.creds.path.name,'runtime/'+self.creds.path.name,'.env.production']:
   with self.assertRaises(RuntimeError):assert_public_path(path)
  self.assertFalse(self.creds.path.resolve().is_relative_to(projectroot.resolve()))
  before=hashlib.sha256(self.creds.path.read_bytes()).hexdigest();archive_path=store.export(document['id'])
  with zipfile.ZipFile(archive_path) as archive:
   self.assertNotIn(self.creds.path.name,archive.namelist());self.assertNotIn(b'synthetic-persistence-only',b''.join(archive.read(name) for name in archive.namelist()))
  import_store=ProjectStore(self.root/'imported-projects');self.addCleanup(import_store.close);imported=import_store.import_zip(archive_path);self.assertNotIn('synthetic-persistence-only',json.dumps(imported));self.assertEqual(before,hashlib.sha256(self.creds.path.read_bytes()).hexdigest())

if __name__=='__main__':unittest.main()
