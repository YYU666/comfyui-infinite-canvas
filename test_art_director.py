import base64
import copy
import io
import json
import os
import unittest
import tempfile
from pathlib import Path
from art_director_credentials import ArtCredentialStore
import urllib.error
from unittest.mock import patch
from PIL import Image
from art_director import ArtDirectorAPI, image_data, validate_analysis, MAX_RESPONSE, ENDPOINT
from project_store import StoreError


def fixture():
    return {'schemaVersion':1,'sourceVersion':'v1','summary':'整体建议','strengths':'保留色彩','limitations':'估计几何','issues':[{'id':'i1','priority':'中','evidence':'审美建议','box':[.1,.2,.3,.4],'observation':'观察','impact':'影响','action':'动作','preserve':'保留','uncertainty':'估计'}],'guides':[{'id':'g1','kind':'rect','points':[[.1,.2],[.4,.6]],'label':'1 · 区域','issueId':'i1','hidden':False}]}


def png():
    out=io.BytesIO(); Image.new('RGB',(12,8),'#68a0cc').save(out,format='PNG');return 'data:image/png;base64,'+base64.b64encode(out.getvalue()).decode()

class Store:
    read_only=False
    def _project_path(self, pid):
        if pid!='prj_fixture':raise StoreError('NOT_FOUND','Project missing',404)
        return pid
    def _require_writable(self,path):
        if self.read_only:raise StoreError('READ_ONLY','Read only',403)
    def asset_file(self,pid,path):raise StoreError('BAD_REQUEST','Invalid local path',400)

class Handler:
    def __init__(self,payload):
        raw=json.dumps(payload).encode();self.rfile=io.BytesIO(raw);self.headers={'Content-Length':str(len(raw))};self.output=None
    def send_json(self,status,body):self.output=(status,body)

