from __future__ import annotations

import hashlib
import contextlib
import io
import json
import sys
import tempfile
import unittest
from unittest import mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from scripts.verify_workbench import ROOT, select_model_files, verify_model_files
from scripts import verify_workbench


class ModelManifestTests(unittest.TestCase):
    def test_cli_defaults_to_core_and_full_remains_explicit(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "dist").mkdir()
            (root / "dist" / "index.html").write_text("fixture", encoding="utf-8")
            models = root / "ComfyUI" / "models"
            models.mkdir(parents=True)
            (models / "core.bin").write_bytes(b"core")
            manifest = root / "manifest.json"
            manifest.write_text(json.dumps({"profiles": {"core-h3": {"files": ["core.bin"]}, "full": {"include": "all"}},
                "files": [{"path": "core.bin", "bytes": 4, "sha256": hashlib.sha256(b"core").hexdigest()},
                          {"path": "optional.bin", "bytes": 1}]}), encoding="utf-8")
            for extra, code, label in (([], 0, "core-h3"), (["--profile", "full"], 1, "full")):
                output = io.StringIO()
                with self.subTest(profile=label), mock.patch.object(verify_workbench, "ROOT", root), \
                     mock.patch.object(verify_workbench, "NODE_DIRS", ()), \
                     mock.patch.object(sys, "argv", ["verify_workbench.py", "--comfy-root", str(root), "--manifest", str(manifest), *extra]), \
                     contextlib.redirect_stdout(output):
                    self.assertEqual(verify_workbench.main(), code)
                self.assertIn(f"模型配置：{label}", output.getvalue())
                if code == 0:
                    self.assertIn("已登记并核实 1 个", output.getvalue())
                    self.assertNotIn("optional.bin", output.getvalue())
                else:
                    self.assertIn("optional.bin", output.getvalue())

    def test_real_manifest_has_core_and_complete_profiles(self):
        manifest = json.loads((ROOT / "models" / "manifest.json").read_text(encoding="utf-8"))
        core = select_model_files(manifest, "core-h3")
        full = select_model_files(manifest, "full")
        self.assertEqual(len(core), 7)
        self.assertEqual(len(full), 33)
        self.assertEqual(sum(item["bytes"] for item in core), 76410807376)
        self.assertTrue(all(item.get("sha256") for item in core), "核心七项必须全部具有官方 SHA256")
        self.assertEqual(sum("sha256" in item for item in full), 15)
        self.assertTrue({item["path"] for item in core}.issubset({item["path"] for item in full}))

    def test_unknown_profile_and_unknown_profile_file_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "未知模型配置"):
            select_model_files({"files": [], "profiles": {}}, "missing")
        manifest = {"files": [], "profiles": {"core-h3": {"files": ["vae/missing.safetensors"]}}}
        with self.assertRaisesRegex(ValueError, "不存在的文件"):
            select_model_files(manifest, "core-h3")

    def test_size_only_file_is_explicitly_pending_hash(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path = root / "vae" / "core.safetensors"
            path.parent.mkdir()
            path.write_bytes(b"known-fixture")
            item = {"path": "vae/core.safetensors", "bytes": 13}
            problems, verified, pending = verify_model_files([item], [root])
            self.assertEqual(problems, [])
            self.assertEqual(verified, 0)
            self.assertEqual(pending, [item["path"]])

    def test_sha256_accepts_exact_content(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path = root / "model.safetensors"
            payload = b"exact-model-fixture"
            path.write_bytes(payload)
            item = {"path": "model.safetensors", "bytes": len(payload), "sha256": hashlib.sha256(payload).hexdigest()}
            problems, verified, pending = verify_model_files([item], [root])
            self.assertEqual((problems, verified, pending), ([], 1, []))

    def test_same_size_corruption_is_rejected_by_sha256(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path = root / "model.safetensors"
            path.write_bytes(b"damaged")
            item = {"path": "model.safetensors", "bytes": 7, "sha256": hashlib.sha256(b"correct").hexdigest()}
            problems, verified, pending = verify_model_files([item], [root])
            self.assertEqual(problems, ["模型 SHA256 不符：model.safetensors"])
            self.assertEqual((verified, pending), (0, []))


if __name__ == "__main__":
    unittest.main()
