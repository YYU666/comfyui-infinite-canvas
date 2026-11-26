from http.server import BaseHTTPRequestHandler, HTTPServer
import datetime as dt
import hashlib
import io
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
import urllib.request

from workbench_models import ModelManager, ModelManagerError, normalize_model_relpath
from workbench_models_api import ModelManagerAPI

REPO_ROOT = Path(__file__).resolve().parent


class _FakeHandler:
    def __init__(self, method="GET", path="/api/models", body=None, headers=None):
        self.command = method
        self.path = path
        raw = json.dumps(body).encode("utf-8") if body is not None else b""
        self.rfile = io.BytesIO(raw)
        hdrs = dict(headers or {})
        if body is not None:
            hdrs.setdefault("Content-Length", str(len(raw)))
        self.headers = hdrs
        self.status_code = None
        self.payload = None

    def send_json(self, status, payload):
        self.status_code = status
        self.payload = payload


class WorkbenchModelsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.models_dir = self.root / "models"
        (self.models_dir / "diffusion_models").mkdir(parents=True)
        (self.models_dir / "loras").mkdir(parents=True)
        self.state_path = self.root / "model-manager-state.json"

    def tearDown(self):
        self.temp.cleanup()

    def test_rejects_traversal_and_invalid_extensions(self):
        for bad in ("", "file.safetensors", "../diffusion_models/x.safetensors", "diffusion_models/x.txt", "C:/diffusion_models/x.safetensors", "diffusion_models/../x.safetensors"):
            with self.assertRaises(ModelManagerError) as ctx:
                normalize_model_relpath(bad)
            self.assertEqual(ctx.exception.status, 400)
            self.assertEqual(ctx.exception.code, "INVALID_MODEL_PATH")
        self.assertEqual(normalize_model_relpath("./diffusion_models\\a.safetensors"), "diffusion_models/a.safetensors")

    def test_inventory_usage_tiers_lock_and_guarded_delete(self):
        busy_flag = {"busy": False}
        mgr = ModelManager(REPO_ROOT, self.models_dir, self.state_path, active_jobs_check=lambda: busy_flag["busy"])

        hot_rel = "diffusion_models/qwen_image_2.1_int8_convrot.safetensors"
        idle_rel = "loras/custom_unused_lora.safetensors"
        (self.models_dir / hot_rel).write_bytes(b"H" * 128)
        (self.models_dir / idle_rel).write_bytes(b"I" * 256)

        now = dt.datetime(2026, 11, 26, 12, 0, tzinfo=dt.timezone.utc)
        for i in range(11):
            mgr.record_workflow_usage({"1": {"class_type": "UNETLoader", "inputs": {"unet_name": "qwen_image_2.1_int8_convrot.safetensors"}}}, timestamp=now - dt.timedelta(days=i % 10))
        # Old usage older than 30 days should remain in total usageCount but classify as idle
        mgr.record_usage([idle_rel], timestamp=now - dt.timedelta(days=45))

        snap = mgr.snapshot(now=now)
        by_path = {item["path"]: item for item in snap["models"]}
        self.assertTrue(by_path[hot_rel]["installed"])
        self.assertEqual(by_path[hot_rel]["usageTier"], "high")
        self.assertEqual(by_path[hot_rel]["usage30d"], 11)
        self.assertEqual(by_path[idle_rel]["source"], "local")
        self.assertEqual(by_path[idle_rel]["usageTier"], "idle")
        self.assertEqual(by_path[idle_rel]["usageCount"], 1)
        self.assertEqual(snap["summary"]["idleReclaimableBytes"], 256)

        # Lock protects against delete and download updates
        mgr.set_lock(idle_rel, True)
        with self.assertRaises(ModelManagerError) as lock_err:
            mgr.delete_model(idle_rel)
        self.assertEqual(lock_err.exception.status, 409)
        self.assertEqual(lock_err.exception.code, "MODEL_LOCKED")

        mgr.set_lock(hot_rel, True)
        # Choose a pinned model with a URL to verify download lock guard
        pinned_rel = "diffusion_models/seedvr2_3b_int8_convrot.safetensors"
        mgr.set_lock(pinned_rel, True)
        with self.assertRaises(ModelManagerError) as dl_lock_err:
            mgr.start_download(pinned_rel)
        self.assertEqual(dl_lock_err.exception.code, "MODEL_LOCKED")

        # Active jobs guard blocks deletion even after unlock
        mgr.set_lock(idle_rel, False)
        busy_flag["busy"] = True
        with self.assertRaises(ModelManagerError) as busy_err:
            mgr.delete_model(idle_rel)
        self.assertEqual(busy_err.exception.status, 409)
        self.assertEqual(busy_err.exception.code, "MODEL_IN_USE")

        # Delete succeeds when unlocked and idle, keeping sibling hot file untouched
        busy_flag["busy"] = False
        deleted = mgr.delete_model(idle_rel)
        self.assertTrue(deleted["ok"])
        self.assertEqual(deleted["freedBytes"], 256)
        self.assertFalse((self.models_dir / idle_rel).exists())
        self.assertTrue((self.models_dir / hot_rel).exists())

    def test_lock_all_and_http_api_routes(self):
        rel = "loras/test_keep.safetensors"
        (self.models_dir / rel).write_bytes(b"ABC")
        mgr = ModelManager(REPO_ROOT, self.models_dir, self.state_path)
        api = ModelManagerAPI(mgr)

        get_req = _FakeHandler("GET", "/api/models")
        self.assertTrue(api.handle_get(get_req, "/api/models"))
        self.assertEqual(get_req.status_code, 200)
        self.assertEqual(get_req.payload["runtimePolicy"]["comfyUpdateMode"], "pinned_release")

        lock_all_req = _FakeHandler("POST", "/api/models/lock-installed", body=None, headers={"Content-Length": "0"})
        self.assertTrue(api.handle_post(lock_all_req, "/api/models/lock-installed"))
        self.assertEqual(lock_all_req.status_code, 200)
        self.assertEqual(lock_all_req.payload["summary"]["lockedCount"], 1)

        del_req = _FakeHandler("POST", "/api/models/delete", body={"path": rel})
        self.assertTrue(api.handle_post(del_req, "/api/models/delete"))
        self.assertEqual(del_req.status_code, 409)
        self.assertEqual(del_req.payload["code"], "MODEL_LOCKED")

        verify_req = _FakeHandler("POST", "/api/models/verify", body={"path": rel})
        self.assertTrue(api.handle_post(verify_req, "/api/models/verify"))
        self.assertEqual(verify_req.status_code, 200)
        self.assertEqual(verify_req.payload["sha256"], hashlib.sha256(b"ABC").hexdigest())

    def test_pinned_download_verify_and_corrupt_hash_rejection(self):
        payload = b"SAFE_MODEL_WEIGHTS_CONTENT_v2"
        digest = hashlib.sha256(payload).hexdigest()
        corrupt = b"BAD_MODEL_WEIGHTS_CONTENT_v2!"
        serve_bytes = {"data": payload}

        class _Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                data = serve_bytes["data"]
                self.send_response(200)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, format, *args):
                return

        server = HTTPServer(("127.0.0.1", 0), _Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            mgr = ModelManager(REPO_ROOT, self.models_dir, self.state_path, opener=urllib.request.urlopen)
            rel = "diffusion_models/seedvr2_3b_int8_convrot.safetensors"
            mgr._catalog[rel]["url"] = f"http://127.0.0.1:{server.server_port}/model.safetensors"
            mgr._catalog[rel]["expectedBytes"] = len(payload)
            mgr._catalog[rel]["expectedSha256"] = digest
            mgr._catalog[rel]["hasDownloadUrl"] = True

            # Test corrupt payload rejection preserves original file
            target = self.models_dir / rel
            target.write_bytes(b"OLD_VALID_BYTES")
            serve_bytes["data"] = corrupt
            mgr.start_download(rel, allow_http_for_tests=True)
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                dl = mgr.snapshot()["models"]
                entry = next(m for m in dl if m["path"] == rel)
                if entry["status"] not in {"downloading", "verifying"}:
                    break
                time.sleep(0.05)
            entry = next(m for m in mgr.snapshot()["models"] if m["path"] == rel)
            self.assertEqual(entry["download"]["phase"], "error")
            self.assertEqual(target.read_bytes(), b"OLD_VALID_BYTES")

            # Test valid download replaces cleanly and updates installedSha256
            serve_bytes["data"] = payload
            mgr.start_download(rel, allow_http_for_tests=True)
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                entry = next(m for m in mgr.snapshot()["models"] if m["path"] == rel)
                if entry["status"] == "installed" and entry["download"] and entry["download"]["phase"] == "completed":
                    break
                time.sleep(0.05)
            self.assertEqual(target.read_bytes(), payload)
            self.assertEqual(entry["installedSha256"], digest)
            self.assertFalse(entry["updateAvailable"])
        finally:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    unittest.main()
