from __future__ import annotations

import json
import shutil
import subprocess
import unittest
from pathlib import Path
from unittest import mock

from test_workbench_update import UpdateTestCase
from workbench_update import UpdateError
from workbench_update_helper import ProgramPathConflict, backup_current, run


@unittest.skipUnless(shutil.which("git"), "Git is required to exercise upgrade ownership")
class UpdatePathCollisionTests(UpdateTestCase):
    def setUp(self):
        super().setUp()
        self.git("init", "-q")
        self.exclude = self.root / ".git" / "info" / "exclude"
        (self.root / "requirements.lock").write_text("# previous lock\n", encoding="utf-8")
        self.git("add", "requirements.lock")
        self.git("-c", "user.name=Test", "-c", "user.email=test@example.invalid",
                 "-c", "commit.gpgsign=false", "commit", "-qm", "Track the existing program")
        self.manager._prepare_frontend = self.prepare

    def git(self, *args):
        return subprocess.run(["git", "-C", str(self.root), *args], check=True,
                              capture_output=True, text=True)

    def write_conflict(self):
        conflict = self.root / "src" / "App.jsx"
        conflict.parent.mkdir()
        conflict.write_bytes(b"local source")
        return conflict

    def test_rejects_ordinary_and_ignored_package_collisions_before_shutdown(self):
        conflict = self.write_conflict()
        for ignored in (True, False):
            with self.subTest(ignored=ignored):
                self.exclude.write_text("/src/App.jsx\n" if ignored else "", encoding="utf-8")
                self.assertEqual(
                    self.git("status", "--porcelain", "-uall").stdout,
                    "" if ignored else "?? src/App.jsx\n",
                )
                with self.assertRaises(UpdateError) as rejected:
                    self.manager.apply("v9.9.9")
                self.assertEqual(rejected.exception.code, "LOCAL_CHANGES")
                self.assertIn("src/App.jsx", str(rejected.exception))
                self.assertEqual(conflict.read_bytes(), b"local source")
                self.process_launcher.assert_not_called()

    def test_unrelated_untracked_files_allow_existing_tracked_targets_to_update(self):
        notes = self.root / "local-notes.txt"
        notes.write_bytes(b"keep these notes")
        request = self.stage()
        with mock.patch("workbench_update_helper.install_dependencies"), \
             mock.patch("workbench_update_helper.start_workbench", return_value=mock.Mock(pid=88)), \
             mock.patch("workbench_update_helper.wait_for_health", return_value={"pid": 88}):
            run(request)
        self.assertEqual(notes.read_bytes(), b"keep these notes")
        self.assertEqual((self.root / "requirements.lock").read_bytes(), b"# locked\n")
        self.assertEqual((self.root / "src" / "App.jsx").read_bytes(), b"new app\n")

    def test_detached_helper_rechecks_for_conflict_created_after_preparation(self):
        request = self.stage()
        conflict = self.write_conflict()
        with mock.patch("workbench_update_helper.start_workbench", return_value=mock.Mock(pid=88)) as restart, \
             mock.patch("workbench_update_helper.wait_for_health", return_value={"pid": 88}), \
             mock.patch("workbench_update_helper.replace_program") as replace:
            with self.assertRaises(ProgramPathConflict):
                run(request)
        replace.assert_not_called()
        restart.assert_called_once_with(request["python"], self.root.resolve())
        self.assertFalse(Path(request["backup"]).exists())
        self.assertEqual(conflict.read_bytes(), b"local source")
        self.assertEqual(json.loads(Path(request["status"]).read_text(encoding="utf-8"))["code"], "LOCAL_CHANGES")

    def test_detached_helper_rechecks_after_backup_before_replacing(self):
        request = self.stage()

        def backup_then_add_local_file(*args):
            backup_current(*args)
            self.write_conflict()

        with mock.patch("workbench_update_helper.backup_current", side_effect=backup_then_add_local_file), \
             mock.patch("workbench_update_helper.start_workbench", return_value=mock.Mock(pid=88)), \
             mock.patch("workbench_update_helper.wait_for_health", return_value={"pid": 88}), \
             mock.patch("workbench_update_helper.replace_program") as replace:
            with self.assertRaises(ProgramPathConflict):
                run(request)
        replace.assert_not_called()
        self.assertEqual((self.root / "src" / "App.jsx").read_bytes(), b"local source")

    def stage(self):
        self.assertTrue(self.manager.apply("v9.9.9")["accepted"])
        return json.loads(Path(self.process_launcher.call_args.args[0][-1]).read_text(encoding="utf-8"))


class PortableUpdatePathCollisionTests(UpdateTestCase):
    def test_first_portable_upgrade_uses_bundled_file_list_for_ownership(self):
        (self.root / "release-files.json").write_text(
            json.dumps({"files": [{"path": "requirements.lock"}]}), encoding="utf-8")
        (self.root / "requirements.lock").write_text("# old lock", encoding="utf-8")
        conflict = self.root / "src" / "App.jsx"
        conflict.parent.mkdir()
        conflict.write_bytes(b"local source")
        self.manager._prepare_frontend = self.prepare
        with self.assertRaises(UpdateError) as rejected:
            self.manager.apply("v9.9.9")
        self.assertEqual(rejected.exception.code, "LOCAL_CHANGES")
        self.assertIn("src/App.jsx", str(rejected.exception))
        self.assertEqual(conflict.read_bytes(), b"local source")
        self.process_launcher.assert_not_called()
        conflict.unlink()
        self.assertTrue(self.manager.apply("v9.9.9")["accepted"])
