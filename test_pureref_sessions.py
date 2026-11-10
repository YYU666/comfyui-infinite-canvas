"""Real embedded worker, incremental upload, ownership and revision regressions."""
import io
import json
import os
from pathlib import Path
import shutil
import sqlite3
import sys
import subprocess
import tempfile
import time
import threading
import unittest
from unittest.mock import patch

from project_store import ProjectStore
from pureref_import import PureRefError
import pureref_sessions as sessions
import pureref_worker as worker
from test_pureref_import import fixture, pack, raster


class Socket:
    def gettimeout(self): return None
    def settimeout(self, value): pass


class Handler:
    def __init__(self, body=b'', headers=None, path=''):
        self.headers = {'Content-Length':str(len(body)),**(headers or {})}
        self.rfile = io.BytesIO(body); self.wfile = io.BytesIO(); self.connection = Socket(); self.path = path
        self.status = None
    def send_json(self, status, result): self.status,self.result = status,result
    def send_response(self, status): self.status = status
    def send_header(self, *args): pass
    def end_headers(self): pass


class DiskParserTests(unittest.TestCase):
    def run_fixture(self, raw):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary).resolve()
            (directory/'upload.pur').write_bytes(raw)
            worker.extract(directory,lambda *a,**kw:None)
            result = json.loads((directory/'resources.json').read_text(encoding='utf-8'))
            return result,[(directory/(i['handle']+'.original')).read_bytes() for i in result['images']]

    def test_preserves_originals_dedupe_skips_external_and_orphans(self):
        data = raster()
        result,originals = self.run_fixture(fixture([(1,1,data,12,8),(2,1,data,12,8),(3,2,None,12,8),(4,1,b'bad orphan',12,8)],[(1,1),(2,1),(3,2),(4,3)]))
        self.assertEqual(originals,[data]); self.assertEqual(result['duplicates'],2); self.assertEqual(result['skippedExternal'],1)
        self.assertNotIn('base64',json.dumps(result)); self.assertNotIn('PRIVATE-PATH',json.dumps(result))

    def test_rejects_envelope_checksum_schema_decode_and_missing_base(self):
        cases = [b'x',fixture()[:-1],fixture(extra_sql='DELETE FROM items'),fixture(extra_sql='DROP TABLE items; CREATE VIEW items AS SELECT id FROM images'),fixture([(1,1,b'bad',12,8)])]
        valid = bytearray(fixture()); valid[-1] ^= 1; cases.append(bytes(valid))
        for raw in cases:
            with self.subTest(size=len(raw)),self.assertRaises((PureRefError,sqlite3.Error)): self.run_fixture(raw)

    def test_dynamic_blob_metadata_is_rejected_before_any_blob_reader(self):
        for column, table in [('width','images'),('height','images'),('source_type','images'),('image','items_images')]:
            raw=fixture(extra_sql=f"UPDATE {table} SET {column}=zeroblob(1000000)")
            with self.subTest(column=column),self.assertRaises(PureRefError): self.run_fixture(raw)

    def test_non_alias_primary_key_never_reads_wrong_blob(self):
        con = sqlite3.connect(':memory:')
        con.execute('PRAGMA user_version=200101'); con.execute('PRAGMA application_id=940753918')
        con.execute('CREATE TABLE images(id INTEGER PRIMARY KEY DESC,source_type INTEGER,data BLOB,width INTEGER,height INTEGER)')
        con.execute('CREATE TABLE items(id INTEGER PRIMARY KEY)'); con.execute('CREATE TABLE items_images(id INTEGER PRIMARY KEY,image INTEGER)')
        con.execute('INSERT INTO images VALUES(99,1,?,12,8)',(raster(),)); con.execute('INSERT INTO items VALUES(1)'); con.execute('INSERT INTO items_images VALUES(1,99)'); con.commit()
        raw = pack(con.serialize()); con.close()
        with self.assertRaises(PureRefError): self.run_fixture(raw)

    def test_limits_before_blob_decode(self):
        for key,value in [('MAX_IMAGE',10),('MAX_PIXELS',1),('MAX_RESOURCES',0),('MAX_INSTANCES',0),('MAX_SOURCE',100)]:
            with self.subTest(key=key),patch.object(worker,key,value),self.assertRaises(PureRefError): self.run_fixture(fixture())

    def test_case_insensitive_rowid_shadow_cannot_import_unreferenced_resource(self):
        for spelling in ['ROWID','rOwId']:
            con=sqlite3.connect(':memory:')
            con.execute('PRAGMA user_version=200101');con.execute('PRAGMA application_id=940753918')
            con.execute(f'CREATE TABLE images(id INTEGER PRIMARY KEY DESC,source_type INTEGER,data BLOB,width INTEGER,height INTEGER,{spelling} INTEGER)')
            con.execute('CREATE TABLE items(id INTEGER PRIMARY KEY)');con.execute('CREATE TABLE items_images(id INTEGER PRIMARY KEY,image INTEGER)')
            con.execute('INSERT INTO images(_rowid_,id,source_type,data,width,height,ROWID) VALUES(1,99,1,?,12,8,99)',(raster(),))
            con.execute('INSERT INTO images(_rowid_,id,source_type,data,width,height,ROWID) VALUES(99,100,1,?,12,8,100)',(raster('blue'),))
            con.execute('INSERT INTO items VALUES(1)');con.execute('INSERT INTO items_images VALUES(1,99)');con.commit()
            raw=pack(con.serialize());con.close()
            with self.subTest(spelling=spelling),self.assertRaises(PureRefError): self.run_fixture(raw)


