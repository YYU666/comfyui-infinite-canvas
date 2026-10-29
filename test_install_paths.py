from __future__ import annotations

import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

from video_workbench_launcher import choose_data_dir, resolve_data_dir
from workbench_settings import WorkbenchSettings

ROOT = Path(__file__).resolve().parent


class InstallPathTests(unittest.TestCase):
    def test_launch_scripts_have_no_machine_python_fallback(self):
        for name in ("启动.bat", "启动.vbs", "start.bat", "停止.bat", "h3wb.bat"):
            with self.subTest(name=name):
                content = (ROOT / name).read_text(encoding="utf-8")
                self.assertNotIn("C:\\ComfyUI_windows_portable", content)
                self.assertIn("H3_COMFY_ROOT", content)
        for name in ("启动.bat", "start.bat", "停止.bat", "h3wb.bat"):
            self.assertIn('if defined H3_COMFY_ROOT set "PYTHON=%H3_COMFY_ROOT%\\python_embeded\\python.exe"',
                          (ROOT / name).read_text(encoding="utf-8"))

    def test_existing_data_root_is_never_migrated(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            legacy = root / "legacy"
            legacy.mkdir()
            larger = root / "larger"
            larger.mkdir()
            with mock.patch("video_workbench_launcher.shutil.disk_usage", return_value=shutil._ntuple_diskusage(100, 1, 99)):
                self.assertEqual(choose_data_dir([larger], legacy=legacy), legacy)

    def test_first_run_uses_candidate_with_most_free_space(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            small, large = root / "small", root / "large"
            small.mkdir()
            large.mkdir()
            usage = {str(small): shutil._ntuple_diskusage(100, 80, 20), str(large): shutil._ntuple_diskusage(100, 10, 90)}
            with mock.patch("video_workbench_launcher.shutil.disk_usage", side_effect=lambda path: usage[str(path)]):
                self.assertEqual(choose_data_dir([small, large]), large / "H3_Workbench")

    def test_selected_data_root_survives_free_space_changes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            first_disk, second_disk = root / "first", root / "second"
            first_disk.mkdir()
            second_disk.mkdir()
            state = root / "runtime" / "data-directory.json"
            usage = {str(first_disk): shutil._ntuple_diskusage(200, 1, 199), str(second_disk): shutil._ntuple_diskusage(200, 50, 150)}
            with mock.patch("video_workbench_launcher.shutil.disk_usage", side_effect=lambda path: usage[str(path)]):
                selected = resolve_data_dir([first_disk, second_disk], state_path=state)
            self.assertEqual(selected.name, "H3_Workbench")
            self.assertTrue(os.path.samefile(selected.parent, first_disk))
            self.assertTrue(state.is_file())
            usage[str(first_disk)] = shutil._ntuple_diskusage(200, 150, 50)
            with mock.patch("video_workbench_launcher.shutil.disk_usage", side_effect=lambda path: usage[str(path)]):
                restarted = resolve_data_dir([first_disk, second_disk], state_path=state)
            self.assertEqual(restarted, selected)
            self.assertTrue((selected / "references").parent.is_dir())

    def test_invalid_saved_data_root_does_not_silently_select_another_disk(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            state = root / "data-directory.json"
            state.write_text("{}", encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "未重新选盘"):
                resolve_data_dir([root], state_path=state)

    def test_settings_default_comfy_root_is_repository_relative(self):
        settings = WorkbenchSettings(ROOT / "nonexistent-test-config.json")
        self.assertEqual(settings.defaults["comfyRoot"], str(ROOT.parent.resolve()))
        self.assertNotIn("C:\\ComfyUI_windows_portable", settings.defaults["comfyRoot"])


if __name__ == "__main__":
    unittest.main()
