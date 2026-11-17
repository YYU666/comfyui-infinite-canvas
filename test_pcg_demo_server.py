"""Isolated HTTP/MCP contracts, identity publication and file boundary tests."""
import copy
import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest

from pcg_contracts import PCGError
from pcg_demo_server import DemoApplication, DemoHTTPServer
from test_pcg_demo_session import fixture_evidence


class DemoServerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.root = Path(self.temp.name)
        self.samples = self.root / 'approved'; self.samples.mkdir(); fixture_evidence(self.samples)
        self.app = DemoApplication(self.root / 'service', self.samples)
        self.server = DemoHTTPServer(self.app)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True); self.thread.start()
        self.report_sequence=0
    def tearDown(self):
        self.server.shutdown(); self.thread.join(); self.server.server_close(); self.app.close(); self.temp.cleanup()
    def request(self, path, value=None, headers=None, auth=True, raw=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=10)
        outgoing = {'Authorization': 'Bearer ' + self.app.token} if auth else {}
        if value is not None or raw is not None: outgoing['Content-Type'] = 'application/json'
        outgoing.update(headers or {})
        connection.request('POST' if value is not None or raw is not None else 'GET', path,
                           raw if raw is not None else json.dumps(value) if value is not None else None, outgoing)
        response = connection.getresponse(); body = response.read(); result = (response.status, dict(response.getheaders()), body)
        connection.close(); return result
    def json(self, path, value=None, **kwargs):
        status, headers, body = self.request(path, value, **kwargs)
        return status, json.loads(body), headers
    def ack(self, **kwargs):
        state = self.app.state()
        self.report_sequence+=1
        return {'clientId':'test-viewer', 'reportSequence':self.report_sequence, 'selectionEpoch':state['selectionEpoch'], 'assetId':state['desired']['assetId'],
                'status':'loaded', 'metrics':{'cameraFramed':True,'frameCount':1}, **kwargs}
    def test_static_cookie_csp_and_authenticated_state(self):
        status, headers, body = self.request('/', auth=False)
        self.assertEqual(status, 200); self.assertIn(b'<canvas', body)
        self.assertIn('HttpOnly; SameSite=Strict', headers['Set-Cookie'])
        self.assertIn("connect-src 'self'", headers['Content-Security-Policy'])
        self.assertEqual(self.request('/api/state', auth=False)[0], 401)
        cookie = headers['Set-Cookie'].split(';')[0]
        status, state, _ = self.json('/api/state', headers={'Cookie':cookie}, auth=False)
        self.assertEqual(status, 200); self.assertTrue(state['readOnly']); self.assertFalse(state['viewer']['loaded'])
        for path in ['/app.js','/glb.js','/renderer.js','/style.css']: self.assertEqual(self.request(path)[0], 200)
    def test_loopback_origin_rebinding_and_protected_ports(self):
        self.assertNotIn(self.server.server_port, [8188,8189,8790])
        for port in [8188,8189,8790,-1,65536]:
            with self.assertRaises(PCGError): DemoHTTPServer(self.app, port)
        for headers in [{'Host':'evil.invalid'}, {'Origin':'http://evil.invalid'}, {'Sec-Fetch-Site':'cross-site'}]:
            self.assertEqual(self.request('/', headers=headers, auth=False)[0],403)
        navigation={'Sec-Fetch-Site':'cross-site','Sec-Fetch-Mode':'navigate','Sec-Fetch-Dest':'document'}
        self.assertEqual(self.request('/',headers=navigation,auth=False)[0],200)
        self.assertEqual(self.request('/api/state',headers=navigation)[0],403)
    def test_asset_boundary_content_and_hash(self):
        selected=self.app.state()['desired']; status, headers, body=self.request(selected['url'])
        self.assertEqual(status,200); self.assertEqual(headers['Content-Type'],'model/gltf-binary'); self.assertEqual(body[:4],b'glTF')
        for path in ['/api/assets/../../LICENSE.glb','/api/assets/demoasset_unknown.glb','/../LICENSE','/instance.json']:
            self.assertNotEqual(self.request(path)[0],200)
        self.app.session.records[selected['assetId']].write_bytes(body[:-1]+b'x')
        self.assertEqual(self.json(selected['url'])[1]['code'],'ASSET_HASH_MISMATCH')
    def test_shared_descriptors_schema_examples_and_mcp(self):
        tools=self.app.tools['tools']
        guide=(Path(__file__).parent/'docs'/'pcg'/'DEMO_GUIDE.md').read_text(encoding='utf-8')
        for tool in tools:
            self.assertEqual(tool['inputSchema']['additionalProperties'],False)
            self.assertTrue(tool['examples']); self.assertTrue(tool['recovery'])
            self.assertIn(tool['name'],guide)
            for key in tool['inputSchema']['properties']: self.assertIn(key,guide)
        status, data, _=self.json('/mcp',{'jsonrpc':'2.0','id':1,'method':'tools/list'})
        self.assertEqual(status,200); self.assertEqual([t['name'] for t in data['result']['tools']],[t['name'] for t in tools])
        for name in ['pcg_demo_describe','pcg_demo_open','pcg_demo_read_state']:
            status, data, _=self.json('/mcp',{'jsonrpc':'2.0','id':2,'method':'tools/call','params':{'name':name,'arguments':{}}})
            self.assertEqual(status,200); self.assertFalse(data['result']['isError'])
        status, data, _=self.json('/api/tool',{'name':'pcg_demo_run','arguments':{'seed':-1}})
        self.assertEqual(status,400)
        status, data, _=self.json('/mcp',{'jsonrpc':'2.0','id':3,'method':'tools/call','params':{'name':'absent'}})
        self.assertTrue(data['result']['isError'])
    def test_loaded_ack_requires_draw_failure_preserves_identity_stale_rejected(self):
        self.assertEqual(self.request('/api/viewer',self.ack(metrics={'cameraFramed':False,'frameCount':10}))[0],409)
        self.assertEqual(self.request('/api/viewer',self.ack())[0],200)
        prior=copy.deepcopy(self.app.state()['viewer']['displayed']); old=self.ack()
        self.app.session.select(prior['assetId'])
        self.assertEqual(self.request('/api/viewer',old)[0],409)
        self.assertEqual(self.app.state()['viewer']['displayed'],prior)
        self.assertEqual(self.request('/api/viewer',self.ack(status='error',error='intentional fixture failure'))[0],200)
        self.assertEqual(self.app.state()['viewer']['displayed'],prior)
        self.assertEqual(self.request('/api/viewer',self.ack(status='context-lost'))[0],200)
        self.assertIsNone(self.app.state()['viewer']['displayed'])
    def test_report_ordering_and_idempotent_retry(self):
        loaded=self.ack(); self.app.acknowledge(loaded)
        self.assertEqual(self.app.acknowledge(loaded)['displayed']['assetId'],loaded['assetId'])
        self.app.acknowledge(self.ack(status='context-lost'))
        with self.assertRaises(PCGError) as caught: self.app.acknowledge(loaded)
        self.assertEqual(caught.exception.code,'STALE_REPORT')
        self.assertIsNone(self.app.state()['viewer']['displayed'])
    def test_malformed_bounded_inputs_and_ownership(self):
        for raw in ['{"a":1,"a":2}','{"value":NaN}','['*40+'0'+']'*40]:
            self.assertEqual(self.request('/api/tool',raw=raw)[0],400)
        self.assertEqual(self.request('/api/tool',raw='x'*32769)[0],400)
        self.assertEqual(self.request('/api/viewer',self.ack(metrics={'cameraFramed':True,'frameCount':True}))[0],409)
        with self.assertRaises(PCGError): DemoApplication(self.root / 'service')
        self.assertNotIn(self.app.token, json.dumps(self.app.state()))


if __name__=='__main__': unittest.main()
