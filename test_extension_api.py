import io
import json
from pathlib import Path
import tempfile
import unittest

from extension_api import ExtensionAPI
from workflow_extensions import ExtensionStore
from test_workflow_extensions import workflow_fixture, info_fixture, rewrite_package
from workflow_extensions import convert_api_json


class Handler:
    def __init__(self, body=b"", headers=None):
        self.headers = {"Content-Length": str(len(body)), **(headers or {})}
        self.rfile = io.BytesIO(body)
        self.wfile = io.BytesIO()
        self.response_headers = {}

    def send_json(self, status, payload):
        self.status, self.payload = status, payload

    def send_response(self, status):
        self.status = status

    def send_header(self, key, value):
        self.response_headers[key] = value

    def end_headers(self):
        pass


class APITests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = ExtensionStore(Path(self.temp.name) / "extensions")
        self.api = ExtensionAPI(self.store, object_info=info_fixture)

    def test_import_get_prepare_download(self):
        handler = Handler(json.dumps(workflow_fixture()).encode(), {"X-Filename": "%E4%B8%89%E5%9B%BE.json"})
        self.assertTrue(self.api.handle_post(handler, "/api/extensions/import"))
        self.assertEqual(handler.status, 200)
        digest = handler.payload["digest"]
        self.assertEqual(handler.payload["manifest"]["name"], "三图")
        handler = Handler()
        self.api.handle_get(handler, "/api/extensions/" + digest)
        self.assertEqual(handler.status, 200)
        self.api.handle_get(handler, "/api/extensions/" + digest + "/download")
        self.assertTrue(handler.wfile.getvalue().startswith(b"PK"))
        payload = {"nodeDefinitionId": "workflow", "inputs": {"image_a": "a.png", "image_b": "b.png", "image_c": "c.png"}, "parameters": {}}
        handler = Handler(json.dumps(payload).encode())
        self.api.handle_post(handler, "/api/extensions/" + digest + "/prepare")
        self.assertEqual(handler.status, 200)
        self.assertEqual(set(handler.payload), {"workflow", "outputs", "digest"})

    def test_invalid_lengths_do_not_mutate(self):
        for headers in ({"Content-Length": "67108865"}, {"Content-Length": "-1"}, {"Content-Length": "4"}, {"Content-Length": "no"}, {"Transfer-Encoding": "chunked"}):
            handler = Handler(b"{}", headers)
            self.api.handle_post(handler, "/api/extensions/import")
            self.assertGreaterEqual(handler.status, 400)
            self.assertFalse(self.store.root.exists())

    def test_unknown_digest_and_endpoint(self):
        handler = Handler()
        self.api.handle_get(handler, "/api/extensions/" + "0" * 64)
        self.assertEqual(handler.status, 404)
        self.assertFalse(self.api.handle_get(handler, "/api/projects"))
        self.api.handle_get(handler, "/api/extensions/../escape")
        self.assertGreaterEqual(handler.status, 400)

    def test_malformed_display_and_identity_return_400_without_write(self):
        package = convert_api_json(json.dumps(workflow_fixture()).encode())
        for section, mutation in (("manifest.json", lambda v: v.update(type=[])), ("nodes/workflow.json", lambda v: v["outputs"][0].update(nodeId=[])), ("nodes/workflow.json", lambda v: v["inputs"][0].update(label={})), ("nodes/workflow.json", lambda v: v["outputs"][0].update(description=[])), ("nodes/workflow.json", lambda v: v["parameters"]["properties"]["node_mix__steps"].update(title={})), ("nodes/workflow.json", lambda v: v["parameters"]["properties"]["node_mix__steps"].update(type=[]))):
            def mutate(files):
                value = json.loads(files[section])
                mutation(value)
                files[section] = json.dumps(value).encode()
            handler = Handler(rewrite_package(package, mutate))
            self.api.handle_post(handler, "/api/extensions/import")
            self.assertEqual(handler.status, 400)
            self.assertFalse(self.store.root.exists())


if __name__ == "__main__":
    unittest.main()
