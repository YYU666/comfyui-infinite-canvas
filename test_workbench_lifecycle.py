from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

from workbench_lifecycle import atomic_write_json, instance_path, port_is_free, read_instance, remove_instance, restrict_private_file, runtime_dir


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.environment = patch.dict(os.environ, {"H3_WORKBENCH_RUNTIME_DIR": self.temporary.name})
        self.environment.start()

    def tearDown(self):
        self.environment.stop()
        self.temporary.cleanup()

    def test_runtime_uses_isolated_directory(self):
        self.assertEqual(runtime_dir(), Path(self.temporary.name))

    def test_instance_round_trip_and_atomic_replace(self):
        path = instance_path()
        atomic_write_json(path, {"pid": 123, "port": 8790, "token": "secret"})
        atomic_write_json(path, {"pid": 123, "port": 8791, "token": "secret"})
        self.assertEqual(read_instance()["port"], 8791)
        self.assertEqual(list(path.parent.glob("*.tmp")), [])

    def test_instance_permissions_are_restricted_after_every_replace(self):
        with patch("workbench_lifecycle.restrict_private_file") as restrict:
            atomic_write_json(instance_path(), {"pid": 123, "token": "secret"})
            atomic_write_json(instance_path(), {"pid": 123, "token": "updated"})
        self.assertEqual(restrict.call_count, 2)
        restrict.assert_called_with(instance_path())

    def test_icacls_output_uses_windows_code_page_under_python_utf8(self):
        with patch("workbench_lifecycle.os.name", "nt"), \
             patch.dict(os.environ, {"USERDOMAIN": "TEST", "USERNAME": "user"}), \
             patch("subprocess.run") as run:
            run.return_value.returncode = 0
            restrict_private_file(Path("instance.json"))
        self.assertEqual(run.call_args.kwargs["encoding"], "mbcs")
        self.assertEqual(run.call_args.kwargs["errors"], "replace")

    def test_invalid_instance_is_ignored(self):
        instance_path().write_text("not json", encoding="utf-8")
        self.assertIsNone(read_instance())

    def test_remove_only_own_instance(self):
        atomic_write_json(instance_path(), {"pid": 123})
        remove_instance(456)
        self.assertIsNotNone(read_instance())
        remove_instance(123)
        self.assertFalse(instance_path().exists())

    def test_port_probe(self):
        self.assertTrue(port_is_free(8799))


if __name__ == "__main__":
    unittest.main()
