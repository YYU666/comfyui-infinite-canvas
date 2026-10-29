import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

from scripts import install_models


class InstallModelsSafetyTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.source = self.root / "source"
        self.comfy = self.root / "comfy"
        self.relative = Path("diffusion_models/model.safetensors")
        (self.source / self.relative).parent.mkdir(parents=True)
        (self.source / self.relative).write_bytes(b"new-model")
        self.manifest = self.root / "manifest.json"
        self.manifest.write_text(json.dumps({"files": [{"path": self.relative.as_posix(), "bytes": 9}]}), encoding="utf-8")

    def tearDown(self):
        self.temporary.cleanup()

    def run_install(self, *extra):
        argv = ["install_models.py", str(self.source), "--comfy-root", str(self.comfy), *extra]
        with patch.object(sys, "argv", argv), patch.object(install_models, "MANIFEST", self.manifest), contextlib.redirect_stdout(io.StringIO()):
            return install_models.main()

    def target(self):
        return self.comfy / "ComfyUI" / "models" / self.relative

    def test_existing_different_file_is_a_conflict_and_is_preserved(self):
        target = self.target()
        target.parent.mkdir(parents=True)
        target.write_bytes(b"old")
        self.assertEqual(self.run_install(), 1)
        self.assertEqual(target.read_bytes(), b"old")
        self.assertEqual(self.run_install("--link"), 1)
        self.assertEqual(target.read_bytes(), b"old")

    def test_copy_success_uses_new_target(self):
        self.assertEqual(self.run_install(), 0)
        self.assertEqual(self.target().read_bytes(), b"new-model")

    def test_publish_failure_never_overwrites_concurrent_target(self):
        original_link = os.link
        def racing_link(source, target):
            target_path = Path(target)
            expected = self.target()
            # GitHub Windows runners may return an 8.3 short path for one side.
            if target_path.name == expected.name and os.path.samefile(target_path.parent, expected.parent):
                target_path.write_bytes(b"other")
                raise FileExistsError("target appeared")
            return original_link(source, target)
        with patch.object(install_models.os, "link", side_effect=racing_link):
            with self.assertRaises(FileExistsError):
                self.run_install()
        self.assertEqual(self.target().read_bytes(), b"other")
        self.assertEqual(list(self.target().parent.glob("*.tmp")), [])

    def test_link_failure_does_not_create_or_delete_target(self):
        with patch.object(install_models.os, "link", side_effect=OSError("cross-device")):
            with self.assertRaises(OSError):
                self.run_install("--link")
        self.assertFalse(self.target().exists())

    def test_same_size_hash_mismatch_is_not_copied(self):
        expected = self.root / "expected"
        expected.write_bytes(b"expected!")
        self.manifest.write_text(json.dumps({"files": [{
            "path": self.relative.as_posix(), "bytes": 9, "sha256": install_models.file_sha256(expected),
        }]}), encoding="utf-8")
        self.assertEqual(self.run_install(), 1)
        self.assertFalse(self.target().exists())

    def test_core_profile_does_not_require_full_only_files(self):
        self.manifest.write_text(json.dumps({
            "files": [
                {"path": self.relative.as_posix(), "bytes": 9},
                {"path": "vae/optional.safetensors", "bytes": 100},
            ],
            "profiles": {"core-h3": {"files": [self.relative.as_posix()]}, "full": {"include": "all"}},
        }), encoding="utf-8")
        self.assertEqual(self.run_install("--profile", "core-h3"), 0)
        self.assertEqual(self.target().read_bytes(), b"new-model")


if __name__ == "__main__":
    unittest.main()
