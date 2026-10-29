from __future__ import annotations

import json
import os
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
from workbench_settings import WorkbenchSettings


class SettingsAPITests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.comfy = self.root / "portable"
        (self.comfy / "ComfyUI").mkdir(parents=True)
        (self.comfy / "ComfyUI" / "main.py").write_text("# test", encoding="utf-8")
        self.old_projects = self.root / "old-projects"
        self.new_projects = self.root / "new-projects"
        self.config_path = self.root / "runtime" / "config.json"
        self.server = WorkbenchServer(("127.0.0.1", 0), WorkbenchHandler)
        self.server.token = "settings-test-token"
        self.server.settings = WorkbenchSettings(self.config_path, comfy_root=self.comfy, projects_root=self.old_projects)
        self.server.settings.load()
        self.server.project_store = ProjectStore(self.old_projects, defaults=self.server.settings.data["defaults"])
        self.server.project_api = ProjectAPI(self.server.project_store)
        self.server.queue_manager = QueueManager(path=self.root / "runtime" / "queue.json")
        self.server.queue_api = QueueAPI(self.server.queue_manager)
        self.server.doctor = None
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=3)
        self.server.project_store.close()
        self.temporary.cleanup()

    def request(self, method, path, payload=None, authenticated=True):
        headers = {"Content-Type": "application/json"}
        if authenticated:
            headers["X-H3-Token"] = self.server.token
        data = json.dumps(payload).encode("utf-8") if payload is not None else None
        request = urllib.request.Request(self.base + path, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=3) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as error:
            return error.code, json.load(error)

    def test_get_and_put_require_auth_and_never_return_key_material(self):
        self.assertEqual(self.request("GET", "/api/settings", authenticated=False)[0], 401)
        self.assertEqual(self.request("PUT", "/api/settings", {}, authenticated=False)[0], 401)
        status, result = self.request("GET", "/api/settings")
        self.assertEqual(status, 200)
        self.assertNotIn("deepseekKey", result)
        self.assertIn(result["deepseek"]["source"], {"environment", "keyring", "file", "none"})

    def test_update_applies_concurrency_and_project_defaults_immediately(self):
        status, result = self.request("PUT", "/api/settings", {
            "comfyRoot": str(self.comfy),
            "queue": {"concurrency": 2},
            "defaults": {"ratio": "9:16", "resolution": "720P", "duration": 8},
            "modelRoots": [str(self.root / "models")],
            "notifications": False,
            "logLevel": "WARNING",
        })
        self.assertEqual(status, 200)
        self.assertEqual(self.server.queue_manager.snapshot()["concurrency"], 2)
        self.assertEqual(len(self.server.doctor.model_roots), 1)
        self.assertEqual(self.server.doctor.model_roots[0].name, "models")
        self.assertTrue(os.path.samefile(self.server.doctor.model_roots[0].parent, self.root))
        document = self.server.project_store.create("Defaults")
        self.assertEqual(document["settings"], {
            "ratio": "9:16", "resolution": "720P", "duration": 8, "template": "blank",
        })
        self.assertNotIn("deepseekKey", json.loads(self.config_path.read_text(encoding="utf-8")))

    def test_invalid_update_does_not_overwrite_configuration(self):
        status, result = self.request("PUT", "/api/settings", {"queue": {"concurrency": 3}})
        self.assertEqual(status, 400)
        self.assertEqual(result["code"], "BAD_REQUEST")
        self.assertFalse(self.config_path.exists())
        self.assertEqual(self.server.queue_manager.snapshot()["concurrency"], 1)

    def test_locked_project_blocks_root_change_then_success_does_not_move_project(self):
        original = self.server.project_store.create("Original")
        self.server.project_store.open(original["id"])
        status, result = self.request("PUT", "/api/settings", {"projectsRoot": str(self.new_projects)})
        self.assertEqual(status, 409)
        self.assertEqual(result["code"], "LOCKED")
        self.assertEqual(self.server.project_store.root, self.old_projects.resolve())
        self.assertFalse(self.config_path.exists())
        self.server.project_store.close()
        status, result = self.request("PUT", "/api/settings", {"projectsRoot": str(self.new_projects)})
        self.assertEqual(status, 200)
        self.assertEqual(self.server.project_store.root, self.new_projects.resolve())
        self.assertTrue((self.old_projects / "Original" / "project.json").is_file())
        self.assertFalse((self.new_projects / "Original").exists())
        self.assertEqual(self.server.project_api.store, self.server.project_store)

    def test_active_queue_blocks_project_root_change(self):
        self.server.queue_manager.jobs.append({"id": "job_test", "status": "running"})
        status, result = self.request("PUT", "/api/settings", {"projectsRoot": str(self.new_projects)})
        self.assertEqual(status, 409)
        self.assertEqual(result["code"], "QUEUE_BUSY")
        self.assertEqual(self.server.project_store.root, self.old_projects.resolve())


if __name__ == "__main__":
    unittest.main()
