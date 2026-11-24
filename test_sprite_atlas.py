"""Isolated backend tests; no ComfyUI or user canvas requests."""
import json
import os
from pathlib import Path
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch

from PIL import Image

from project_store import ProjectStore, StoreError
import sprite_atlas as module
from sprite_atlas import SpriteAtlasAPI, validate_input, validate_options
from video_workbench_launcher import WorkbenchHandler, WorkbenchServer, validate_settings_change, validate_update_ready


class FakeProcess:
    pid = -1

    def __init__(self, command, *, bad=False, block=False, **kwargs):
        self.returncode = None if block else 0
        self.killed = False
        request = json.loads(Path(command[-1]).read_text(encoding="utf-8"))
        output = Path(request["outputDir"])
        size = (request["frameSize"] * request["framesPerAction"], request["frameSize"] * request["directions"])
        Image.new("RGBA", size, (200, 30, 20, 255)).save(output / "albedo.png")
        Image.new("RGBA", (size[0] + 1, size[1]) if bad else size, (128, 128, 255, 255)).save(output / "normal.png")
        (output / "atlas.json").write_text(json.dumps({"schema": "refmuse.sprite-atlas.v1", "size": dict(zip(("width", "height"), size))}), encoding="utf-8")

    def poll(self):
        return self.returncode

    def kill(self):
        self.killed = True
        self.returncode = -9

    def wait(self, timeout=None):
        return self.returncode


class SpriteTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.store = ProjectStore(self.root / "projects", "sprite-test")
        self.document = self.store.create("sprite", {"nodes": [{"id": "sprite-a", "type": "spriteAtlas", "position": {"x": 0, "y": 0}, "data": {}}], "edges": [], "viewport": {"x": 0, "y": 0, "zoom": 1}})
        self.store.open(self.document["id"])
        self.source = self.root / "hero.glb"
        self.source.write_bytes(b"fake model, never opened by Blender")
        self.blender = self.root / "blender.exe"
        self.blender.write_bytes(b"fake executable, never executed")
        self.spawned = []

        def popen(command, **kwargs):
            self.command, self.kwargs = command, kwargs
            process = FakeProcess(command, **kwargs)
            self.spawned.append(process)
            return process
        self.manager = SpriteAtlasAPI(self.store, self.root / "rendered", popen=popen, blender=self.blender, timeout=2, allow_legacy=True)

    def tearDown(self):
        self.manager.close()
        self.store.close()
        self.temp.cleanup()

    def payload(self, **kwargs):
        return {"projectId": self.document["id"], "revision": self.document["revision"], "nodeId": "sprite-a", "inputPath": str(self.source), "options": {"frameSize": 32, "framesPerAction": 2, "directions": 4}, **kwargs}

    def wait(self, job, statuses=module.TERMINAL):
        end = time.monotonic() + 5
        while time.monotonic() < end:
            result = self.manager.get(job["id"])
            if result["status"] in statuses:
                return result
            time.sleep(0.01)
        self.fail("worker did not reach expected state")

    def test_prepared_request_binds_source_options_and_recovers_once(self):
        self.manager.allow_legacy = False
        with self.assertRaises(StoreError):
            self.manager.create(self.payload())
        original = self.payload(requestId="visible_fixture")
        with self.assertRaises(StoreError) as missing:
            self.manager.create(original)
        self.assertEqual(missing.exception.code, "VISIBLE_CANVAS_REQUIRED")
        document = self.store.get(original["projectId"])
        node = document["canvas"]["nodes"][0]
        options = validate_options(original["options"])
        node["data"].update(spriteInputPath=original["inputPath"], spriteOptions=options,
                            spriteRun={"requestId": original["requestId"], "phase": "prepared",
                                       "inputPath": original["inputPath"], "options": options})
        self.store.save(document["id"], document, document["revision"])
        original["revision"] = self.store.get(document["id"])["revision"]
        with self.assertRaises(StoreError) as mismatch:
            self.manager.create({**original, "options": {**options, "directions": 8}})
        self.assertEqual(mismatch.exception.code, "REVISION_CONFLICT")
        job = self.manager.create(original)
        expected = "spa_" + module.hashlib.sha256("\\0".join([original["projectId"], original["nodeId"], original["requestId"]]).encode()).hexdigest()[:32]
        self.assertEqual(job["id"], expected)
        self.assertEqual(self.manager.create(original)["id"], expected)
        result = self.wait(job)
        self.assertEqual(result["status"], "done")
        self.assertEqual(self.manager.get(expected)["requestId"], original["requestId"])
        self.assertEqual(len(self.spawned), 1)
        fresh = SpriteAtlasAPI(self.store, self.root / "rendered", blender=self.blender)
        try:
            self.assertEqual(fresh.get(expected)["files"], result["files"])
        finally:
            fresh.close()

    def test_defaults_and_resource_bounds(self):
        self.assertEqual(validate_options({})["frameSize"], 192)
        invalid = [{"directions": 6}, {"frameSize": True}, {"frameSize": 64.0}, {"padding": float("nan")}, {"elevation": float("inf")}, {"pivot": [0.5, 2]}, {"pivot": [0, 0.9]}, {"pivot": [0.5, 1]}, {"actions": ["idle", "idle"]}, {"actions": list("123456789")}, {"frameSize": 1024, "framesPerAction": 64}, {"frameSize": 512, "directions": 16, "actions": ["idle", "run"]}, {"unknown": 1}]
        for value in invalid:
            with self.subTest(value=value), self.assertRaises(StoreError):
                validate_options(value)

    def test_only_local_bounded_models(self):
        self.assertEqual(validate_input(str(self.source)), self.source.resolve())
        for value in ("https://example.com/hero.glb", "//server/share/hero.glb", "\\\\server\\share\\hero.fbx", "relative.glb", str(self.root / "missing.glb"), str(self.blender), "a\0.glb"):
            with self.subTest(value=value), self.assertRaises(StoreError):
                validate_input(value)

    def test_missing_blender_is_reported_without_spawn(self):
        self.manager.blender = None
        with patch.object(module, "find_blender", return_value=None):
            self.assertFalse(self.manager.status()["available"])
            with self.assertRaises(StoreError) as caught:
                self.manager.create(self.payload())
            self.assertEqual(caught.exception.code, "BLENDER_MISSING")
        self.assertEqual(self.spawned, [])

    def test_explicit_blender_config_never_falls_back(self):
        with patch.dict(os.environ, {"H3_BLENDER_PATH": str(self.root / "missing.exe")}):
            self.assertIsNone(module.find_blender())
        with patch.dict(os.environ, {"H3_BLENDER_PATH": str(self.blender)}):
            self.assertEqual(module.find_blender(), self.blender.resolve())

    def test_done_is_real_matching_output_and_does_not_save_project(self):
        before = self.store.get(self.document["id"])
        job = self.manager.create(self.payload())
        result = self.wait(job)
        self.assertEqual(result["status"], "done")
        self.assertEqual(set(result["files"]), {"albedo", "normal", "metadata"})
        self.assertIn("--disable-autoexec", self.command)
        self.assertIn("--factory-startup", self.command)
        self.assertIn("--background", self.command)
        self.assertEqual(self.kwargs["env"]["CUDA_VISIBLE_DEVICES"], "")
        self.assertEqual(self.store.get(self.document["id"]), before)
        self.assertEqual(self.manager.file(job["id"], "albedo.png").name, "albedo.png")
        self.assertNotIn("inputPath", result)

    def test_saved_node_revision_readonly_and_actual_lock_required(self):
        for change in ({"revision": 0}, {"revision": True}, {"revision": None}, {"nodeId": "missing"}):
            with self.subTest(change=change), self.assertRaises(StoreError):
                self.manager.create(self.payload(**change))
        self.store.release(self.document["id"])
        self.store.open(self.document["id"], read_only=True)
        with self.assertRaises(StoreError) as caught:
            self.manager.create(self.payload())
        self.assertEqual(caught.exception.code, "READ_ONLY")
        self.store.release(self.document["id"])
        self.store.open(self.document["id"])
        lock = self.store._project_path(self.document["id"]).parent / ".lock"
        lock.write_text(json.dumps({"owner": "other", "pid": os.getpid()}))
        with self.assertRaises(StoreError) as caught:
            self.manager.create(self.payload())
        self.assertEqual(caught.exception.code, "LOCKED")
        self.assertEqual(self.spawned, [])

    def test_pending_download_and_traversal_rejected(self):
        self.manager.popen = lambda command, **kw: FakeProcess(command, block=True, **kw)
        job = self.manager.create(self.payload())
        self.wait(job, {"running"})
        for name in ("../request.json", "request.json", "render.log", "normal.png"):
            with self.subTest(name=name), self.assertRaises(StoreError):
                self.manager.file(job["id"], name)
        for value in ("../x", "spa_" + "a" * 31, "spa_" + "g" * 32):
            with self.assertRaises(StoreError):
                self.manager.get(value)
        self.manager.cancel(job["id"])

    def test_mismatched_atlas_never_published(self):
        self.manager.popen = lambda command, **kw: FakeProcess(command, bad=True, **kw)
        job = self.manager.create(self.payload())
        result = self.wait(job)
        self.assertEqual(result["status"], "error")
        self.assertNotIn("files", result)
        self.assertTrue(self.store.get(self.document["id"])["canvas"]["nodes"])

    def test_process_failure_preserves_logs_and_previous_outputs(self):
        old = self.wait(self.manager.create(self.payload()))
        def failed(command, **kwargs):
            process = FakeProcess(command, **kwargs)
            process.returncode = 7
            return process
        self.manager.popen = failed
        result = self.wait(self.manager.create(self.payload()))
        self.assertEqual(result["status"], "error")
        self.assertNotIn("files", result)
        self.assertTrue(self.manager.file(old["id"], "albedo.png").is_file())
        self.assertTrue((self.manager.root / result["id"] / "render.log").is_file())

    def test_structured_renderer_error_is_actionable_bounded_and_preserves_node(self):
        def failed(command, **kwargs):
            process = FakeProcess(command, **kwargs)
            kwargs["stdout"].write(b"private unrelated log content\n" * 1000)
            kwargs["stdout"].write(("SPRITE_ATLAS_ERROR=Unsupported material " + "x" * 1000 + "\n").encode())
            kwargs["stdout"].flush()
            process.returncode = 7
            return process
        self.manager.popen = failed
        result = self.wait(self.manager.create(self.payload()))
        self.assertEqual(result["status"], "error")
        self.assertIn("Unsupported material", result["error"])
        self.assertNotIn("private unrelated", result["error"])
        self.assertLessEqual(len(result["error"]), 520)
        self.assertNotIn("files", result)
        self.assertEqual(self.store.get(self.document["id"])["canvas"]["nodes"][0]["id"], "sprite-a")

    def test_serial_queue_cancel_and_bounded_admission(self):
        self.manager.popen = lambda command, **kw: FakeProcess(command, block=True, **kw)
        first = self.manager.create(self.payload())
        self.wait(first, {"running"})
        jobs = [self.manager.create(self.payload()) for _ in range(3)]
        with self.assertRaises(StoreError) as caught:
            self.manager.create(self.payload())
        self.assertEqual(caught.exception.code, "SPRITE_QUEUE_FULL")
        self.assertEqual(self.manager.get(jobs[0]["id"])["status"], "queued")
        self.assertEqual(self.manager.active_count(), 4)
        self.assertEqual(self.manager.cancel(jobs[0]["id"])["status"], "cancelled")
        process = self.manager.jobs[first["id"]]["process"]
        self.assertEqual(self.manager.cancel(first["id"])["status"], "cancelled")
        self.assertTrue(process.killed)

    def test_active_render_blocks_update_and_project_root_switch(self):
        self.manager.popen = lambda command, **kw: FakeProcess(command, block=True, **kw)
        job = self.manager.create(self.payload())
        self.wait(job, {"running"})
        server = SimpleNamespace(project_store=self.store, sprite_atlas_api=self.manager)
        for callback in (lambda: validate_update_ready(server), lambda: validate_settings_change(server, {"projectsRoot": str(self.root / "other")})):
            with self.assertRaises(Exception) as caught:
                callback()
            self.assertEqual(caught.exception.code, "QUEUE_BUSY")
        self.manager.cancel(job["id"])

    def test_deleted_saved_node_can_still_cancel_owned_running_job(self):
        self.manager.popen = lambda command, **kw: FakeProcess(command, block=True, **kw)
        job = self.manager.create(self.payload())
        self.wait(job, {"running"})
        process = self.manager.jobs[job["id"]]["process"]
        current = self.store.get(self.document["id"])
        current["canvas"]["nodes"] = []
        self.store.save(current["id"], current, current["revision"])
        self.assertEqual(self.manager.cancel(job["id"])["status"], "cancelled")
        self.assertTrue(process.killed)
        self.assertEqual(self.store.get(current["id"])["canvas"]["nodes"], [])

    def test_reparse_output_root_rejected_before_creating_directory(self):
        original = module._linked
        with patch.object(module, "_linked", side_effect=lambda p: True if p == self.manager.root else original(p)):
            with self.assertRaises(StoreError) as caught:
                self.manager.create(self.payload())
            self.assertEqual(caught.exception.code, "SPRITE_STORAGE")
        self.assertFalse(self.manager.root.exists())

    def test_timeout_and_close_kill_only_owned_child(self):
        self.manager.timeout = 0.01
        self.manager.popen = lambda command, **kw: FakeProcess(command, block=True, **kw)
        result = self.wait(self.manager.create(self.payload()))
        self.assertEqual(result["status"], "error")
        self.assertIn("30 分钟", result["error"])
        self.manager.timeout = 100
        job = self.manager.create(self.payload())
        self.wait(job, {"running"})
        process = self.manager.jobs[job["id"]]["process"]
        self.manager.close()
        self.assertTrue(process.killed)
        self.assertEqual(self.manager.get(job["id"])["status"], "cancelled")

    def test_completed_exports_survive_manager_restart_and_interrupted_not_done(self):
        done = self.wait(self.manager.create(self.payload()))
        self.manager.close()
        other = SpriteAtlasAPI(self.store, self.manager.root)
        try:
            self.assertEqual(other.get(done["id"])["status"], "done")
            self.assertTrue(other.file(done["id"], "atlas.json").is_file())
            path = self.manager.root / done["id"] / "job.json"
            value = json.loads(path.read_text(encoding="utf-8"))
            value["status"] = "running"
            path.write_text(json.dumps(value), encoding="utf-8")
            self.assertEqual(other.get(done["id"])["status"], "error")
            self.assertNotIn("files", other.get(done["id"]))
        finally:
            other.close()

    def test_output_symlink_or_hardlink_is_never_served(self):
        job = self.wait(self.manager.create(self.payload()))
        target = self.manager.file(job["id"], "albedo.png")
        outside = self.root / "outside.png"
        os.link(target, outside)
        with self.assertRaises(StoreError):
            self.manager.file(job["id"], "albedo.png")


    def test_launcher_routes_keep_existing_auth_origin_and_stream_real_files(self):
        server = WorkbenchServer(("127.0.0.1", 0), WorkbenchHandler)
        server.token = "unit-test-only"
        server.sprite_atlas_api = self.manager
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = f"http://127.0.0.1:{server.server_port}"
        def request(method, path, body=None, token=True, extra=None):
            headers = {"Content-Type": "application/json", **(extra or {})}
            if token:
                headers["X-H3-Token"] = server.token
            req = urllib.request.Request(base + path, method=method, data=None if body is None else json.dumps(body).encode(), headers=headers)
            try:
                with urllib.request.urlopen(req, timeout=4) as response:
                    return response.status, response.read(), response.headers
            except urllib.error.HTTPError as exc:
                return exc.code, exc.read(), exc.headers
        try:
            self.assertEqual(request("POST", "/api/sprite-atlas/jobs", self.payload(), token=False)[0], 401)
            self.assertEqual(request("POST", "/api/sprite-atlas/jobs", self.payload(), extra={"Origin": "https://evil.example"})[0], 403)
            self.assertEqual(request("GET", "/api/sprite-atlas/status")[0], 200)
            status, body, _ = request("POST", "/api/sprite-atlas/jobs", self.payload())
            self.assertEqual(status, 202)
            job = self.wait(json.loads(body))
            status, body, headers = request("GET", job["files"]["albedo"])
            self.assertEqual(status, 200)
            self.assertEqual(headers["Content-Type"], "image/png")
            self.assertEqual(body[:8], b"\x89PNG\r\n\x1a\n")
            self.assertEqual(request("GET", f'/api/sprite-atlas/jobs/{job["id"]}/files/request.json')[0], 404)
            self.assertEqual(request("POST", "/api/sprite-atlas/jobs", [1])[0], 400)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(3)


if __name__ == "__main__":
    unittest.main()
