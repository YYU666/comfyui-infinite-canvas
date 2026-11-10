from __future__ import annotations

import base64
import contextlib
import io
import json
import os
import socket
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request
from unittest.mock import MagicMock, Mock, patch

import workbench_start as start
from workbench_lifecycle import instance_process_alive, workbench_ports


class WindowsStartTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        environment = patch.dict(os.environ, {"H3_WORKBENCH_RUNTIME_DIR": str(Path(self.temporary.name) / "runtime")})
        environment.start()
        self.addCleanup(environment.stop)
        self.root = Path(self.temporary.name) / "便携版 with spaces"
        self.workbench = Path(self.temporary.name) / "工作台 & '$` code"
        for path in (self.root / "python_embeded/pythonw.exe", self.root / "python_embeded/python.exe",
                     self.root / "ComfyUI/main.py", self.workbench / "workbench_start.py",
                     self.workbench / "video_workbench_launcher.py", self.workbench / "public/favicon.ico"):
            path.parent.mkdir(parents=True, exist_ok=True)
            path.touch()

    def test_protocol_only_allows_fixed_start_url(self):
        for url in ("refmuse-canvas://start", "refmuse-canvas://start/"):
            self.assertEqual(start.validate_protocol_url(url), url)
        for url in ("", " refmuse-canvas://start", "refmuse-canvas://start\n", "REFMUSE-CANVAS://start", "refmuse-canvas://start?cmd=open",
                    "refmuse-canvas://start#x", "refmuse-canvas://start/path", "refmuse-canvas://user@start", "refmuse-canvas://start:80",
                    "refmuse-canvas://%73tart", 'refmuse-canvas://start" --comfy-root C:\\evil', "file:///C:/evil",
                    "refmuse-canvas://start/%2e%2e", "refmuse-canvas://start\\evil"):
            with self.subTest(url=url), self.assertRaises(ValueError):
                start.validate_protocol_url(url)

    def test_previous_origin_is_preferred_only_inside_reserved_port_range(self):
        self.assertEqual(workbench_ports({"port": 8792}), [8792, 8790, 8791, *range(8793, 8800)])
        for value in (0, 80, 8800, -1, "8791", True, None, [], {}):
            with self.subTest(port=value):
                self.assertEqual(workbench_ports({"port": value}), list(range(8790, 8800)))

    def test_invalid_url_or_injected_arguments_never_launch_or_register(self):
        for suffix in (["protocol", "refmuse-canvas://evil"], ["protocol", "refmuse-canvas://start", "register"],
                       ["protocol", "refmuse-canvas://start", "--comfy-root", "C:/evil"],
                       ["protocol", "refmuse-canvas://start", "--debug"]):
            with self.subTest(suffix=suffix), patch.object(start, "start_workbench") as launch, \
                 patch.object(start, "register_windows_integration") as register, contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit) as caught:
                    start.main(["--comfy-root", str(self.root), *suffix])
                self.assertEqual(caught.exception.code, 2)
                launch.assert_not_called()
                register.assert_not_called()

    def test_registration_validates_portable_and_separate_source_tree(self):
        root, workbench, pythonw = start.validate_launch_paths(self.root, self.workbench)
        self.assertEqual(workbench, self.workbench.resolve())
        self.assertEqual(pythonw, root / "python_embeded/pythonw.exe")
        pythonw.unlink()
        with self.assertRaisesRegex(ValueError, "不会使用系统 Python"):
            start.validate_launch_paths(self.root, self.workbench)
        with self.assertRaisesRegex(ValueError, "不支持的字符"):
            start.validate_launch_paths(self.root / "%1", self.workbench)

    def test_protocol_command_quotes_paths_and_has_only_fixed_handler(self):
        root, workbench, pythonw = start.validate_launch_paths(self.root, self.workbench)
        command = start.protocol_command(root, workbench, pythonw)
        self.assertTrue(command.startswith(f'"{pythonw}" -s -X utf8 '))
        self.assertIn(f'"{workbench / "workbench_start.py"}"', command)
        self.assertIn(f'--comfy-root "{root}" protocol "%1"', command)
        self.assertNotIn("cmd.exe", command)
        self.assertNotIn("powershell", command)
        if os.name == "nt":
            import ctypes
            count = ctypes.c_int()
            split = ctypes.windll.shell32.CommandLineToArgvW
            split.argtypes = [ctypes.c_wchar_p, ctypes.POINTER(ctypes.c_int)]
            split.restype = ctypes.POINTER(ctypes.c_wchar_p)
            parsed = split(command, ctypes.byref(count))
            try:
                self.assertEqual(list(parsed[:count.value]), [str(pythonw), *start.launch_arguments(root, workbench, "protocol"), "%1"])
            finally:
                ctypes.windll.kernel32.LocalFree(parsed)

    def test_registry_only_writes_current_user_and_reregistration_is_stable(self):
        registry = MagicMock()
        registry.OpenKey.side_effect = FileNotFoundError
        root, workbench, pythonw = start.validate_launch_paths(self.root, self.workbench)
        for _ in range(2):
            start.register_protocol(root, workbench, pythonw, workbench / "public/favicon.ico", registry)
        calls = registry.CreateKeyEx.call_args_list
        self.assertEqual(len(calls), 6)
        for call in calls:
            self.assertIs(call.args[0], registry.HKEY_CURRENT_USER)
            self.assertTrue(call.args[1].startswith(r"Software\Classes\refmuse-canvas"))
        self.assertEqual(calls[:3], calls[3:])
        values = [call.args for call in registry.SetValueEx.call_args_list]
        self.assertTrue(any(value[1] == "URL Protocol" and value[-1] == "" for value in values))
        self.assertTrue(any(value[-1] == start.protocol_command(root, workbench, pythonw) for value in values))
        self.assertTrue(all(value[-2] is registry.REG_SZ for value in values))

    def test_unrelated_protocol_is_preserved_and_our_registration_can_update(self):
        registry = MagicMock()
        registry.QueryValueEx.return_value = ("other", registry.REG_SZ)
        root, workbench, pythonw = start.validate_launch_paths(self.root, self.workbench)
        with self.assertRaisesRegex(RuntimeError, "其他程序"):
            start.register_protocol(root, workbench, pythonw, workbench / "public/favicon.ico", registry)
        registry.OpenKey.assert_called_with(registry.HKEY_CLASSES_ROOT, "refmuse-canvas", 0, registry.KEY_READ)
        registry.CreateKeyEx.assert_not_called()
        registry.SetValueEx.assert_not_called()
        registry.QueryValueEx.return_value = ("1", registry.REG_SZ)
        start.register_protocol(root, workbench, pythonw, workbench / "public/favicon.ico", registry)
        self.assertEqual(registry.CreateKeyEx.call_count, 3)

    def test_live_process_guard_distinguishes_reused_pid(self):
        process = Mock()
        process.create_time.return_value = 12345.0
        process.is_running.return_value = True
        with patch("psutil.Process", return_value=process):
            self.assertTrue(instance_process_alive({"pid": 123, "pidCreatedAt": 12345.0}))
            self.assertFalse(instance_process_alive({"pid": 123, "pidCreatedAt": 12.0}))
        self.assertFalse(instance_process_alive({"pid": -1}))

    def test_unresponsive_live_backend_does_not_create_another_server(self):
        with patch.dict(os.environ, {"H3_WORKBENCH_DATA_DIR": str(Path(self.temporary.name) / "data")}):
            import video_workbench_launcher as launcher
        with patch.object(launcher, "configure_logging", return_value=Path(self.temporary.name)), \
             patch.object(launcher, "read_instance", return_value={"pid": os.getpid()}), \
             patch.object(launcher, "probe_health", return_value=None), \
             patch.object(launcher, "WorkbenchServer") as server, patch.object(launcher, "LOGGER") as logger:
            self.assertEqual(launcher.main(), 1)
        server.assert_not_called()
        self.assertIn("未启动第二个服务", str(logger.exception.call_args.args[-1]))

    @unittest.skipUnless(os.name == "nt", "Windows shortcut")
    def test_shortcut_uses_redirected_desktop_and_data_is_not_shell_code(self):
        root, workbench, pythonw = start.validate_launch_paths(self.root, self.workbench)
        with patch.object(start.subprocess, "run") as run:
            start.create_shortcut(root, workbench, pythonw, workbench / "public/favicon.ico")
        args, kwargs = run.call_args
        script = base64.b64decode(args[0][-1]).decode("utf-16-le")
        config = json.loads(kwargs["env"]["REFMUSE_SHORTCUT_CONFIG"])
        self.assertEqual(config["target"], str(pythonw))
        self.assertEqual(config["name"], "Refmuse 画布.lnk")
        self.assertTrue(config["arguments"].endswith(" open"))
        self.assertIn("SpecialFolders.Item('Desktop')", script)
        self.assertNotIn(str(workbench), script)
        self.assertNotIn("shell", kwargs)
        self.assertEqual(kwargs["creationflags"], subprocess.CREATE_NO_WINDOW)

    def test_open_and_protocol_delegate_browser_policy_to_existing_launcher(self):
        launch = Mock(return_value=0)
        fake_launcher = Mock(main=launch)
        with patch.dict(sys.modules, {"video_workbench_launcher": fake_launcher}), patch.dict(os.environ), \
             patch.object(start, "report_failure"):
            os.environ["H3_WORKBENCH_NO_BROWSER"] = "1"
            launch.side_effect = lambda: int("H3_WORKBENCH_NO_BROWSER" in os.environ)
            self.assertEqual(start.main(["--comfy-root", str(self.root), "open"]), 0)
            self.assertEqual(os.environ["H3_COMFY_ROOT"], str(self.root.resolve()))
            self.assertEqual(start.main(["--comfy-root", str(self.root), "protocol", "refmuse-canvas://start"]), 1)
            self.assertEqual(os.environ["H3_WORKBENCH_NO_BROWSER"], "1")


