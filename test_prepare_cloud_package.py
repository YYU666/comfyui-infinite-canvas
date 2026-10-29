import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts import prepare_cloud_package


class PrepareCloudPackageTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.models = self.root / "models"
        self.models.mkdir()
        self.relative = Path("diffusion_models/model.safetensors")
        (self.models / self.relative).parent.mkdir()
        (self.models / self.relative).write_bytes(b"model")
        self.manifest = self.root / "manifest.json"
        self.manifest.write_text(json.dumps({
            "formatVersion": 1,
            "files": [{"path": self.relative.as_posix(), "bytes": 5, "sha256": prepare_cloud_package.file_sha256(self.models / self.relative)}],
            "profiles": {"full": {"include": "all"}},
        }), encoding="utf-8")
        self.inventory = self.root / "licenses.json"
        self.output = self.root / "output"
        self.license = self.root / "LICENSE.txt"
        self.license.write_text("license text", encoding="utf-8")

    def tearDown(self):
        self.temporary.cleanup()

    def write_inventory(self, redistribution):
        self.inventory.write_text(json.dumps({"files": [{
            "path": self.relative.as_posix(), "authors": "Author", "officialPage": "https://example.test/model",
            "license": "Test License", "licenseUrl": "https://example.test/license", "commercialUse": "allowed",
            "redistribution": redistribution, "restrictions": "Retain this license.", "sourceStatus": "test", "verifiedAt": "2026-10-29",
        }]}), encoding="utf-8")

    def run_tool(self, *extra):
        argv = ["prepare_cloud_package.py", "--model-root", str(self.models), "--output", str(self.output),
                "--mode", "copy", *extra]
        stdout = io.StringIO()
        with patch.object(sys, "argv", argv), patch.object(prepare_cloud_package, "MANIFEST", self.manifest), \
             patch.object(prepare_cloud_package, "LICENSES", self.inventory), contextlib.redirect_stdout(stdout):
            result = prepare_cloud_package.main()
        return result, stdout.getvalue()

    def test_local_mode_organizes_without_claiming_distribution_permission(self):
        self.write_inventory("unknown")
        result, output = self.run_tool()
        self.assertEqual(result, 0)
        self.assertEqual((self.output / self.relative).read_bytes(), b"model")
        self.assertIn("不代表获得公开上传或再分发权限", output)
        self.assertFalse((self.output / "licenses.json").exists())

    def test_public_mode_blocks_unknown_before_writing(self):
        self.write_inventory("unknown")
        result, output = self.run_tool("--purpose", "public", "--license-file", f"{self.relative.as_posix()}={self.license}")
        self.assertEqual(result, 2)
        self.assertIn("未写入任何文件", output)
        self.assertFalse(self.output.exists())

    def test_public_mode_requires_actual_license_text(self):
        self.write_inventory("conditional")
        result, output = self.run_tool("--purpose", "public")
        self.assertEqual(result, 2)
        self.assertIn("缺少实际许可文本", output)
        self.assertFalse(self.output.exists())

    def test_public_mode_copies_model_manifest_inventory_and_license(self):
        self.write_inventory("conditional")
        result, output = self.run_tool("--purpose", "public", "--license-file", f"{self.relative.as_posix()}={self.license}")
        self.assertEqual(result, 0, output)
        self.assertEqual((self.output / self.relative).read_bytes(), b"model")
        self.assertEqual((self.output / "licenses" / "01.txt").read_text(encoding="utf-8"), "license text")
        self.assertIn("Retain this license.", (self.output / "DISTRIBUTION_NOTICE.md").read_text(encoding="utf-8"))
        self.assertTrue((self.output / "manifest.json").is_file())
        self.assertTrue((self.output / "licenses.json").is_file())
        self.assertIn("上传前仍须人工复核", output)


if __name__ == "__main__":
    unittest.main()
