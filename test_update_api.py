from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import threading
import time
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
        store = mock.Mock()
        store.reclaim_dead_locks.return_value = []
        store.held_project_details.return_value = ([{"id": "prj_open", "name": "打开中", "stale": False, "thisProcess": True, "pid": 1}] if held else [])
        return mock.Mock(
            project_store=store,
            queue_manager=mock.Mock(snapshot=mock.Mock(return_value={"jobs": [{"status": status}]})),
        )

    def test_open_project_and_active_queue_block_update(self):
        from video_workbench_launcher import validate_update_ready
        with self.assertRaises(UpdateError) as caught: validate_update_ready(self.server(held={"project": object()}))
        self.assertEqual(caught.exception.code, "PROJECT_OPEN")
        self.assertEqual(caught.exception.details["projects"][0]["name"], "打开中")
        self.assertIn("打开中", caught.exception.message)
        with self.assertRaises(UpdateError) as caught: validate_update_ready(self.server(status="running"))
        self.assertEqual(caught.exception.code, "QUEUE_BUSY")

    def test_dead_owner_lock_is_reclaimed_and_live_owner_is_not(self):
        from project_store import ProjectStore
        from video_workbench_launcher import validate_update_ready
        with tempfile.TemporaryDirectory() as temporary:
            store = ProjectStore(Path(temporary), "owner-update")
            document = store.create("场景甲")
            store.open(document["id"])
            server = mock.Mock(project_store=store, queue_manager=mock.Mock(snapshot=mock.Mock(return_value={"jobs": [{"status": "done"}]})))
            lock = store._project_path(document["id"]).parent / ".lock"
            with mock.patch("video_workbench_launcher.shutil.disk_usage", return_value=mock.Mock(free=1024 ** 3)):
                with self.assertRaises(UpdateError) as caught:
                    validate_update_ready(server)
                self.assertEqual(caught.exception.details["projects"][0]["id"], document["id"])
                self.assertFalse(caught.exception.details["projects"][0]["stale"])
                self.assertTrue(caught.exception.details["projects"][0]["thisProcess"])
                sleeper = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
                try:
                    payload = json.loads(lock.read_text(encoding="utf-8"))
                    payload["pid"] = sleeper.pid
                    payload["heartbeat"] = time.time()
                    lock.write_text(json.dumps(payload), encoding="utf-8")
                    with self.assertRaises(UpdateError) as caught:
                        validate_update_ready(server)
                    self.assertTrue(lock.is_file())
                    self.assertFalse(caught.exception.details["projects"][0]["stale"])
                    self.assertFalse(caught.exception.details["projects"][0]["thisProcess"])
                finally:
                    sleeper.kill()
                    sleeper.wait(timeout=5)
                payload = json.loads(lock.read_text(encoding="utf-8"))
                payload["pid"] = sleeper.pid
                payload["heartbeat"] = time.time()
                lock.write_text(json.dumps(payload), encoding="utf-8")
                validate_update_ready(server)
            self.assertFalse(lock.exists())
            self.assertEqual(store.reclaim_dead_locks(), [])
            store.close()

    def test_update_restart_preserves_comfy_and_exits_outside_tests(self):
        from video_workbench_launcher import begin_update_restart, exit_after_update, shutdown_workbench
        server = mock.Mock()
        server.comfy_lifecycle.process = mock.Mock()
        server.comfy_lifecycle.logger = mock.Mock()
        with mock.patch("video_workbench_launcher.stop_owned_comfy") as stop, mock.patch("video_workbench_launcher.stop_comfy_logger") as logger:
            self.assertEqual(shutdown_workbench(server, preserve_comfy=True), "preserved-update")
        stop.assert_not_called()
        logger.assert_not_called()
        self.assertFalse(server.block_on_close)
        server.server_close.assert_called_once()
        with mock.patch.dict(os.environ, {"H3_WORKBENCH_TEST_MODE": ""}, clear=False), mock.patch("video_workbench_launcher.os._exit") as exit_:
            exit_after_update(0)
            exit_.assert_called_once_with(0)
            fresh = mock.Mock()
            with mock.patch("video_workbench_launcher.threading.Thread") as thread:
                begin_update_restart(fresh)
            self.assertTrue(fresh.restart_for_update)
            self.assertFalse(fresh.block_on_close)
            self.assertEqual(thread.call_count, 2)
        with mock.patch.dict(os.environ, {"H3_WORKBENCH_TEST_MODE": "1"}), mock.patch("video_workbench_launcher.os._exit") as exit_:
            self.assertFalse(exit_after_update(0))
            exit_.assert_not_called()

    def test_idle_server_and_sufficient_space_pass(self):
        from video_workbench_launcher import validate_update_ready
        with mock.patch("video_workbench_launcher.shutil.disk_usage", return_value=mock.Mock(free=1024 ** 3)):
            validate_update_ready(self.server())
        with mock.patch("video_workbench_launcher.shutil.disk_usage", return_value=mock.Mock(free=1)):
            with self.assertRaises(UpdateError) as caught: validate_update_ready(self.server())
        self.assertEqual(caught.exception.code, "DISK_SPACE")


if __name__ == "__main__": unittest.main()
