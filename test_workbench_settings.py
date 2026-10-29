from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

from workbench_settings import SettingsError, WorkbenchSettings, _restrict_key_file, deepseek_status, read_deepseek_key, save_deepseek_key


class SettingsTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.comfy = self.root / "portable"
        (self.comfy / "ComfyUI").mkdir(parents=True)
        (self.comfy / "ComfyUI" / "main.py").write_text("# test", encoding="utf-8")
        self.path = self.root / "runtime" / "config.json"
        self.settings = WorkbenchSettings(self.path, comfy_root=self.comfy, projects_root=self.root / "projects")

    def tearDown(self):
        self.temporary.cleanup()

    def valid_update(self, **overrides):
        payload = {
            "projectsRoot": str(self.root / "new-projects"),
            "comfyRoot": str(self.comfy),
            "modelRoots": [str(self.root / "models-a"), str(self.root / "models-b")],
            "queue": {"concurrency": 2},
            "defaults": {"ratio": "9:16", "resolution": "720P", "duration": 8},
            "notifications": False,
            "logLevel": "WARNING",
        }
        payload.update(overrides)
        return payload

    def test_round_trip_persists_all_public_settings(self):
        result = self.settings.update(self.valid_update())
        self.assertEqual(result["queue"]["concurrency"], 2)
        self.assertEqual(result["defaults"], {"ratio": "9:16", "resolution": "720P", "duration": 8})
        self.assertFalse(result["notifications"])
        loaded = WorkbenchSettings(self.path).load()
        self.assertEqual(loaded["modelRoots"], [str(self.root / "models-a"), str(self.root / "models-b")])
        self.assertEqual(loaded["logLevel"], "WARNING")
        self.assertNotIn("deepseekKey", json.loads(self.path.read_text(encoding="utf-8")))

    def test_invalid_values_and_missing_comfy_are_rejected_without_overwrite(self):
        original = self.settings.public()
        for update in (
            {"projectsRoot": "relative/path"}, {"queue": {"concurrency": 3}},
            {"defaults": {"duration": 3}}, {"defaults": {"ratio": "2:1"}},
            {"notifications": "yes"}, {"logLevel": "TRACE"}, {"modelRoots": "D:/models"},
        ):
            with self.subTest(update=update), self.assertRaises(SettingsError):
                self.settings.update(update)
        with self.assertRaises(SettingsError):
            self.settings.update({"comfyRoot": str(self.root / "missing")})
        self.assertFalse(self.path.exists())
        self.assertEqual(self.settings.public()["projectsRoot"], original["projectsRoot"])

    def test_before_save_can_block_project_root_change(self):
        def blocked(candidate):
            raise SettingsError("项目已锁定。", status=409, code="LOCKED")
        with self.assertRaises(SettingsError) as caught:
            self.settings.update(self.valid_update(), before_save=blocked)
        self.assertEqual(caught.exception.status, 409)
        self.assertFalse(self.path.exists())

    def test_file_key_fallback_never_enters_config_or_public_json(self):
        secret = "sk-settings-test-secret"
        home = self.root / "home"
        with mock.patch.dict(os.environ, {"DEEPSEEK_API_KEY": ""}), mock.patch("pathlib.Path.home", return_value=home), \
             mock.patch("workbench_settings._optional_keyring", return_value=None), mock.patch("workbench_settings._restrict_key_file") as restrict:
            status = save_deepseek_key(secret)
            self.assertTrue(status["configured"])
            self.assertEqual(status["source"], "file")
            restrict.assert_called_once()
            self.assertEqual(read_deepseek_key()[0], secret)
            result = self.settings.update({"deepseekKey": secret})
            serialized = json.dumps(result)
            self.assertNotIn(secret, serialized)
            self.assertNotIn(secret, self.path.read_text(encoding="utf-8"))
            self.assertNotIn("deepseekKey", result)

    def test_environment_key_has_priority_and_is_not_returned(self):
        with mock.patch.dict(os.environ, {"DEEPSEEK_API_KEY": "sk-environment-secret"}):
            status = deepseek_status()
            self.assertEqual(status["source"], "environment")
            self.assertNotIn("sk-environment-secret", json.dumps(status))

    def test_icacls_output_uses_windows_code_page_under_python_utf8(self):
        with mock.patch("workbench_settings.os.name", "nt"), \
             mock.patch.dict(os.environ, {"USERDOMAIN": "TEST", "USERNAME": "user"}), \
             mock.patch("workbench_settings.subprocess.run") as run:
            run.return_value.returncode = 0
            _restrict_key_file(Path("deepseek.key"))
        self.assertEqual(run.call_args.kwargs["encoding"], "mbcs")
        self.assertEqual(run.call_args.kwargs["errors"], "replace")


if __name__ == "__main__":
    unittest.main()