class TestArtDirector(unittest.TestCase):
    def setUp(self):
        self.env=patch.dict(os.environ,{'QWEN_API_KEY':'','DASHSCOPE_API_KEY':'','MOONSHOT_API_KEY':'','KIMI_API_KEY':'','ARK_API_KEY':'','DOUBAO_API_KEY':'','DEEPSEEK_API_KEY':''});self.env.start();self.addCleanup(self.env.stop)
        self.temp=tempfile.TemporaryDirectory(prefix='h3-art-provider-test-');self.addCleanup(self.temp.cleanup);self.creds=ArtCredentialStore(directory=Path(self.temp.name)/'private');self.store=Store();self.api=ArtDirectorAPI(self.store,credentials=self.creds);self.api.session_key='synthetic-secret-never-return'
        self.payload={'projectId':'prj_fixture','sourceVersion':'v1','brief':'主体清晰','preserve':'原风格','images':[{'slot':'artwork','purpose':'作品','image':png()}]}
    def error(self,call,code):
        with self.assertRaises(StoreError) as ctx:call()
        self.assertEqual(ctx.exception.code,code)
    def test_validation(self):
        self.assertEqual(validate_analysis(fixture(),'v1'),fixture())
        for change in (lambda v:v['guides'][0].update(kind='script'),lambda v:v['guides'][0].update(hidden='false'),lambda v:v['issues'][0].update(box=[.9,0,.2,.1]),lambda v:v.update(schemaVersion=True),lambda v:v['guides'][0].update(points=[[float('nan'),0],[1,1]])):
            value=fixture();change(value);self.error(lambda:validate_analysis(value,'v1'),'INVALID_ANALYSIS')
        self.error(lambda:validate_analysis(fixture(),'v2'),'INVALID_ANALYSIS')
    def test_images(self):
        self.assertTrue(image_data(png()).startswith('data:image/png;'))
        for invalid in ('https://evil/image.png','file:///private/key','data:image/svg+xml;base64,PHN2Zz4=','data:image/png;base64,YmFk'):
            self.error(lambda:image_data(invalid),'INVALID_ANALYSIS')
        self.error(lambda:image_data({'assetPath':'../../key'},self.store,'prj_fixture'),'BAD_REQUEST')
        out=io.BytesIO();Image.new('RGB',(5000,1)).save(out,format='PNG');self.error(lambda:image_data('data:image/png;base64,'+base64.b64encode(out.getvalue()).decode()),'INVALID_ANALYSIS')
    def test_config_redaction(self):
        h=Handler({'key':'new-session-key-123'});self.assertTrue(self.api.handle_post(h,'/api/art-director/config'));self.assertEqual(h.output[0],200);self.assertEqual(self.api.key(),'new-session-key-123');self.assertNotIn('new-session-key',json.dumps(h.output))
        status=Handler({});self.api.handle_get(status,'/api/art-director/status');self.assertEqual(status.output[1]['credentialSource'],'session');self.assertNotIn('new-session-key',json.dumps(status.output))
        h=Handler({'key':''});self.api.handle_post(h,'/api/art-director/config');self.assertFalse(h.output[1]['configured'])
        self.error(lambda:self.api.analyze(self.payload),'QWEN_NOT_CONFIGURED')
        with patch.dict(os.environ,{'QWEN_API_KEY':'environment-test-key'}):self.assertEqual(self.api.key(),'environment-test-key')
    def test_mock_provider_contract(self):
        def open_mock(request,timeout):
            self.assertEqual(request.full_url,ENDPOINT);self.assertEqual(timeout,45);self.assertEqual(request.get_header('Authorization'),'Bearer synthetic-secret-never-return')
            body=json.loads(request.data);self.assertIs(body['enable_thinking'],False);self.assertEqual(body['model'],'qwen3-vl-plus');self.assertEqual(body['response_format'],{'type':'json_object'})
            self.assertEqual(body['messages'][1]['content'][-1]['type'],'image_url')
            return io.BytesIO(json.dumps({'choices':[{'finish_reason':'stop','message':{'content':json.dumps(fixture())}}]}).encode())
        self.api.opener=open_mock;result=self.api.analyze(self.payload);self.assertEqual(result['analysis']['sourceVersion'],'v1');self.assertNotIn(self.api.key(),json.dumps(result));self.error(lambda:self.api.analyze(self.payload),'RATE_LIMITED')
    def test_timeout_auth_rate_malformed(self):
        for error,code in ((TimeoutError(),'QWEN_TIMEOUT'),(urllib.error.HTTPError(ENDPOINT,401,'denied',{},None),'QWEN_AUTH'),(urllib.error.HTTPError(ENDPOINT,429,'limited',{},None),'QWEN_RATE_LIMIT'),(urllib.error.URLError('no network'),'QWEN_NETWORK')):
            api=ArtDirectorAPI(self.store,credentials=self.creds,opener=lambda *a,_e=error,**kw:(_ for _ in ()).throw(_e));api.session_key=self.api.key();self.error(lambda:api.analyze(self.payload),code);self.assertTrue(api.busy.acquire(False))
        for raw in (b'not json',json.dumps({'choices':[{'finish_reason':'length','message':{'content':'{}'}}]}).encode(),b' '* (MAX_RESPONSE+1)):
            api=ArtDirectorAPI(self.store,credentials=self.creds,opener=lambda *a,_raw=raw,**kw:io.BytesIO(_raw));api.session_key=self.api.key()
            with self.assertRaises(StoreError):api.analyze(self.payload)
    def test_readonly_busy_bounds(self):
        self.store.read_only=True;self.error(lambda:self.api.analyze(self.payload),'READ_ONLY');self.store.read_only=False
        self.api.busy.acquire();self.error(lambda:self.api.analyze(self.payload),'ART_DIRECTOR_BUSY')
        self.api.busy.release();h=Handler({});h.headers['Content-Length']=str(30*1024*1024);self.api.handle_post(h,'/api/art-director/analyze');self.assertEqual(h.output[0],400)

if __name__=='__main__': unittest.main()
