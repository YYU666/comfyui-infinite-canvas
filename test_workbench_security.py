import json
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from project_api import ProjectAPI
from project_store import ProjectStore
from queue_api import QueueAPI
from video_workbench_launcher import WorkbenchHandler, WorkbenchServer
from workbench_queue import QueueManager


class SecurityProbeTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        root = Path(self.temporary.name)
        self.server = WorkbenchServer(("127.0.0.1", 0), WorkbenchHandler)
        self.server.token = "test-only-token"
        self.server.queue_manager = QueueManager(root / "queue.json", poll_interval=0.01)
        self.server.queue_api = QueueAPI(self.server.queue_manager)
        self.server.project_store = ProjectStore(root / "projects", "security-test")
        self.server.project_api = ProjectAPI(self.server.project_store)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=3)
        self.server.queue_manager.stop()
        self.server.project_store.close()
        self.temporary.cleanup()

    def request(self, method, path, payload=None, headers=None):
        body = payload
        if isinstance(payload, (dict, list)):
            body = json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(self.base + path, data=body, method=method, headers=headers or {})
        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                content = response.read()
                return response.status, response.headers, json.loads(content) if content and "application/json" in response.headers.get("Content-Type", "") else content
        except urllib.error.HTTPError as error:
            content = error.read()
            return error.code, error.headers, json.loads(content) if content else None

    def json_headers(self, token=True):
        headers = {"Content-Type": "application/json"}
        if token:
            headers["X-H3-Token"] = self.server.token
        return headers

    def test_host_origin_token_and_content_type_probes_are_rejected(self):
        status, _, body = self.request("GET", "/api/health", headers={"Host": "evil.example"})
        self.assertEqual((status, body["code"]), (403, "HOST_FORBIDDEN"))
        status, _, body = self.request("POST", "/api/queue", {"action": "pause"}, self.json_headers(token=False))
        self.assertEqual((status, body["code"]), (401, "UNAUTHORIZED"))
        self.assertFalse(self.server.queue_manager.snapshot()["paused"])
        status, _, body = self.request("POST", "/api/queue", b"action=pause", {"Content-Type": "text/plain", "X-H3-Token": self.server.token})
        self.assertEqual((status, body["code"]), (415, "UNSUPPORTED_MEDIA_TYPE"))
        status, _, body = self.request("POST", "/api/queue", {"action": "pause"}, {**self.json_headers(), "Origin": "https://evil.example"})
        self.assertEqual((status, body["code"]), (403, "ORIGIN_FORBIDDEN"))

    def test_http_only_same_site_cookie_authenticates_browser_api_requests(self):
        status, headers, _ = self.request("GET", "/")
        self.assertEqual(status, 200)
        cookie = headers.get("Set-Cookie", "")
        self.assertIn("HttpOnly", cookie)
        self.assertIn("SameSite=Strict", cookie)
        session = cookie.split(";", 1)[0]
        status, _, _ = self.request("GET", "/api/projects", headers={"Cookie": session})
        self.assertEqual(status, 200)
        status, _, result = self.request("POST", "/api/queue", {"action": "pause"}, {"Content-Type": "application/json", "Cookie": session})
        self.assertEqual(status, 200)
        self.assertTrue(result["paused"])
        status, _, result = self.request("POST", "/api/queue", {"action": "resume"}, self.json_headers())
        self.assertEqual(status, 200)
        self.assertFalse(result["paused"])

    def test_binary_asset_and_empty_delete_bypass_json_content_type_only_where_allowed(self):
        status, _, document = self.request("POST", "/api/projects", {"name": "安全测试"}, self.json_headers())
        self.assertEqual(status, 201)
        project_id = document["id"]
        status, _, _ = self.request("PUT", f"/api/projects/{project_id}/assets/a.png", b"fake-image", {"Content-Type": "image/png", "X-H3-Token": self.server.token})
        self.assertEqual(status, 201)
        status, _, _ = self.request("DELETE", f"/api/projects/{project_id}", headers={"X-H3-Token": self.server.token})
        self.assertEqual(status, 200)

    def test_read_api_also_requires_token_except_health(self):
        status, _, _ = self.request("GET", "/api/projects")
        self.assertEqual(status, 401)
        status, _, body = self.request("GET", "/api/queue", headers={"X-H3-Token": self.server.token})
        self.assertEqual(status, 200)
        self.assertIn("jobs", body)


if __name__ == "__main__":
    unittest.main()
