from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

from workbench_update_helper import backup_current, replace_program, restore_program, run, safe_path, wait_for_health


class HelperTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.base = Path(self.temporary.name)
        self.root = self.base / "workbench"
        self.source = self.base / "staging"
        self.backup = self.base / "backup"
        self.runtime = self.base / "runtime"
        self.root.mkdir(); self.source.mkdir(); self.runtime.mkdir()
        (self.root / "video_workbench_launcher.py").write_text("old", encoding="utf-8")
        (self.root / "requirements.lock").write_text("old lock", encoding="utf-8")
        (self.root / "obsolete.py").write_text("obsolete", encoding="utf-8")
        (self.root / "dist").mkdir(); (self.root / "dist" / "index.html").write_text("old dist", encoding="utf-8")
        (self.root / "node_modules").mkdir(); (self.root / "node_modules" / "old.js").write_text("old dependency", encoding="utf-8")
        (self.root / "projects").mkdir(); (self.root / "projects" / "project.json").write_text("user project", encoding="utf-8")
        (self.root / "models").mkdir(); (self.root / "models" / "model.bin").write_text("user model", encoding="utf-8")
        (self.root / "local-notes.txt").write_text("untracked and preserved", encoding="utf-8")
        (self.source / "video_workbench_launcher.py").write_text("new", encoding="utf-8")
        (self.source / "requirements.lock").write_text("new lock", encoding="utf-8")
        (self.source / "dist").mkdir(); (self.source / "dist" / "index.html").write_text("new dist", encoding="utf-8")
        (self.source / "node_modules").mkdir(); (self.source / "node_modules" / "new.js").write_text("new dependency", encoding="utf-8")
        self.new_manifest = self.source / ".package-manifest.json"
        self.new_manifest.write_text(json.dumps({"version": "v2.0.0", "files": [
            {"path": "video_workbench_launcher.py"}, {"path": "requirements.lock"},
        ]}), encoding="utf-8")
        self.installed = self.runtime / "installed-files.json"
        self.installed.write_text(json.dumps({"version": "v1.0.0", "installationRoot": os.path.normcase(str(self.root.resolve())), "files": [
            {"path": "video_workbench_launcher.py"}, {"path": "requirements.lock"}, {"path": "obsolete.py"},
        ]}), encoding="utf-8")
        self.status = self.runtime / "status.json"
        self.request = {
            "root": str(self.root), "source": str(self.source), "backup": str(self.backup),
            "runtimeDir": str(self.runtime), "targetVersion": "v2.0.0", "manifest": str(self.new_manifest),
            "installedManifest": str(self.installed), "status": str(self.status), "python": sys.executable,
        }
        self.new_paths = ["video_workbench_launcher.py", "requirements.lock"]
        self.old_paths = self.new_paths + ["obsolete.py"]

    def tearDown(self): self.temporary.cleanup()

    def assert_user_data_untouched(self):
        self.assertEqual((self.root / "projects" / "project.json").read_text(encoding="utf-8"), "user project")
        self.assertEqual((self.root / "models" / "model.bin").read_text(encoding="utf-8"), "user model")
        self.assertEqual((self.root / "local-notes.txt").read_text(encoding="utf-8"), "untracked and preserved")

    def test_swap_and_rollback_preserve_user_directories_and_unknown_files(self):
        backup_current(self.root, self.backup, self.old_paths)
        replace_program(self.root, self.source, self.backup, self.new_paths, self.old_paths)
        self.assertEqual((self.root / "video_workbench_launcher.py").read_text(encoding="utf-8"), "new")
        self.assertEqual((self.root / "dist" / "index.html").read_text(encoding="utf-8"), "new dist")
        self.assertFalse((self.root / "obsolete.py").exists())
        self.assert_user_data_untouched()
        restore_program(self.root, self.backup, self.new_paths, self.old_paths)
        self.assertEqual((self.root / "video_workbench_launcher.py").read_text(encoding="utf-8"), "old")
        self.assertEqual((self.root / "requirements.lock").read_text(encoding="utf-8"), "old lock")
        self.assertEqual((self.root / "dist" / "index.html").read_text(encoding="utf-8"), "old dist")
        self.assertEqual((self.root / "node_modules" / "old.js").read_text(encoding="utf-8"), "old dependency")
        self.assertEqual((self.root / "obsolete.py").read_text(encoding="utf-8"), "obsolete")
        self.assert_user_data_untouched()

    def test_success_installs_manifest_and_never_copies_user_data_to_stage(self):
        with mock.patch("workbench_update_helper.install_dependencies"), \
             mock.patch("workbench_update_helper.start_workbench", return_value=mock.Mock()), \
             mock.patch("workbench_update_helper.wait_for_health", return_value={"pid": 88}):
            run(self.request)
        self.assertEqual((self.root / "video_workbench_launcher.py").read_text(encoding="utf-8"), "new")
        self.assertEqual(json.loads(self.installed.read_text(encoding="utf-8"))["version"], "v2.0.0")
        self.assertEqual(json.loads(self.status.read_text(encoding="utf-8"))["phase"], "success")
        self.assertFalse(self.source.exists())
        self.assert_user_data_untouched()

    def test_failed_dependency_install_restores_old_program_and_dependencies(self):
        calls = []
        def dependencies(python, requirements):
            calls.append(Path(requirements).read_text(encoding="utf-8"))
            if len(calls) == 1: raise RuntimeError("synthetic pip failure")
        with mock.patch("workbench_update_helper.install_dependencies", side_effect=dependencies), \
             mock.patch("workbench_update_helper.start_workbench", return_value=mock.Mock()), \
             mock.patch("workbench_update_helper.wait_for_health", return_value={"pid": 89}):
            run(self.request)
        self.assertEqual(calls, ["new lock", "old lock"])
        self.assertEqual((self.root / "video_workbench_launcher.py").read_text(encoding="utf-8"), "old")
        self.assertEqual((self.root / "requirements.lock").read_text(encoding="utf-8"), "old lock")
        self.assertEqual((self.root / "obsolete.py").read_text(encoding="utf-8"), "obsolete")
        status = json.loads(self.status.read_text(encoding="utf-8"))
        self.assertEqual(status["phase"], "error")
        self.assertIn("已恢复并重新启动旧版", status["message"])
        self.assert_user_data_untouched()

    def test_manifest_paths_cannot_escape_install_root(self):
        for value in ("../outside", "/absolute", "C:/outside", "folder\\outside", ".", "folder/../outside", "file:stream"):
            with self.subTest(value=value), self.assertRaises(RuntimeError): safe_path(self.root, value)

    def test_parent_directory_link_cannot_write_outside_installation(self):
        outside = self.base / "outside"
        outside.mkdir()
        sentinel = outside / "keep.py"
        sentinel.write_text("private data", encoding="utf-8")
        link = self.root / "linked"
        if os.name == "nt":
            # Junction creation does not require admin or Developer Mode.
            command = "New-Item -ItemType Junction -Path $env:TEST_UPDATE_LINK -Target $env:TEST_UPDATE_TARGET | Out-Null"
            subprocess.run(["powershell", "-NoProfile", "-Command", command], check=True,
                           env={**os.environ, "TEST_UPDATE_LINK": str(link), "TEST_UPDATE_TARGET": str(outside)},
                           capture_output=True, timeout=15)
        else:
            link.symlink_to(outside, target_is_directory=True)
        try:
            with self.assertRaises(RuntimeError):
                backup_current(self.root, self.backup, ["linked/keep.py"])
            self.assertEqual(sentinel.read_text(encoding="utf-8"), "private data")
        finally:
            if os.name == "nt": link.rmdir()
            else: link.unlink()

    def test_foreign_installation_manifest_is_rejected_before_replacement(self):
        record = json.loads(self.installed.read_text(encoding="utf-8"))
        record["installationRoot"] = str(self.base / "another-installation")
        self.installed.write_text(json.dumps(record), encoding="utf-8")
        with self.assertRaises(RuntimeError):
            run(self.request)
        self.assertFalse(self.backup.exists())
        self.assertEqual((self.root / "video_workbench_launcher.py").read_text(encoding="utf-8"), "old")
        self.assert_user_data_untouched()

    def test_health_check_does_not_accept_another_instance(self):
        with mock.patch("workbench_update_helper.read_instance", return_value={"pid": 999, "port": 12345}), \
             mock.patch("workbench_update_helper.urllib.request.urlopen") as request, \
             mock.patch("workbench_update_helper.time.sleep"):
            with self.assertRaises(RuntimeError):
                wait_for_health(self.runtime, expected_pid=123, timeout=0.01)
        request.assert_not_called()

    def test_rollback_does_not_stop_another_instance(self):
        owned, restored = mock.Mock(pid=123), mock.Mock(pid=124)
        owned.poll.return_value = None
        with mock.patch("workbench_update_helper.install_dependencies"), \
             mock.patch("workbench_update_helper.start_workbench", side_effect=[owned, restored]), \
             mock.patch("workbench_update_helper.wait_for_health", side_effect=[RuntimeError("wrong instance"), {"pid": 124}]) as health, \
             mock.patch("workbench_update_helper.read_instance", return_value={"pid": 999}), \
             mock.patch("workbench_update_helper.stop_workbench") as stop:
            run(self.request)
        stop.assert_not_called()
        owned.terminate.assert_called_once()
        self.assertEqual([call.kwargs["expected_pid"] for call in health.call_args_list], [123, 124])
        self.assertEqual((self.root / "video_workbench_launcher.py").read_text(encoding="utf-8"), "old")
        self.assert_user_data_untouched()


if __name__ == "__main__": unittest.main()
