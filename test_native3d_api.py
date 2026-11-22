import io
import json
import unittest
from unittest.mock import Mock
from native3d_api import Native3DAPI
from project_store import StoreError

class Native3DAPITests(unittest.TestCase):
    def setUp(self):
        self.jobs = Mock()
        self.api = Native3DAPI(self.jobs)
        self.handler = Mock()
        self.handler.path = '/api/native3d/jobs?projectId=prj_test'
        self.handler.headers = {}
    def test_list_filter(self):
        self.jobs.list.return_value=[]
        self.assertTrue(self.api.handle_get(self.handler,'/api/native3d/jobs'))
        self.jobs.list.assert_called_once_with('prj_test')
        self.handler.send_json.assert_called_once_with(200,{'jobs':[]})
    def test_bad_json_and_bound(self):
        for content,length in [(b'[]',2),(b'{',1),(b'{}',65537)]:
            self.handler.reset_mock()
            self.handler.headers={'Content-Length':str(length)}
            self.handler.rfile=io.BytesIO(content)
            self.jobs.submit.side_effect=StoreError('BAD_REQUEST','Invalid payload')
            self.api.handle_post(self.handler,'/api/native3d/jobs')
            self.assertEqual(400,self.handler.send_json.call_args.args[0])
    def test_cancel_exact_route(self):
        job_id='n3d_'+'a'*32
        self.jobs.cancel.return_value={'status':'cancelled'}
        self.api.handle_post(self.handler,'/api/native3d/jobs/'+job_id+'/cancel')
        self.jobs.cancel.assert_called_once_with(job_id)
    def test_stage_diagnostic_query_boolean_and_invalid(self):
        from pathlib import Path
        import tempfile
        job='n3d_'+'a'*32
        route=f'/api/native3d/jobs/{job}/stage-preview/lod3'
        with tempfile.TemporaryDirectory() as folder:
            image=Path(folder)/'fixture.png';image.write_bytes(b'png-fixture')
            self.jobs.stage_preview.return_value=image
            for query,expected in [('',False),('?diagnostic=false',False),('?diagnostic=true',True)]:
                with self.subTest(query=query):
                    self.jobs.stage_preview.reset_mock();self.handler.reset_mock()
                    self.handler.path=route+query;self.handler.wfile=io.BytesIO()
                    self.assertTrue(self.api.handle_get(self.handler,route))
                    self.jobs.stage_preview.assert_called_once_with(job,'lod3',diagnostic=expected)
                    self.assertEqual(self.handler.wfile.getvalue(),b'png-fixture')
            for query in ['?diagnostic=1','?diagnostic=True','?diagnostic=no','?diagnostic=true&diagnostic=false']:
                with self.subTest(query=query):
                    self.jobs.stage_preview.reset_mock();self.handler.reset_mock()
                    self.handler.path=route+query
                    self.assertTrue(self.api.handle_get(self.handler,route))
                    self.jobs.stage_preview.assert_not_called()
                    self.assertEqual(self.handler.send_json.call_args.args[0],400)

    def test_unrelated_not_claimed(self):
        self.assertFalse(self.api.handle_get(self.handler,'/api/projects'))
    def test_failed_diagnostic_route_binds_project_node_and_fixed_mode(self):
        from pathlib import Path
        import tempfile
        with tempfile.TemporaryDirectory() as folder:
            image=Path(folder)/'fixture.png';image.write_bytes(b'png-fixture')
            self.jobs.diagnostic_preview.return_value=image
            job='n3d_'+'a'*32
            self.handler.path=f'/api/native3d/jobs/{job}/diagnostic-preview/layout?projectId=prj_fixture&nodeId=uv_fixture'
            self.handler.wfile=io.BytesIO()
            self.api.handle_get(self.handler,self.handler.path.split('?')[0])
            self.jobs.diagnostic_preview.assert_called_once_with(job,'layout','prj_fixture','uv_fixture')
            self.assertEqual(self.handler.wfile.getvalue(),b'png-fixture')
            self.handler.send_header.assert_any_call('Cache-Control','no-store')

if __name__=='__main__': unittest.main()
