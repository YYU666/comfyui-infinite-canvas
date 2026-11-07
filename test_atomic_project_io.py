import errno,io,json,os,tempfile,threading,time,unittest
from pathlib import Path
from unittest.mock import patch
import workbench_lifecycle as lifecycle
from project_store import ProjectStore,_safe_project_file
from project_api import ProjectAPI

class AtomicFixTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
 def tearDown(self):self.tmp.cleanup()
 def test_unique_writers(self):
  p=self.root/'value.json';barrier=threading.Barrier(2);real=os.replace;names=[];errors=[]
  def replace(src,dst):
   first=src not in names
   if first:names.append(src);barrier.wait(3)
   return real(src,dst)
  def write(i):
   try:lifecycle.atomic_write_json(p,{'value':i})
   except Exception as e:errors.append(e)
  with patch.object(lifecycle.os,'replace',replace):
   a=threading.Thread(target=write,args=(1,));b=threading.Thread(target=write,args=(2,));a.start();b.start();a.join();b.join()
  self.assertFalse(errors);self.assertEqual(len(set(names)),2);self.assertIn(json.loads(p.read_text())['value'],[1,2]);self.assertFalse(list(self.root.glob('*.tmp')))
 @unittest.skipUnless(os.name=='nt','Windows file sharing')
 def test_real_reader_releases_then_replace_succeeds(self):
  p=self.root/'value.json';lifecycle.atomic_write_json(p,{'old':1});reader=p.open('r');closed=threading.Event()
  def release():time.sleep(.06);reader.close();closed.set()
  t=threading.Thread(target=release);t.start();lifecycle.atomic_write_json(p,{'new':1});t.join();self.assertTrue(closed.is_set());self.assertEqual(json.loads(p.read_text()),{'new':1})
 def test_bounded_permanent_denial_and_nontransient(self):
  p=self.root/'value.json';lifecycle.atomic_write_json(p,{'old':1})
  for code,win,expected in [(errno.EACCES,5,50 if os.name=='nt' else 1),(errno.ENOSPC,112,1)]:
   error=OSError(code,'secret-path');error.winerror=win
   with patch.object(lifecycle.os,'replace',side_effect=error) as replace,patch.object(lifecycle.time,'sleep') as sleep:
    with self.assertRaises(OSError):lifecycle.atomic_write_json(p,{'new':1})
    self.assertEqual(replace.call_count,expected);self.assertEqual(sleep.call_count,expected-1)
   self.assertEqual(json.loads(p.read_text()),{'old':1});self.assertFalse(list(self.root.glob('*.tmp')))
  with patch.object(lifecycle.os,'replace') as replace:
   with self.assertRaises(TypeError):lifecycle.atomic_write_json(p,{'bad':object()})
   replace.assert_not_called()
 @unittest.skipUnless(os.name=='nt','Windows file sharing')
 def test_actual_asset_registration_after_reader_contention(self):
  store=ProjectStore(self.root/'projects','fixture');doc=store.create('p');p=self.root/'projects/p/project.json'
  reader=p.open('r')
  t=threading.Thread(target=lambda:(time.sleep(.06),reader.close()));t.start()
  result=store.put_asset(doc['id'],'normal-valid.png',io.BytesIO(b'fixture'),'image/png',expected_revision=1)
  t.join();self.assertEqual(result['revision'],2);self.assertIn(result['asset'],store.get(doc['id'])['assets'])
  with self.assertRaises(Exception) as caught:store.put_asset(doc['id'],'normal-valid.png',io.BytesIO(b'fixture'),'image/png',expected_revision=1)
  self.assertEqual(caught.exception.code,'REVISION_CONFLICT');self.assertEqual(store.get(doc['id'])['revision'],2);store.close()
 def test_cleanup_old_and_uuid_only_dead_writer(self):
  p=self.root/'project.json';store=ProjectStore(self.root/'projects','fixture');doc=store.create('p');p=self.root/'projects/p/project.json'
  active=p.with_name(f'.project.json.{os.getpid()}.{"a"*32}.tmp');active.write_text('active')
  old=p.with_name('.project.json.99999999.tmp');old.write_text('dead')
  new=p.with_name('.project.json.99999999.'+'b'*32+'.tmp');new.write_text('dead')
  with patch('project_store._writer_running',side_effect=lambda pid:pid==os.getpid()):_safe_project_file(p)
  self.assertTrue(active.exists());self.assertFalse(old.exists());self.assertFalse(new.exists());store.close()
 def test_heartbeat_waits_for_project_guard(self):
  store=ProjectStore(self.root/'projects','fixture');store.create('p');p=self.root/'projects/p/project.json';lock=p.parent/'.lock'
  lifecycle.atomic_write_json(lock,{'owner':store.owner_id,'pid':os.getpid(),'heartbeat':0});store._held.add((lock,store.owner_id))
  class Cycle:
   count=0
   def wait(self,n):self.count+=1;return self.count>1
   def set(self):pass
  store._heartbeat_stop=Cycle();started=threading.Event();writes=[]
  def beat():started.set();store._heartbeat()
  with patch('project_store.atomic_write_json',side_effect=lambda path,payload:writes.append(path)):
   with store._guard(p):
    t=threading.Thread(target=beat);t.start();started.wait();time.sleep(.03);self.assertEqual(writes,[])
   t.join(2);self.assertFalse(t.is_alive());self.assertEqual(writes,[lock])
  store.close()
 def test_api_redacted_io_and_cas(self):
  store=ProjectStore(self.root/'projects','fixture');doc=store.create('p');api=ProjectAPI(store)
  class Handler:
   headers={'Content-Length':'1','If-Match':'1','Content-Type':'image/png'}
   rfile=io.BytesIO(b'x')
   def send_json(self,status,body):self.status=status;self.body=body
  h=Handler();error=PermissionError(errno.EACCES,'private secret path','C:/PRIVATE/secret.png')
  with patch.object(store,'put_asset',side_effect=error),self.assertLogs('project_api',level='ERROR') as logs:
   self.assertTrue(api.handle_put(h,'/api/projects/'+doc['id']+'/assets/a.png'))
  self.assertEqual(h.status,503);self.assertEqual(h.body['code'],'PROJECT_IO_ERROR');self.assertNotIn('PRIVATE',' '.join(logs.output));self.assertNotIn('secret',' '.join(logs.output));self.assertIn('incident=',logs.output[0])
  from project_store import StoreError
  with patch.object(store,'put_asset',side_effect=StoreError('REVISION_CONFLICT','conflict',409)):
   api.handle_put(h,'/api/projects/'+doc['id']+'/assets/a.png')
  self.assertEqual(h.status,409);self.assertEqual(h.body['code'],'REVISION_CONFLICT');store.close()
if __name__=='__main__':unittest.main()
