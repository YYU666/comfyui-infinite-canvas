from __future__ import annotations

import os
import io
from contextlib import redirect_stderr, redirect_stdout
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import install

ROOT = Path(__file__).resolve().parent


class InstallTests(unittest.TestCase):
    def make_portable(self, directory: str) -> Path:
        root = Path(directory) / "便携版 with spaces"
        (root / "ComfyUI").mkdir(parents=True)
        (root / "ComfyUI" / "main.py").write_text("# fixture", encoding="utf-8")
        (root / "python_embeded").mkdir()
        (root / "python_embeded" / "python.exe").write_bytes(b"fixture")
        return root

    def invoke(self, root: Path, extra: list[str]) -> tuple[int, str, str]:
        stdout, stderr = io.StringIO(), io.StringIO()
        argv = ["install.py", "--comfy-root", str(root), "--log-dir", str(root.parent / "日志 with spaces"), *extra]
        with mock.patch.object(sys, "argv", argv), redirect_stdout(stdout), redirect_stderr(stderr):
            code = install.main()
        return code, stdout.getvalue(), stderr.getvalue()

    def test_large_success_output_goes_directly_to_complete_log(self):
        with tempfile.TemporaryDirectory() as temporary:
            reporter = install.InstallerReport(Path(temporary) / "日志 with spaces")
            stdout = io.StringIO()
            script = "import sys; sys.stdout.buffer.write(b'x'*1048576); sys.stderr.buffer.write(b'END')"
            with redirect_stdout(stdout), mock.patch.object(install.subprocess, "run", wraps=subprocess.run) as child:
                with reporter.stage("模拟安装"):
                    log = reporter.command([sys.executable, "-c", script])
            self.assertEqual(log.stat().st_size, 1048579)
            self.assertLess(len(stdout.getvalue()), 200)
            self.assertNotEqual(child.call_args.kwargs["stdout"], subprocess.PIPE)
            self.assertNotIn("capture_output", child.call_args.kwargs)
            self.assertEqual(log.read_bytes().count(b"x"), 1048576)

    def test_failure_tail_is_bounded_redacted_and_preserves_exit(self):
        with tempfile.TemporaryDirectory() as temporary:
            reporter = install.InstallerReport(Path(temporary))
            script = ("import sys; sys.stdout.write('x'*1048576+'\\n'); "
                      "sys.stdout.write('\\n'.join('line '+str(n) for n in range(30))+'\\n'); "
                      "sys.stdout.write('https://user:credential@example.com/failure\\nAPI_KEY=private_value\\n'); sys.exit(7)")
            with self.assertRaises(install.InstallFailure) as caught:
                reporter.command([sys.executable, "-c", script])
            output = io.StringIO()
            with redirect_stderr(output):
                self.assertEqual(reporter.failure(caught.exception), 7)
            tail = install.safe_tail(caught.exception.log)
            self.assertLessEqual(len(tail.encode("utf-8")), 3072)
            self.assertLessEqual(len(tail.splitlines()), 12)
            self.assertIn("line 29", output.getvalue())
            self.assertNotIn("line 0\n", output.getvalue())
            self.assertNotIn("credential", output.getvalue())
            self.assertNotIn("private_value", output.getvalue())
            self.assertIn("退出码：7", output.getvalue())
            self.assertIn(str(caught.exception.log), output.getvalue())
            self.assertGreater(caught.exception.log.stat().st_size, 1048576)

    def test_huge_final_line_and_truncated_secret_never_flood_console(self):
        with tempfile.TemporaryDirectory() as temporary:
            log = Path(temporary) / "huge.log"
            log.write_text("TOKEN=" + "private" * 200000, encoding="utf-8")
            self.assertNotIn("private", install.safe_tail(log))
            log.write_text("z" * 60000 + "\n", encoding="utf-8")
            self.assertLessEqual(len(install.safe_tail(log).encode("utf-8")), 3072)

    def test_verbose_streams_output_and_keeps_complete_log(self):
        with tempfile.TemporaryDirectory() as temporary:
            reporter = install.InstallerReport(Path(temporary), verbose=True)
            stdout = io.StringIO()
            with redirect_stdout(stdout):
                log = reporter.command([sys.executable, "-c", "import sys; sys.stdout.buffer.write(b'v'*1048576)"])
            self.assertEqual(stdout.getvalue(), "v" * 1048576)
            self.assertEqual(log.stat().st_size, 1048576)

    def test_models_only_runs_one_command_and_resets_reporter_each_time(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = self.make_portable(temporary)
            for profile in ("core-h3", "full"):
                with mock.patch.object(install, "run") as run, mock.patch.object(install.shutil, "which") as which, \
                     mock.patch.object(install, "install_nodes") as nodes:
                    code, stdout, stderr = self.invoke(root, ["--models-only", "--models-source", str(root / "模型 source"), "--profile", profile])
                self.assertEqual((code, stderr), (0, ""))
                self.assertEqual(run.call_count, 1)
                command = run.call_args.args[0]
                self.assertEqual(Path(command[1]).name, "install_models.py")
                self.assertEqual(command[-1], profile)
                which.assert_not_called()
                nodes.assert_not_called()
                self.assertIn("离线/在线验收", stdout)
                self.assertIsNone(install._REPORT.get())
            self.assertEqual(len(list((root.parent / "日志 with spaces").iterdir())), 2)

    def test_models_only_requires_source_before_any_work(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = self.make_portable(temporary)
            with mock.patch.object(install, "InstallerReport") as reporter:
                with self.assertRaises(SystemExit) as caught:
                    self.invoke(root, ["--models-only"])
            self.assertEqual(caught.exception.code, 2)
            reporter.assert_not_called()

    def test_missing_tools_fail_before_mutating_target_or_running_install(self):
        for missing in ("git", "node", "npm"):
            with self.subTest(missing=missing), tempfile.TemporaryDirectory() as temporary:
                root = self.make_portable(temporary)
                before = sorted(path.relative_to(root) for path in root.rglob("*"))
                def which(name):
                    return None if name.split(".")[0] == missing else name
                with mock.patch.object(install.shutil, "which", side_effect=which), \
                     mock.patch.object(install.InstallerReport, "capture", return_value="20.19.0"), \
                     mock.patch.object(install, "run") as run, mock.patch.object(install, "install_nodes") as nodes:
                    code, _, stderr = self.invoke(root, [])
                self.assertNotEqual(code, 0)
                self.assertIn("前置检查", stderr)
                run.assert_not_called()
                nodes.assert_not_called()
                self.assertEqual(sorted(path.relative_to(root) for path in root.rglob("*")), before)

    def test_old_node_version_fails_before_install(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = self.make_portable(temporary)
            with mock.patch.object(install.shutil, "which", side_effect=lambda name: name), \
                 mock.patch.object(install.InstallerReport, "capture", side_effect=["git version", "20.18.0"]), \
                 mock.patch.object(install, "run") as run:
                code, _, stderr = self.invoke(root, [])
            self.assertEqual(code, 1)
            self.assertIn("20.18.0", stderr)
            run.assert_not_called()

    def test_command_launch_failure_is_handled_and_reporter_does_not_leak(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = self.make_portable(temporary)
            with mock.patch.object(install, "run", side_effect=OSError("synthetic launch failure")) as run:
                code, stdout, stderr = self.invoke(root, ["--skip-nodes", "--skip-frontend"])
            self.assertEqual(code, 1)
            self.assertEqual(run.call_count, 1)
            self.assertIn("Python 依赖", stderr)
            self.assertIn("synthetic launch failure", stderr)
            self.assertNotIn("步骤已完成", stdout)
            self.assertIsNone(install._REPORT.get())

    def test_real_child_failure_stops_main_without_retry_or_later_stages(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = self.make_portable(temporary)
            def fail(command, cwd=None):
                install._REPORT.get().command([sys.executable, "-c", "import sys; print('synthetic pip error'); sys.exit(9)"])
            with mock.patch.object(install, "run", side_effect=fail) as run:
                code, stdout, stderr = self.invoke(root, ["--skip-nodes", "--skip-frontend", "--models-source", str(root / "models")])
            self.assertEqual(code, 9)
            self.assertEqual(run.call_count, 1)
            self.assertIn("synthetic pip error", stderr)
            self.assertIn("退出码：9", stderr)
            self.assertNotIn("模型安装", stdout)
            self.assertNotIn("步骤已完成", stdout)
            self.assertIsNone(install._REPORT.get())

    def test_log_write_failure_still_returns_bounded_failure(self):
        with tempfile.TemporaryDirectory() as temporary:
            reporter = install.InstallerReport(Path(temporary))
            stderr = io.StringIO()
            with mock.patch.object(Path, "write_text", side_effect=OSError("disk full")), redirect_stderr(stderr):
                self.assertEqual(reporter.failure(OSError("API_KEY=private")), 1)
            self.assertIn("磁盘空间", stderr.getvalue())
            self.assertNotIn("private", stderr.getvalue())

    def test_missing_portable_python_never_falls_back_or_writes(self):
        self.assertEqual(install.portable_python(Path("E:/missing")), Path("E:/missing/python_embeded/python.exe"))
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            comfy = root / "ComfyUI"
            comfy.mkdir()
            (comfy / "main.py").write_text("# fixture", encoding="utf-8")
            before = sorted(path.relative_to(root) for path in root.rglob("*"))
            result = subprocess.run(
                [sys.executable, str(ROOT / "install.py"), "--comfy-root", str(root)],
                cwd=ROOT, capture_output=True, text=True, encoding="utf-8", timeout=20,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("不会回退系统 Python", result.stderr)
            self.assertEqual(sorted(path.relative_to(root) for path in root.rglob("*")), before)
        batch = (ROOT / "install.bat").read_text(encoding="utf-8")
        self.assertNotIn('set "PYTHON=py"', batch)
        self.assertNotIn("PYTHON_ARGS", batch)

    def test_python_install_uses_hash_locked_requirements(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "ComfyUI").mkdir()
            (root / "ComfyUI" / "main.py").write_text("# fixture", encoding="utf-8")
            (root / "python_embeded").mkdir()
            python = root / "python_embeded" / "python.exe"
            python.write_bytes(b"fixture")
            commands = []
            with mock.patch.object(install, "run", side_effect=lambda command, cwd=None: commands.append(command)), \
                 mock.patch.object(sys, "argv", ["install.py", "--comfy-root", str(root), "--skip-nodes", "--skip-frontend"]):
                self.assertEqual(install.main(), 0)
            self.assertTrue(os.path.samefile(commands[0][0], python))
            self.assertEqual(commands[0][1:3], ["-m", "pip"])
            self.assertIn("--require-hashes", commands[0])
            self.assertEqual(Path(commands[0][-1]).name, "requirements.lock")
            if os.name == "nt":
                self.assertEqual(Path(commands[-1][3]).name, "workbench_start.py")
                self.assertEqual(commands[-1][-3:], ["--comfy-root", str(root.resolve()), "register"])

    def test_models_source_defaults_to_core_and_explicit_full_is_forwarded(self):
        for extra, expected in (([], "core-h3"), (["--profile", "full"], "full")):
            with self.subTest(profile=expected), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                (root / "ComfyUI").mkdir()
                (root / "ComfyUI" / "main.py").write_text("# fixture", encoding="utf-8")
                (root / "python_embeded").mkdir()
                python = root / "python_embeded" / "python.exe"
                python.write_bytes(b"fixture")
                commands = []
                argv = ["install.py", "--comfy-root", str(root), "--models-source", str(root / "models"),
                        "--skip-python", "--skip-nodes", "--skip-frontend", *extra]
                with mock.patch.object(install, "run", side_effect=lambda command, cwd=None: commands.append(command)), \
                     mock.patch.object(sys, "argv", argv):
                    self.assertEqual(install.main(), 0)
                self.assertEqual(len(commands), 2 if os.name == "nt" else 1)
                command = commands[0]
                self.assertEqual(Path(command[1]).name, "install_models.py")
                self.assertEqual(command[command.index("--profile") + 1], expected)

    def test_lock_covers_every_pin_with_sha256(self):
        pins = [line.strip() for line in (ROOT / "requirements.txt").read_text(encoding="utf-8").splitlines()
                if line.strip() and not line.startswith("#")]
        lock = (ROOT / "requirements.lock").read_text(encoding="utf-8")
        self.assertIn("--require-hashes", lock)
        for pin in pins:
            self.assertIn(f"{pin} \\", lock)
        hashes = re.findall(r"--hash=sha256:([0-9a-f]{64})", lock)
        self.assertGreater(len(hashes), len(pins))
        self.assertEqual(len(hashes), len(set(hashes)), "同一哈希可能对应多个文件名，但不应有无意义重复行")

    def test_third_party_repositories_are_commit_pinned(self):
        self.assertEqual(len(install.NODE_PACKAGES), 6)
        for repository, commit in install.NODE_PACKAGES.values():
            self.assertTrue(repository.startswith("https://github.com/"))
            self.assertRegex(commit, r"^[0-9a-f]{40}$")

    def test_existing_conflicting_node_is_preserved(self):
        with tempfile.TemporaryDirectory() as temporary:
            comfy = Path(temporary)
            custom = comfy / "custom_nodes"
            target = custom / "h3-relay"
            target.mkdir(parents=True)
            (target / ".git").mkdir()
            sentinel = target / "keep.txt"
            sentinel.write_text("do-not-overwrite", encoding="utf-8")
            own = custom / "h3_workbench_refine"
            with mock.patch.object(install, "git_head", return_value="0" * 40):
                with self.assertRaisesRegex(RuntimeError, "已保留原目录"):
                    install.install_nodes(comfy, Path("unused-python.exe"))
            self.assertEqual(sentinel.read_text(encoding="utf-8"), "do-not-overwrite")
            self.assertTrue(own.exists(), "专用节点在冲突检查前同步，冲突节点本身不被修改")


if __name__ == "__main__":
    unittest.main()
