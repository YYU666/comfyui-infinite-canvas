from __future__ import annotations

import io
import json
import os
import socket
import sys
import tempfile
import threading
import unittest
import urllib.request
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

from workbench_doctor import NODE_DIRS, WorkbenchDoctor, redact_text


class FakeComfyHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/system_stats":
            payload = {"system": {"comfyui_version": "0.42.5"}}
        elif self.path == "/object_info":
            payload = {name: {} for name in self.server.node_types}
        else:
            self.send_error(404)
            return
        body = json.dumps(payload).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


class DoctorTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.workbench = self.root / "workbench"
        self.comfy = self.root / "portable"
        self.projects = self.root / "projects"
        self.models = self.comfy / "ComfyUI" / "models"
        self.runtime = self.root / "runtime"
        for path in (self.workbench / "src", self.workbench / "models", self.comfy / "ComfyUI" / "custom_nodes", self.projects):
            path.mkdir(parents=True, exist_ok=True)
        (self.workbench / "src" / "workbench-api.js").write_text("const a={class_type:'NodeA'}; const b={class_type:'NodeB'};", encoding="utf-8")
        for name in NODE_DIRS:
            (self.comfy / "ComfyUI" / "custom_nodes" / name).mkdir()
        self.write_manifest([{"path": "diffusion_models/model.safetensors", "bytes": 4}])
        (self.models / "diffusion_models").mkdir(parents=True)
        (self.models / "diffusion_models" / "model.safetensors").write_bytes(b"data")
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), FakeComfyHandler)
        self.server.node_types = {"NodeA", "NodeB"}
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.port = self.server.server_port
        self.comfy_url = f"http://127.0.0.1:{self.port}"

    def tearDown(self):
        if self.server:
            self.server.shutdown()
            self.server.server_close()
            self.thread.join(timeout=3)
        self.temporary.cleanup()

    def write_manifest(self, files):
        (self.workbench / "models" / "manifest.json").write_text(json.dumps({"files": files}), encoding="utf-8")

    def doctor(self, **kwargs):
        return WorkbenchDoctor(self.workbench, self.comfy, self.projects, comfy_url=self.comfy_url,
                               workbench_port=self.port, runtime=self.runtime, timeout=1, **kwargs)

    def test_healthy_environment_checks_files_registration_ports_and_probe_cleanup(self):
        report = self.doctor().run({"userAgent": "TestBrowser/1.0"})
        self.assertEqual(report["errorCount"], 0, report)
        warnings = [check for check in report["checks"] if check["status"] == "warning"]
        self.assertTrue(all(check["id"] == "deepseek" and not check["configured"] for check in warnings), report)
        models = next(item for item in report["checks"] if item["id"] == "models")
        nodes = next(item for item in report["checks"] if item["id"] == "nodes")
        self.assertEqual((models["found"], models["total"]), (1, 1))
        self.assertEqual(nodes["missingRegistered"], [])
        self.assertEqual(report["browser"]["userAgent"], "TestBrowser/1.0")
        self.assertEqual(list(self.projects.glob(".h3-doctor-*")), [])

    def test_missing_and_wrong_sized_models_are_specific(self):
        self.write_manifest([
            {"path": "diffusion_models/model.safetensors", "bytes": 99},
            {"path": "loras/missing.safetensors", "bytes": 4},
        ])
        report = self.doctor().run()
        models = next(item for item in report["checks"] if item["id"] == "models")
        self.assertEqual(models["status"], "error")
        self.assertEqual(models["missing"], ["loras/missing.safetensors"])
        self.assertEqual(models["mismatched"][0]["actualBytes"], [4])

    def test_external_model_yaml_adds_root_without_writing_it(self):
        external = self.root / "external-models"
        (external / "diffusion_models").mkdir(parents=True)
        (external / "diffusion_models" / "model.safetensors").write_bytes(b"data")
        (self.models / "diffusion_models" / "model.safetensors").unlink()
        (self.comfy / "ComfyUI" / "extra_model_paths.yaml").write_text(f"h3:\n  base_path: {external.as_posix()}\n  diffusion_models: diffusion_models\n", encoding="utf-8")
        doctor = WorkbenchDoctor(self.workbench, self.comfy, self.projects, comfy_url=self.comfy_url,
                                 workbench_port=self.port, runtime=self.runtime, timeout=1)
        models = next(item for item in doctor.run()["checks"] if item["id"] == "models")
        self.assertEqual(models["status"], "ok")
        self.assertTrue(any(os.path.samefile(path, external) for path in models["roots"]))
        self.assertEqual([path.name for path in external.iterdir()], ["diffusion_models"])

    def test_missing_directories_and_online_registration_are_both_reported(self):
        (self.comfy / "ComfyUI" / "custom_nodes" / NODE_DIRS[0]).rmdir()
        self.server.node_types = {"NodeA"}
        nodes = next(item for item in self.doctor().run()["checks"] if item["id"] == "nodes")
        self.assertEqual(nodes["status"], "error")
        self.assertEqual(nodes["missingDirectories"], [NODE_DIRS[0]])
        self.assertEqual(nodes["missingRegistered"], ["NodeB"])

    def test_stopped_comfy_and_occupied_non_comfy_port_are_errors(self):
        port = self.port
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=3)
        self.server = None
        report = self.doctor().run()
        self.assertEqual(next(item for item in report["checks"] if item["id"] == "comfy")["status"], "error")
        self.assertEqual(next(item for item in report["checks"] if item["label"] == "ComfyUI 端口")["status"], "error")

        blocker = socket.socket()
        blocker.bind(("127.0.0.1", port))
        blocker.listen()
        try:
            report = self.doctor().run()
            self.assertEqual(next(item for item in report["checks"] if item["label"] == "ComfyUI 端口")["status"], "ok")
            self.assertEqual(next(item for item in report["checks"] if item["id"] == "comfy")["status"], "error")
        finally:
            blocker.close()

    def test_deepseek_is_offline_by_default_and_log_bundle_is_redacted(self):
        secret = "sk-test-super-secret-value"
        with mock.patch.dict(os.environ, {"DEEPSEEK_API_KEY": secret}), mock.patch("urllib.request.urlopen", wraps=urllib.request.urlopen) as online:
            report = self.doctor().run()
            external = [call for call in online.call_args_list if "deepseek.com" in str(call)]
            self.assertEqual(external, [])
            deepseek = next(item for item in report["checks"] if item["id"] == "deepseek")
            self.assertEqual(deepseek, {"id": "deepseek", "label": "DeepSeek", "status": "ok", "detail": "已配置；未发起外部请求。", "configured": True, "connectivity": "not_checked"})
            logs = self.runtime / "logs"
            logs.mkdir(parents=True)
            (logs / "app.log").write_text(f"Authorization: Bearer {secret}\ntoken={secret}\nCookie: h3_session=private\n", encoding="utf-8")
            (logs / "instance.json").write_text(secret, encoding="utf-8")
            bundle = self.doctor().create_log_bundle(report)
            with zipfile.ZipFile(io.BytesIO(bundle)) as archive:
                self.assertNotIn("logs/instance.json", archive.namelist())
                self.assertIn("logs/app.log", archive.namelist())
                combined = b"\n".join(archive.read(name) for name in archive.namelist())
                self.assertNotIn(secret.encode(), combined)
                self.assertNotIn(b"h3_session=private", combined)

    def test_optional_deepseek_connectivity_is_explicit(self):
        response = mock.MagicMock()
        response.status = 200
        response.__enter__.return_value = response
        original_urlopen = urllib.request.urlopen
        with mock.patch.dict(os.environ, {"DEEPSEEK_API_KEY": "sk-test-secret"}), mock.patch("urllib.request.urlopen", side_effect=lambda request, **kwargs: response if isinstance(request, urllib.request.Request) else original_urlopen(request, **kwargs)) as online:
            deepseek = next(item for item in self.doctor().run(check_deepseek=True)["checks"] if item["id"] == "deepseek")
            self.assertEqual(deepseek["connectivity"], "ok")
            external = [call for call in online.call_args_list if isinstance(call.args[0], urllib.request.Request)]
            self.assertEqual(len(external), 1)

    def test_redaction_covers_json_and_bearer_credentials(self):
        text = redact_text('{"token":"abc123", "Authorization":"Bearer xyz"}\nsk-abcdefgh123456')
        self.assertNotIn("abc123", text)
        self.assertNotIn("xyz", text)
        self.assertNotIn("sk-abcdefgh123456", text)


if __name__ == "__main__":
    unittest.main()
