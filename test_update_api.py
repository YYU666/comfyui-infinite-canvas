from __future__ import annotations

import json
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

from video_workbench_launcher import WorkbenchHandler, WorkbenchServer
from workbench_update import UpdateError


class FakeManager:
    def __init__(self):
        self.phase = "idle"
        self.applied = []
        self.release = {"currentVersion": "1.0.1-rc.1", "version": "v9.9.9", "updateAvailable": True, "canApply": True}
    def status(self):
        return {"phase": self.phase, "currentVersion": "1.0.1-rc.1", "message": ""}
    def check(self): return self.release
    def apply(self, tag):
        self.applied.append(tag)
        self.phase = "restarting"
        return {"accepted": True, "version": tag}


class UpdateAPITests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.server = WorkbenchServer(("127.0.0.1", 0), WorkbenchHandler)
        self.server.token = "update-test-token"
        self.server.update_manager = FakeManager()
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join(timeout=3)
        self.temporary.cleanup()

    def request(self, method, path, payload=None, authenticated=True):
        headers = {"Content-Type": "application/json"}
        if authenticated: headers["X-H3-Token"] = self.server.token
        data = json.dumps(payload).encode() if payload is not None else None
        request = urllib.request.Request(self.base + path, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=3) as response: return response.status, json.load(response)
        except urllib.error.HTTPError as error: return error.code, json.load(error)

    def test_update_endpoints_require_local_token(self):
        self.assertEqual(self.request("GET", "/api/updates/check", authenticated=False)[0], 401)
        self.assertEqual(self.request("GET", "/api/updates/status", authenticated=False)[0], 401)
        self.assertEqual(self.request("POST", "/api/updates/apply", {"tag": "v9.9.9"}, authenticated=False)[0], 401)
        self.assertEqual(self.server.update_manager.applied, [])

    def test_check_and_valid_apply_use_confirmed_tag(self):
        status, result = self.request("GET", "/api/updates/check")
        self.assertEqual(status, 200)
        self.assertEqual(result["version"], "v9.9.9")
        status, result = self.request("POST", "/api/updates/apply", {"tag": "v9.9.9"})
        self.assertEqual(status, 200)
        self.assertTrue(result["accepted"])
        self.assertEqual(self.server.update_manager.applied, ["v9.9.9"])

    def test_invalid_payload_and_manager_conflict_are_structured_errors(self):
        self.assertEqual(self.request("POST", "/api/updates/apply", {"tag": "v9.9.9", "url": "https://evil"})[0], 400)
        self.assertEqual(self.request("POST", "/api/updates/apply", {"tag": "bad"})[0], 400)
        with mock.patch.object(self.server.update_manager, "apply", side_effect=UpdateError("busy", status=409, code="UPDATE_BUSY")):
            status, result = self.request("POST", "/api/updates/apply", {"tag": "v9.9.9"})
        self.assertEqual(status, 409)
        self.assertEqual(result["code"], "UPDATE_BUSY")

    def test_restarting_blocks_project_and_queue_writes(self):
        self.server.update_manager.phase = "restarting"
        status, result = self.request("POST", "/api/projects/anything", {})
        self.assertEqual(status, 409)
        self.assertEqual(result["code"], "UPDATE_RESTARTING")


class UpdatePreflightTests(unittest.TestCase):
    def server(self, held=None, status="done"):
        return mock.Mock(
            project_store=mock.Mock(_held=held or {}),
            queue_manager=mock.Mock(snapshot=mock.Mock(return_value={"jobs": [{"status": status}]})),
        )

    def test_open_project_and_active_queue_block_update(self):
        from video_workbench_launcher import validate_update_ready
        with self.assertRaises(UpdateError) as caught: validate_update_ready(self.server(held={"project": object()}))
        self.assertEqual(caught.exception.code, "PROJECT_OPEN")
        with self.assertRaises(UpdateError) as caught: validate_update_ready(self.server(status="running"))
        self.assertEqual(caught.exception.code, "QUEUE_BUSY")

    def test_idle_server_and_sufficient_space_pass(self):
        from video_workbench_launcher import validate_update_ready
        with mock.patch("video_workbench_launcher.shutil.disk_usage", return_value=mock.Mock(free=1024 ** 3)):
            validate_update_ready(self.server())
        with mock.patch("video_workbench_launcher.shutil.disk_usage", return_value=mock.Mock(free=1)):
            with self.assertRaises(UpdateError) as caught: validate_update_ready(self.server())
        self.assertEqual(caught.exception.code, "DISK_SPACE")


if __name__ == "__main__": unittest.main()
