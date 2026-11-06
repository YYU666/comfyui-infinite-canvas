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

    def test_atomic_replace_retries_transient_windows_errors_without_rewriting(self):
        path = instance_path()
        temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
        original_replace = os.replace
        original_fsync = os.fsync
        for winerror, error_type in ((5, PermissionError), (32, PermissionError), (33, PermissionError),
                                    (5, OSError), (32, OSError), (33, OSError)):
            with self.subTest(winerror=winerror, error_type=error_type):
                path.write_text(json.dumps({"state": "old"}), encoding="utf-8")
                error = error_type("transient replacement denial")
                error.winerror = winerror
                attempts = []

                def replace(source, destination):
                    attempts.append((source, destination))
                    self.assertEqual(json.loads(path.read_text(encoding="utf-8")), {"state": "old"})
                    self.assertEqual(json.loads(temporary.read_text(encoding="utf-8")), {"state": "new"})
                    if len(attempts) < 3:
                        raise error
                    original_replace(source, destination)

                def restrict(destination):
                    self.assertEqual(len(attempts), 3)
                    self.assertEqual(json.loads(destination.read_text(encoding="utf-8")), {"state": "new"})

                with patch("workbench_lifecycle.os.name", "nt"), \
                     patch("workbench_lifecycle.instance_path", return_value=path), \
                     patch("workbench_lifecycle.os.replace", side_effect=replace) as replacement, \
                     patch("workbench_lifecycle.os.fsync", wraps=original_fsync) as fsync, \
                     patch("workbench_lifecycle.time.sleep") as sleep, \
                     patch("workbench_lifecycle.restrict_private_file", side_effect=restrict) as permissions:
                    atomic_write_json(path, {"state": "new"})
                self.assertEqual(replacement.call_count, 3)
                self.assertEqual(attempts, [(temporary, path)] * 3)
                self.assertEqual(sleep.call_args_list, [unittest.mock.call(0.01)] * 2)
                fsync.assert_called_once()
                permissions.assert_called_once_with(path)
                self.assertFalse(temporary.exists())

    def test_atomic_replace_exhaustion_keeps_old_destination_and_surfaces_error(self):
        path = instance_path()
        temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
        path.write_text(json.dumps({"state": "old"}), encoding="utf-8")
        error = PermissionError(13, "persistent replacement denial")
        error.winerror = 5
        with patch("workbench_lifecycle.os.name", "nt"), \
             patch("workbench_lifecycle.instance_path", return_value=path), \
             patch("workbench_lifecycle.os.replace", side_effect=error) as replacement, \
             patch("workbench_lifecycle.time.sleep") as sleep, \
             patch("workbench_lifecycle.restrict_private_file") as permissions:
            with self.assertRaises(PermissionError) as failure:
                atomic_write_json(path, {"state": "new"})
        self.assertIs(failure.exception, error)
        self.assertEqual(replacement.call_count, 50)
        self.assertTrue(all(call.args == (temporary, path) for call in replacement.call_args_list))
        self.assertEqual(sleep.call_args_list, [unittest.mock.call(0.01)] * 49)
        self.assertEqual(json.loads(path.read_text(encoding="utf-8")), {"state": "old"})
        self.assertEqual(json.loads(temporary.read_text(encoding="utf-8")), {"state": "new"})
        permissions.assert_not_called()

    def test_atomic_replace_does_not_retry_other_permission_or_os_errors(self):
        path = instance_path()
        for platform, winerror, error_type in (("nt", None, PermissionError), ("nt", 87, PermissionError),
                                               ("posix", 5, PermissionError), ("posix", 32, PermissionError),
                                               ("nt", 87, OSError), ("nt", None, OSError)):
            with self.subTest(platform=platform, winerror=winerror, error_type=error_type):
                path.write_text(json.dumps({"state": "old"}), encoding="utf-8")
                error = error_type("unrelated replacement error")
                if winerror is not None:
                    error.winerror = winerror
                with patch("workbench_lifecycle.os.name", platform), \
                     patch("workbench_lifecycle.instance_path", return_value=path), \
                     patch("workbench_lifecycle.os.replace", side_effect=error) as replacement, \
                     patch("workbench_lifecycle.time.sleep") as sleep, \
                     patch("workbench_lifecycle.restrict_private_file") as permissions:
                    with self.assertRaises(error_type) as failure:
                        atomic_write_json(path, {"state": "new"})
                self.assertIs(failure.exception, error)
                replacement.assert_called_once()
                sleep.assert_not_called()
                permissions.assert_not_called()
                self.assertEqual(json.loads(path.read_text(encoding="utf-8")), {"state": "old"})

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