class SessionTests(unittest.TestCase):
    @unittest.skipUnless(os.name == 'nt', 'Windows 8.3 aliases only')
    def test_short_cache_path_is_canonicalized_before_security_checks(self):
        import ctypes
        parent = self.directory/'long cache parent directory'
        parent.mkdir()
        short = ctypes.create_unicode_buffer(32768)
        self.assertTrue(ctypes.windll.kernel32.GetShortPathNameW(str(parent),short,len(short)))
        if Path(short.value) == parent:
            self.skipTest('8.3 name creation disabled on this volume')
        manager = sessions.PureRefSessions(self.store,Path(short.value)/'cache')
        manager._safe_root()
        self.assertEqual(manager.root,(parent/'cache').resolve())
        self.assertTrue((manager.root/sessions.ROOT_MARKER).is_file())
        manager.close()

    def test_reparse_cache_component_is_rejected_before_acl(self):
        from types import SimpleNamespace
        original = Path.lstat
        def inspect(path, *args, **kwargs):
            if path == self.manager.root:
                return SimpleNamespace(st_mode=sessions.stat.S_IFDIR,st_file_attributes=0x400)
            return original(path,*args,**kwargs)
        with patch.object(Path,'lstat',inspect), patch.object(sessions,'private_acl',side_effect=AssertionError('must reject before ACL')):
            with self.assertRaises(PureRefError): self.manager._safe_root()

    def test_cancel_waiting_for_finish_stops_new_worker_before_cleanup(self):
        self.create()
        session = self.manager.sessions[self.session['id']]
        errors = []
        class Child:
            pid = 0
            stopped = False
            def poll(self): return 0 if self.stopped else None
            def kill(self): self.stopped = True
            def wait(self, timeout): return 0
        child = Child()
        def cleanup():
            try: self.manager._cleanup(session)
            except Exception as error: errors.append(error)
        with session['lock']:
            thread = threading.Thread(target=cleanup)
            thread.start()
            self.assertTrue(session['cancel'].wait(2))
            session['process'] = child
        thread.join(3)
        self.assertFalse(thread.is_alive())
        self.assertEqual(errors,[])
        self.assertTrue(child.stopped)
        self.assertFalse(session['path'].exists())
        self.manager.sessions.pop(self.session['id'])

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(); self.directory = Path(self.temporary.name).resolve()
        self.store = ProjectStore(self.directory/'projects')
        self.project = self.store.create('synthetic')
        self.manager = sessions.PureRefSessions(self.store,self.directory/'staging')
    def tearDown(self):
        self.manager.close(); self.store.close(); self.temporary.cleanup()
    def call(self, method, route, data=None, body=None, headers=None, cap=True):
        raw = body if body is not None else json.dumps(data or {}).encode() if method == 'POST' else b''
        supplied = dict(headers or {})
        if cap and hasattr(self,'session'): supplied['X-PureRef-Session'] = self.session['capability']
        handler = Handler(raw,supplied,route)
        self.assertTrue(self.manager.handle(handler,method,route.split('?')[0]))
        return handler
    def create(self, raw=None):
        self.raw = raw or fixture()
        handler = self.call('POST','/api/pureref/sessions',dict(projectId=self.project['id'],size=len(self.raw)),cap=False)
        self.assertEqual(handler.status,201,getattr(handler,'result',None))
        self.session = handler.result; self.endpoint = '/api/pureref/sessions/'+self.session['id']
    def ready(self):
        self.create()
        self.assertEqual(self.call('PUT',self.endpoint+'/upload',body=self.raw,headers={'X-Upload-Offset':'0'}).status,200)
        self.assertEqual(self.call('POST',self.endpoint+'/finish').status,202)
        self.assertEqual(self.call('POST',self.endpoint+'/finish').status,202)
        deadline = time.monotonic()+20
        while time.monotonic() < deadline:
            status = self.call('GET',self.endpoint+'/status').result
            self.assertNotEqual(status['phase'],'error',status)
            if status['phase'] == 'ready': return self.call('GET',self.endpoint+'/resources?offset=0&limit=64').result['images']
            time.sleep(.05)
        self.fail('actual embedded worker timed out')

    def test_real_worker_copy_revision_receipt_preview_delete(self):
        images = self.ready(); image = images[0]
        preview = self.call('GET',self.endpoint+'/resources/'+image['handle']+'/preview')
        self.assertEqual(preview.status,200); self.assertLess(len(preview.wfile.getvalue()),128*1024)
        route = self.endpoint+'/resources/'+image['handle']+'/copy'
        self.assertEqual(self.call('POST',route,dict(projectId='wrong'),headers={'If-Match':'1'}).status,409)
        self.assertEqual(self.call('POST',route,dict(projectId=self.project['id'])).status,400)
        saved = self.call('POST',route,dict(projectId=self.project['id']),headers={'If-Match':str(self.project['revision'])})
        self.assertEqual(saved.status,200,saved.result)
        retry = self.call('POST',route,dict(projectId=self.project['id']),headers={'If-Match':str(self.project['revision'])})
        self.assertEqual(retry.result,saved.result)
        document = self.store.get(self.project['id'])
        self.assertEqual(document['canvas']['nodes'],[])
        self.assertEqual((self.store._project_path(self.project['id']).parent/saved.result['asset']['path']).read_bytes(),raster())
        self.assertEqual(self.call('DELETE',self.endpoint).status,200)
        self.assertEqual(self.call('GET',self.endpoint+'/status').status,404)
        self.assertEqual([p.name for p in self.manager.root.iterdir()],[sessions.ROOT_MARKER])

    def test_offsets_bounds_capability_and_no_content_in_status(self):
        self.create()
        self.assertEqual(self.call('GET',self.endpoint+'/status',cap=False).status,404)
        self.assertEqual(self.call('PUT',self.endpoint+'/upload',body=b'x',headers={'X-Upload-Offset':'1'}).status,409)
        half = len(self.raw)//2
        self.assertEqual(self.call('PUT',self.endpoint+'/upload',body=self.raw[:half],headers={'X-Upload-Offset':'0'}).status,200)
        self.assertEqual(self.call('PUT',self.endpoint+'/upload',body=self.raw[:half],headers={'X-Upload-Offset':'0'}).status,409)
        status = self.call('GET',self.endpoint+'/status').result
        self.assertEqual(status['bytes'],half); self.assertNotIn('capability',status)
        self.assertEqual(self.call('POST',self.endpoint+'/finish').status,409)
        self.assertEqual(self.call('GET',self.endpoint+'/resources?limit=65').status,409)

    def test_failed_chunk_rolls_back_and_disk_full_rejects(self):
        self.create()
        handler = Handler(b'abc',{'Content-Length':'100','X-Upload-Offset':'0','X-PureRef-Session':self.session['capability']},self.endpoint+'/upload')
        self.manager.handle(handler,'PUT',self.endpoint+'/upload'); self.assertEqual(handler.status,400)
        session = self.manager.sessions[self.session['id']]
        self.assertEqual((session['path']/'upload.pur').stat().st_size,0); self.assertEqual(session['offset'],0)
        with patch.object(sessions.shutil,'disk_usage',return_value=type('Disk',(),{'free':0})()):
            self.assertEqual(self.call('PUT',self.endpoint+'/upload',body=b'x',headers={'X-Upload-Offset':'0'}).status,507)

    def test_rejects_project_directory_and_unowned_cleanup(self):
        unsafe = sessions.PureRefSessions(self.store,self.store.root/'bad')
        with self.assertRaises(PureRefError): unsafe._safe_root()
        self.create(); session=self.manager.sessions[self.session['id']]
        (session['path']/'owner.json').write_text('unknown')
        self.assertEqual(self.call('DELETE',self.endpoint).status,503)
        self.assertTrue(session['path'].exists())
        (session['path']/'owner.json').write_text(session['marker'])

    def test_crash_status_and_bounded_worker_kill(self):
        self.create(); self.call('PUT',self.endpoint+'/upload',body=self.raw,headers={'X-Upload-Offset':'0'})
        original = subprocess.Popen
        with patch.object(sessions,'WORKER_RSS',1), patch.object(sessions.subprocess,'Popen',side_effect=lambda *a,**kw: original([sys.executable,'-c','import time;time.sleep(30)'],**kw)):
            self.call('POST',self.endpoint+'/finish'); time.sleep(.6)
            status=self.call('GET',self.endpoint+'/status').result
            self.assertEqual(status['phase'],'error',status)
            self.assertIsNotNone(self.manager.sessions[self.session['id']]['process'].poll())

    def test_existing_nonempty_cache_root_rejected_before_acl(self):
        existing=self.directory/'unrelated';existing.mkdir();(existing/'keep.txt').write_text('keep')
        manager=sessions.PureRefSessions(self.store,existing)
        with patch.object(sessions,'private_acl',side_effect=AssertionError('must reject before ACL')),self.assertRaises(PureRefError): manager._safe_root()
        self.assertEqual((existing/'keep.txt').read_text(),'keep')

    def test_status_retries_transient_windows_read_denial(self):
        self.ready(); original=Path.read_text; attempts=[]
        def read(path,*args,**kwargs):
            if path.name == 'status.json':
                attempts.append(1)
                if len(attempts)<3: raise PermissionError('synthetic sharing violation')
            return original(path,*args,**kwargs)
        with patch.object(Path,'read_text',read):
            result=self.call('GET',self.endpoint+'/status')
        self.assertEqual(result.status,200);self.assertEqual(result.result['phase'],'ready');self.assertEqual(len(attempts),3)

    def test_invalid_or_permanently_missing_status_never_uses_previous_ready(self):
        self.ready();session=self.manager.sessions[self.session['id']]
        status=session['path']/'status.json'
        self.assertEqual(self.call('GET',self.endpoint+'/status').result['phase'],'ready')
        status.write_text('not json')
        self.assertEqual(self.call('GET',self.endpoint+'/status').status,400)
        status.unlink()
        with patch.object(sessions.time,'sleep',return_value=None):
            self.assertEqual(self.call('GET',self.endpoint+'/status').status,400)

    def test_atomic_status_writer_reader_stays_consistent(self):
        self.ready();session=self.manager.sessions[self.session['id']];errors=[]
        def write():
            try:
                for i in range(120): sessions.atomic_write_json(session['path']/'status.json',dict(phase='ready',count=1,sequence=i))
            except Exception as error: errors.append(type(error).__name__)
        writer=threading.Thread(target=write);writer.start()
        for i in range(120): self.assertEqual(self.call('GET',self.endpoint+'/status').status,200)
        writer.join();self.assertEqual(errors,[])

    def test_restart_recovers_only_dead_owned_flat_directories(self):
        self.create(); session=self.manager.sessions[self.session['id']]
        data=json.loads(session['marker']); data['pid']=99999999
        (session['path']/'owner.json').write_text(json.dumps(data))
        self.manager.sessions.clear()
        unknown=self.manager.root/'keep-unowned'; unknown.mkdir()
        replacement=sessions.PureRefSessions(self.store,self.manager.root)
        replacement._safe_root(); self.assertFalse(session['path'].exists()); self.assertTrue(unknown.exists()); replacement.close()

    def test_cancel_terminates_actual_process_and_cleans_only_session(self):
        self.create();self.call('PUT',self.endpoint+'/upload',body=self.raw,headers={'X-Upload-Offset':'0'})
        original=subprocess.Popen
        with patch.object(sessions.subprocess,'Popen',side_effect=lambda *a,**kw: original([sys.executable,'-c','import time;time.sleep(30)'],**kw)):
            self.call('POST',self.endpoint+'/finish')
        process=self.manager.sessions[self.session['id']]['process']
        started=time.monotonic();self.assertEqual(self.call('DELETE',self.endpoint).status,200)
        self.assertLess(time.monotonic()-started,3);self.assertIsNotNone(process.poll())
        self.assertEqual(self.store.get(self.project['id'])['canvas']['nodes'],[])

    def test_symlink_fixed_file_rejected_and_outside_preserved(self):
        self.create();session=self.manager.sessions[self.session['id']]
        outside=self.directory/'outside.json';outside.write_text('{"private":"untouched"}')
        link=session['path']/'status.json'
        try: link.symlink_to(outside)
        except OSError: self.skipTest('Windows symlink privilege unavailable')
        self.assertEqual(self.call('GET',self.endpoint+'/status').status,503)
        self.assertEqual(self.call('DELETE',self.endpoint).status,503)
        self.assertEqual(outside.read_text(),'{"private":"untouched"}')
        link.unlink()

    def test_copy_capacity_preflight_before_any_store_write(self):
        images=self.ready();document=self.store.get(self.project['id'])
        document['canvas']['nodes']=[dict(id=f'n-{i}',type='note',position=dict(x=0,y=0),data={}) for i in range(4096)]
        updated=self.store.save(self.project['id'],document,document['revision'])
        with patch.object(self.store,'put_asset',side_effect=AssertionError('capacity must precede copy')):
            response=self.call('POST',self.endpoint+'/resources/'+images[0]['handle']+'/copy',dict(projectId=self.project['id']),headers={'If-Match':str(updated['revision'])})
            self.assertEqual(response.status,409)


if __name__ == '__main__': unittest.main()
