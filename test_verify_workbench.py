from __future__ import annotations

import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from scripts.verify_workbench import ROOT, select_model_files, verify_model_files


class ModelManifestTests(unittest.TestCase):
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
