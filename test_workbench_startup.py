from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

from workbench_lifecycle import ensure_workbench, instance_path

ROOT = Path(__file__).resolve().parent


class StartupHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/api/health":
            payload = {"ok": True, "pid": 123, "port": self.server.server_port}
        elif self.path == "/api/comfy/system_stats" and self.headers.get("X-H3-Token") == "private-test-token":
            self.server.comfy_probes += 1
            if not self.server.comfy_ready or self.server.comfy_probes <= self.server.delay_probes:
                self.send_error(503)
                return
            payload = {"system": {"comfyui_version": "fixture"}, "devices": []}
        else:
            self.send_error(401)
            return
        body = json.dumps(payload).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


class WorkbenchStartupTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.environment = patch.dict(os.environ, {"H3_WORKBENCH_RUNTIME_DIR": str(self.root / "runtime")})
        self.environment.start()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), StartupHandler)
        self.server.comfy_ready = True
        self.server.comfy_probes = 0
        self.server.delay_probes = 0
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(2)
        self.environment.stop()
        self.temporary.cleanup()

    def publish_instance(self):
        instance_path().parent.mkdir(parents=True, exist_ok=True)
        instance_path().write_text(json.dumps({"pid": 123, "port": self.server.server_port, "token": "private-test-token"}), encoding="utf-8")

    def portable_fixture(self):
        root = self.root / "便携版 path"
        for relative in ("python_embeded/python.exe", "ComfyUI/main.py"):
            path = root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.touch()
        settings = Mock()
        settings.data = {"comfyRoot": str(root)}
        return root, settings

    def test_cold_start_uses_portable_python_and_waits_for_both_services(self):
        root, settings = self.portable_fixture()
        process = Mock(pid=123)
        process.poll.return_value = None
        def start(*args, **kwargs):
            self.publish_instance()
            return process
        self.server.delay_probes = 1
        with patch("workbench_settings.WorkbenchSettings", return_value=settings), \
             patch("workbench_lifecycle.subprocess.Popen", side_effect=start) as spawn, \
             patch.dict(os.environ, {"PYTHONUTF8": "0", "PYTHONIOENCODING": "gbk"}):
            result = ensure_workbench(timeout=3)
        self.assertTrue(result["started"] and result["workbenchReady"] and result["comfyReady"])
        self.assertGreaterEqual(self.server.comfy_probes, 2)
        args, kwargs = spawn.call_args
        self.assertEqual(args[0][0], str(root / "python_embeded/python.exe"))
        self.assertEqual(kwargs["env"]["H3_WORKBENCH_NO_BROWSER"], "1")
        self.assertEqual(kwargs["env"]["PYTHONUTF8"], "1")
        self.assertEqual(kwargs["env"]["PYTHONIOENCODING"], "utf-8")
        process.terminate.assert_not_called()

    def test_repeated_start_reuses_service_and_returns_actual_port_without_token(self):
        self.publish_instance()
        with patch("workbench_lifecycle.subprocess.Popen") as spawn:
            result = ensure_workbench(timeout=2)
        spawn.assert_not_called()
        self.assertFalse(result["started"])
        self.assertEqual(result["url"], f"http://127.0.0.1:{self.server.server_port}/")
        self.assertNotIn("private-test-token", json.dumps(result))

    def test_comfy_unavailable_is_not_reported_as_success_or_restarted(self):
        self.publish_instance()
        self.server.comfy_ready = False
        with patch("workbench_lifecycle.subprocess.Popen") as spawn:
            with self.assertRaisesRegex(RuntimeError, "ComfyUI 尚未就绪"):
                ensure_workbench(timeout=0.1)
        spawn.assert_not_called()

    def test_failed_launcher_reports_log_without_stopping_any_process(self):
        _, settings = self.portable_fixture()
        process = Mock(pid=123)
        process.poll.return_value = 1
        with patch("workbench_settings.WorkbenchSettings", return_value=settings), \
             patch("workbench_lifecycle.subprocess.Popen", return_value=process):
            with self.assertRaisesRegex(RuntimeError, "工作台启动失败"):
                ensure_workbench(timeout=2)
        process.terminate.assert_not_called()
        process.kill.assert_not_called()

    def test_missing_portable_is_not_replaced_with_system_python(self):
        settings = Mock(data={"comfyRoot": str(self.root / "missing")})
        with patch("workbench_settings.WorkbenchSettings", return_value=settings), \
             patch("workbench_lifecycle.subprocess.Popen") as spawn:
            with self.assertRaisesRegex(RuntimeError, "便携版 Python"):
                ensure_workbench(timeout=2)
        spawn.assert_not_called()

    def test_timeout_is_bounded(self):
        for value in (0, -1, 601, float("inf"), float("nan")):
            with self.subTest(value=value), self.assertRaises(ValueError):
                ensure_workbench(timeout=value)

    def test_cli_start_returns_verified_json_even_under_gbk(self):
        self.publish_instance()
        env = dict(os.environ, PYTHONUTF8="0", PYTHONIOENCODING="gbk")
        result = subprocess.run([sys.executable, str(ROOT / "agent_cli.py"), "start", "--timeout", "3"],
                                env=env, capture_output=True, text=True, encoding="utf-8", timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(json.loads(result.stdout)["comfyReady"])
        self.assertNotIn("private-test-token", result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