class StartIntegrationTests(unittest.TestCase):
    def test_concurrent_protocol_wakes_share_instance_and_shortcut_opens_existing(self):
        # All backend state, media and frontend assets are temporary. No real
        # ComfyUI or browser is started, and no registry/desktop writes occur.
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            dist = root / "dist"
            dist.mkdir()
            (dist / "index.html").write_text("fixture", encoding="utf-8")
            marker = root / "browser.txt"
            stale_port = None
            for port in range(8799, 8790, -1):
                with socket.socket() as candidate:
                    try:
                        candidate.bind(("127.0.0.1", port))
                        stale_port = port
                        break
                    except OSError:
                        continue
            self.assertIsNotNone(stale_port, "need a free test port in workbench range")
            instance_file = root / "runtime/instance.json"
            instance_file.parent.mkdir()
            instance_file.write_text(json.dumps({"port": stale_port, "pid": -1}), encoding="utf-8")
            env = dict(os.environ, H3_WORKBENCH_RUNTIME_DIR=str(root / "runtime"),
                       H3_WORKBENCH_DATA_DIR=str(root / "data"), H3_PROJECTS_ROOT=str(root / "projects"),
                       H3_WORKBENCH_DIST_DIR=str(dist), H3_WORKBENCH_TEST_MODE="1",
                       H3_COMFY_URL="http://127.0.0.1:1", PYTHONUTF8="1")
            script = (f"import sys,webbrowser; from pathlib import Path; sys.path.insert(0,{str(start.HERE)!r}); "
                      f"webbrowser.open=lambda url: Path({str(marker)!r}).write_text(url,encoding='utf-8'); "
                      "import workbench_start; raise SystemExit(workbench_start.main(sys.argv[1:]))")
            base = [sys.executable, "-X", "utf8", "-c", script, "--comfy-root", str(root / "unused portable")]
            processes = []
            errors = (root / "startup-errors.txt").open("wb")
            try:
                for _ in range(2):
                    processes.append(subprocess.Popen([*base, "protocol", "refmuse-canvas://start"], env=env,
                                                       stdout=subprocess.DEVNULL, stderr=errors))
                deadline = time.monotonic() + 20
                instance = None
                while time.monotonic() < deadline:
                    try:
                        instance = json.loads(instance_file.read_text(encoding="utf-8"))
                        with urllib.request.urlopen(f"http://127.0.0.1:{instance['port']}/api/health", timeout=3) as response:
                            health = json.load(response)
                        if health["ok"] and health.get("pid") == instance["pid"]:
                            break
                    except (OSError, ValueError):
                        pass
                    time.sleep(0.1)
                else:
                    log = root / "runtime/logs/app.log"
                    detail = log.read_text(encoding="utf-8", errors="replace")[-2000:] if log.exists() else ""
                    detail += (root / "startup-errors.txt").read_text(encoding="utf-8", errors="replace")[-2000:]
                    self.fail("isolated launcher did not become healthy: " + detail)
                owner = next(process for process in processes if process.pid == instance["pid"])
                self.assertEqual(instance["port"], stale_port, "wake must preserve previous page origin")
                duplicate = next(process for process in processes if process != owner)
                self.assertEqual(duplicate.wait(timeout=15), 0)
                self.assertFalse(marker.exists(), "protocol must not open browser")
                pythonw = Path(sys.executable).with_name("pythonw.exe")
                executable = str(pythonw) if pythonw.is_file() else sys.executable
                direct = subprocess.run([executable, "-s", "-X", "utf8", str(start.HERE / "workbench_start.py"),
                                         "--comfy-root", str(root / "unused portable"), "protocol", "refmuse-canvas://start"],
                                        env=env, capture_output=True, timeout=15)
                self.assertEqual(direct.returncode, 0, direct.stderr)
                opened = subprocess.run([*base, "open"], env=env, capture_output=True, timeout=15)
                self.assertEqual(opened.returncode, 0, opened.stderr)
                self.assertEqual(marker.read_text(encoding="utf-8"), f"http://127.0.0.1:{instance['port']}/")
                self.assertEqual(json.loads(instance_file.read_text(encoding="utf-8"))["pid"], owner.pid)
                self.assertIsNone(owner.poll())
                self.assertFalse(instance["comfyOwned"])
                request = urllib.request.Request(f"http://127.0.0.1:{instance['port']}/api/shutdown", data=b"{}", method="POST",
                                                 headers={"X-H3-Token": instance["token"], "Content-Type": "application/json"})
                with urllib.request.urlopen(request, timeout=5) as response:
                    self.assertEqual(response.status, 200)
                self.assertEqual(owner.wait(timeout=15), 0)
                self.assertFalse(instance_file.exists())
                preferred = json.loads((root / "runtime/workbench-port.json").read_text(encoding="utf-8"))
                self.assertEqual(preferred, {"port": stale_port})
                processes.append(subprocess.Popen([*base, "protocol", "refmuse-canvas://start"], env=env,
                                                   stdout=subprocess.DEVNULL, stderr=errors))
                deadline = time.monotonic() + 15
                while time.monotonic() < deadline:
                    try:
                        restored = json.loads(instance_file.read_text(encoding="utf-8"))
                        with urllib.request.urlopen(f"http://127.0.0.1:{restored['port']}/api/health", timeout=3) as response:
                            if json.load(response)["ok"]:
                                break
                    except (OSError, ValueError):
                        pass
                    time.sleep(0.1)
                else:
                    self.fail("graceful stop then protocol wake did not recover")
                self.assertEqual(restored["port"], stale_port)
            finally:
                for process in processes:
                    if process.poll() is None:
                        process.terminate()
                    process.wait(timeout=10)
                errors.close()


if __name__ == "__main__":
    unittest.main()
