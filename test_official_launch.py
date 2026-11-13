from __future__ import annotations

import json
import os
import site
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import patch

from workbench_comfy_lifecycle import ComfyLifecycle
from workbench_lifecycle import (
    OFFICIAL_ISOLATION_ENVS,
    bind_workbench,
    comfy_autostart_enabled,
    comfy_launch_switches,
    request_comfy_start,
    workbench_ports,
)
from workbench_queue import QueueManager

ROOT = Path(__file__).resolve().parent
USER_SITE = site.getusersitepackages()
# Importing the launcher selects a data directory. Keep that choice inside this
# process's temporary root so a developer machine is not claimed as /H3_Workbench.
_PROCESS_ROOT = tempfile.TemporaryDirectory()
os.environ.setdefault("H3_WORKBENCH_RUNTIME_DIR", str(Path(_PROCESS_ROOT.name) / "runtime"))
os.environ.setdefault("H3_WORKBENCH_DATA_DIR", str(Path(_PROCESS_ROOT.name) / "data"))
os.environ.setdefault("H3_PROJECTS_ROOT", str(Path(_PROCESS_ROOT.name) / "projects"))

from video_workbench_launcher import WorkbenchHandler, WorkbenchServer  # noqa: E402


def child_env(base, **updates):
    env = os.environ.copy()
    env.pop("H3_WORKBENCH_TEST_MODE", None)
    python_path = [USER_SITE]
    if env.get("PYTHONPATH"):
        python_path.append(env["PYTHONPATH"])
    if updates.get("PYTHONPATH"):
        python_path.insert(0, updates.pop("PYTHONPATH"))
    env["PYTHONPATH"] = os.pathsep.join(path for path in python_path if path)
    env.update(updates)
    return env


class PortSelectionTests(unittest.TestCase):
    def test_unset_port_keeps_the_worktree_range(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("H3_WORKBENCH_PORT", None)
            self.assertEqual(workbench_ports({"port": 8792}), [8792, 8790, 8791, *range(8793, 8800)])
            self.assertEqual(workbench_ports(None), list(range(8790, 8800)))

    def test_explicit_port_binds_only_that_port_and_forbids_comfy_and_worktree_ports(self):
        with patch.dict(os.environ, {"H3_WORKBENCH_PORT": "18990"}):
            self.assertEqual(workbench_ports({"port": 8792}), [18990])
        for value in ("0", "00"):
            with self.subTest(value=value), patch.dict(os.environ, {"H3_WORKBENCH_PORT": value}):
                if value == "0":
                    self.assertEqual(workbench_ports(None), [0])
                else:
                    with self.assertRaises(RuntimeError):
                        workbench_ports(None)
        for value in ("8188", "8790", "8795", "8799"):
            with self.subTest(value=value), patch.dict(os.environ, {"H3_WORKBENCH_PORT": value}):
                with self.assertRaisesRegex(RuntimeError, "禁止"):
                    workbench_ports(None)

    def test_occupied_explicit_port_does_not_scan_the_worktree_range(self):
        held = socket.socket()
        self.addCleanup(held.close)
        occupied = None
        for candidate in (18980, 18981, 22111, 24111):
            try:
                held.bind(("127.0.0.1", candidate))
                occupied = candidate
                break
            except OSError:
                continue
        self.assertIsNotNone(occupied)
        attempts = []

        def factory(address):
            attempts.append(address[1])
            raise OSError("busy")

        with patch.dict(os.environ, {"H3_WORKBENCH_PORT": str(occupied)}):
            with self.assertRaisesRegex(RuntimeError, "不会改扫"):
                bind_workbench(factory, None)
        self.assertEqual(attempts, [occupied])

    def test_cli_port_uses_the_same_forbidden_set(self):
        from workbench_lifecycle import apply_cli_port
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("H3_WORKBENCH_PORT", None)
            apply_cli_port(["--port", "8790"])
            with self.assertRaisesRegex(RuntimeError, "禁止"):
                workbench_ports(None)

    def test_port_zero_is_assigned_by_the_os(self):
        with patch.dict(os.environ, {"H3_WORKBENCH_PORT": "0"}):
            server = bind_workbench(lambda address: WorkbenchServer(address, WorkbenchHandler), None)
        self.addCleanup(server.server_close)
        self.assertGreater(server.server_port, 0)
        self.assertNotIn(server.server_port, range(8790, 8800))
        self.assertNotEqual(server.server_port, 8188)


class IsolationTests(unittest.TestCase):
    def test_official_mode_without_directories_does_not_touch_localappdata(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            local = root / "Local"
            env = child_env(
                os.environ,
                LOCALAPPDATA=str(local),
                USERPROFILE=str(root / "profile"),
                HOME=str(root / "home"),
                H3_WORKBENCH_PORT="18972",
            )
            for name in OFFICIAL_ISOLATION_ENVS:
                env.pop(name, None)
            result = subprocess.run(
                [sys.executable, "-c", "import video_workbench_launcher"],
                cwd=ROOT, env=env, capture_output=True, text=True, timeout=60,
            )
            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("H3_WORKBENCH_RUNTIME_DIR", result.stderr)
            self.assertIn("不会使用", result.stderr)
            self.assertFalse((local / "H3Workbench").exists())
            self.assertFalse((root / "profile" / "Documents").exists())

    def test_official_runtime_without_comfy_tree_does_not_autostart(self):
        with tempfile.TemporaryDirectory() as temporary:
            runtime = Path(temporary)
            with patch.dict(os.environ, {"H3_WORKBENCH_PORT": "18973", "H3_COMFY_AUTOSTART": ""}, clear=False):
                os.environ.pop("H3_COMFY_AUTOSTART", None)
                self.assertEqual(comfy_launch_switches(runtime), (False, False))


class AutostartTests(unittest.TestCase):
    def test_flag_zero_does_not_request_comfy_start(self):
        with patch.dict(os.environ, {"H3_COMFY_AUTOSTART": "0"}):
            self.assertFalse(comfy_autostart_enabled())
            with patch("workbench_lifecycle.urllib.request.urlopen") as opened:
                self.assertFalse(request_comfy_start({"port": 9, "token": "secret"}, {"comfy": {"state": "exited"}}))
            opened.assert_not_called()

    def test_disabled_lifecycle_does_not_probe_or_spawn(self):
        calls = []

        def probe(url):
            calls.append(url)
            raise AssertionError(url)

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            lifecycle = ComfyLifecycle(
                url="http://127.0.0.1:8188", root=root, log_dir=root, command=["python"],
                spawn=probe, enabled=False, allow_start=False, probe=probe, obstacle=lambda url, root: probe(url),
            )
            lifecycle.request_start()
            lifecycle.status(refresh=True)
            time.sleep(0.3)
            lifecycle.close()
        self.assertEqual(calls, [])


class UiReadyTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.environment = patch.dict(os.environ, {
            "H3_WORKBENCH_RUNTIME_DIR": str(self.root / "runtime"),
            "H3_WORKBENCH_DATA_DIR": str(self.root / "data"),
            "H3_PROJECTS_ROOT": str(self.root / "projects"),
            "H3_COMFY_AUTOSTART": "0",
        })
        self.environment.start()
        self.server = WorkbenchServer(("127.0.0.1", 0), WorkbenchHandler)
        self.server.token = "ui-ready-token"
        self.server.started_at = "2026-01-01T00:00:00+00:00"
        self.server.ui_ready = False
        self.server.ui_ready_at = None
        self.server.comfy_owned = False
        self.server.comfy_process = None
        self.server.project_store = type("Store", (), {"root": self.root / "projects"})()
        self.server.queue_manager = QueueManager(self.root / "queue.json", poll_interval=0.01)
        probed = []

        def probe(url):
            probed.append(url)
            raise AssertionError(url)

        self.probed = probed
        self.server.comfy_lifecycle = ComfyLifecycle(
            url="http://127.0.0.1:8188", root=self.root, log_dir=self.root, command=["python"],
            spawn=probe, enabled=False, allow_start=False, probe=probe, obstacle=lambda url, root: probe(url),
        )
        from workbench_lifecycle import atomic_write_json
        atomic_write_json(self.root / "runtime" / "instance.json", {
            "pid": os.getpid(), "port": self.server.server_port, "token": self.server.token, "uiReady": False,
        })
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=3)
        self.server.queue_manager.stop()
        self.environment.stop()
        self.temporary.cleanup()

    def request(self, method, path, payload=None, headers=None):
        body = None if payload is None else (payload if isinstance(payload, bytes) else json.dumps(payload).encode("utf-8"))
        request = urllib.request.Request(self.base + path, data=body, method=method, headers=headers or {})
        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                content = response.read()
                return response.status, json.loads(content) if content else None
        except urllib.error.HTTPError as error:
            content = error.read()
            return error.code, json.loads(content) if content else None

    def test_ui_ready_requires_token_and_health_reports_it_without_one(self):
        status, body = self.request("POST", "/api/ui-ready", {}, {"Content-Type": "application/json"})
        self.assertEqual(status, 401)
        self.assertFalse(self.server.ui_ready)
        status, health = self.request("GET", "/api/health")
        self.assertEqual(status, 200)
        self.assertFalse(health["uiReady"])
        self.assertIsNone(health["uiReadyAt"])
        self.assertNotIn("ui-ready-token", json.dumps(health))
        self.assertNotIn("token", health)
        status, rejected = self.request("GET", "/api/health", headers={"Host": "127.0.0.1"})
        self.assertEqual((status, rejected["code"]), (403, "HOST_FORBIDDEN"))
        status, ready = self.request("POST", "/api/ui-ready", {}, {
            "Content-Type": "application/json",
            "X-H3-Token": self.server.token,
            "Host": f"127.0.0.1:{self.server.server_port}",
        })
        self.assertEqual(status, 200)
        self.assertTrue(ready["uiReady"])
        self.assertNotIn("ui-ready-token", json.dumps(ready))
        status, health = self.request("GET", "/api/health")
        self.assertEqual(status, 200)
        self.assertTrue(health["uiReady"])
        self.assertEqual(health["uiReadyAt"], ready["uiReadyAt"])
        self.assertEqual(health["pid"], os.getpid())
        self.assertNotIn("ui-ready-token", json.dumps(health))
        stored = json.loads((self.root / "runtime" / "instance.json").read_text(encoding="utf-8"))
        self.assertTrue(stored["uiReady"])
        self.assertEqual(stored["uiReadyAt"], ready["uiReadyAt"])
        self.assertEqual(self.probed, [])


class OfficialProcessTests(unittest.TestCase):
    def test_isolated_port_zero_records_runtime_and_does_not_probe_comfy(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            dist = root / "dist"
            dist.mkdir()
            (dist / "index.html").write_text("fixture", encoding="utf-8")
            runtime = root / "runtime"
            violations = root / "violations.txt"
            guard = root / "guard"
            guard.mkdir()
            (guard / "sitecustomize.py").write_text(
                "import os, socket, urllib.parse, urllib.request\n"
                "from pathlib import Path\n"
                f"violations = Path({str(violations)!r})\n"
                "def hit(target):\n"
                "    port = None\n"
                "    if isinstance(target, tuple) and len(target) >= 2:\n"
                "        try: port = int(target[1])\n"
                "        except (TypeError, ValueError): port = None\n"
                "    else:\n"
                "        text = str(getattr(target, 'full_url', target))\n"
                "        parsed = urllib.parse.urlsplit(text if '://' in text else '//' + text)\n"
                "        port = parsed.port\n"
                "    if port == 8188:\n"
                "        violations.parent.mkdir(parents=True, exist_ok=True)\n"
                "        with violations.open('a', encoding='utf-8') as handle: handle.write(repr(target) + '\\n')\n"
                "socket.socket.connect = lambda self, address, _orig=socket.socket.connect: (hit(address), _orig(self, address))[1]\n"
                "socket.socket.bind = lambda self, address, _orig=socket.socket.bind: (hit(address), _orig(self, address))[1]\n"
                "def urlopen(url, *args, _orig=urllib.request.urlopen, **kwargs):\n"
                "    hit(url)\n"
                "    return _orig(url, *args, **kwargs)\n"
                "urllib.request.urlopen = urlopen\n",
                encoding="utf-8",
            )
            env = child_env(
                os.environ,
                H3_WORKBENCH_PORT="0",
                H3_WORKBENCH_RUNTIME_DIR=str(runtime),
                H3_WORKBENCH_DATA_DIR=str(root / "data"),
                H3_PROJECTS_ROOT=str(root / "projects"),
                H3_WORKBENCH_DIST_DIR=str(dist),
                H3_COMFY_AUTOSTART="0",
                H3_COMFY_ROOT=str(root / "managed-runtime"),
                H3_COMFY_URL="http://127.0.0.1:8188",
                H3_WORKBENCH_NO_BROWSER="1",
                LOCALAPPDATA=str(root / "Local"),
                USERPROFILE=str(root / "profile"),
                HOME=str(root / "home"),
                PYTHONPATH=str(guard),
                PYTHONUTF8="1",
            )
            (root / "managed-runtime").mkdir()
            process = subprocess.Popen(
                [sys.executable, "-c", "import video_workbench_launcher as launcher; raise SystemExit(launcher.main())"],
                cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            )
            instance = None
            health = None
            try:
                deadline = time.monotonic() + 40
                while time.monotonic() < deadline:
                    try:
                        instance = json.loads((runtime / "instance.json").read_text(encoding="utf-8"))
                        with urllib.request.urlopen(f"http://127.0.0.1:{instance['port']}/api/health", timeout=3) as response:
                            health = json.load(response)
                        if health.get("ok") and health.get("pid") == instance.get("pid"):
                            break
                    except (OSError, ValueError, json.JSONDecodeError):
                        health = None
                    if process.poll() is not None:
                        break
                    time.sleep(0.1)
                if not health or not health.get("ok"):
                    log = runtime / "logs" / "app.log"
                    detail = log.read_text(encoding="utf-8", errors="replace")[-2000:] if log.exists() else ""
                    if process.poll() is None:
                        process.terminate()
                    stdout, stderr = process.communicate(timeout=10)
                    self.fail(f"official launcher did not become healthy\n{detail}\n{stderr}\n{stdout}")
                self.assertIsNotNone(health)
                self.assertNotIn(health["port"], range(8790, 8800))
                self.assertNotEqual(health["port"], 8188)
                self.assertEqual(health["port"], instance["port"])
                self.assertEqual(json.loads((runtime / "workbench-port.json").read_text(encoding="utf-8"))["port"], health["port"])
                self.assertFalse((root / "Local" / "H3Workbench").exists())
                self.assertFalse((root / "profile" / "Documents" / "H3 Workbench").exists())
                self.assertTrue((runtime / "instance.json").is_file())
                self.assertFalse(health["uiReady"])
                self.assertNotIn(instance["token"], json.dumps(health))
                denied = urllib.request.Request(
                    f"http://127.0.0.1:{health['port']}/api/ui-ready", data=b"{}", method="POST",
                    headers={"Content-Type": "application/json"},
                )
                with self.assertRaises(urllib.error.HTTPError) as caught:
                    urllib.request.urlopen(denied, timeout=5)
                self.assertEqual(caught.exception.code, 401)
                accepted = urllib.request.Request(
                    f"http://127.0.0.1:{health['port']}/api/ui-ready", data=b"{}", method="POST",
                    headers={"Content-Type": "application/json", "X-H3-Token": instance["token"]},
                )
                with urllib.request.urlopen(accepted, timeout=5) as response:
                    ready = json.load(response)
                self.assertTrue(ready["uiReady"])
                self.assertNotIn(instance["token"], json.dumps(ready))
                with urllib.request.urlopen(f"http://127.0.0.1:{health['port']}/api/health", timeout=5) as response:
                    reported = json.load(response)
                self.assertTrue(reported["uiReady"])
                self.assertEqual(reported["uiReadyAt"], ready["uiReadyAt"])
                self.assertNotIn(instance["token"], json.dumps(reported))
                self.assertNotIn("token", reported)
                stored = json.loads((runtime / "instance.json").read_text(encoding="utf-8"))
                self.assertTrue(stored["uiReady"])
                self.assertEqual(stored["port"], health["port"])
                time.sleep(1.2)
                self.assertFalse(violations.exists() and violations.read_text(encoding="utf-8").strip(), violations.read_text(encoding="utf-8") if violations.exists() else "")
                shutdown = urllib.request.Request(
                    f"http://127.0.0.1:{health['port']}/api/shutdown", data=b"{}", method="POST",
                    headers={"Content-Type": "application/json", "X-H3-Token": instance["token"]},
                )
                with urllib.request.urlopen(shutdown, timeout=5) as response:
                    self.assertEqual(response.status, 200)
                self.assertEqual(process.wait(timeout=20), 0)
            finally:
                if process.poll() is None:
                    process.terminate()
                try:
                    process.communicate(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.communicate(timeout=5)


if __name__ == "__main__":
    unittest.main()
