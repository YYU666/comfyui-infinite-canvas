from __future__ import annotations

import json
import re
import unittest
from pathlib import Path

from install import NODE_PACKAGES

ROOT = Path(__file__).resolve().parent
STATUSES = {"allowed", "conditional", "non-commercial", "unknown"}
REQUIRED_MODEL_FIELDS = (
    "path",
    "authors",
    "officialPage",
    "license",
    "licenseUrl",
    "commercialUse",
    "redistribution",
    "restrictions",
    "sourceStatus",
    "verifiedAt",
)


class LicenseInventoryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.manifest = json.loads((ROOT / "models" / "manifest.json").read_text(encoding="utf-8"))
        cls.inventory = json.loads((ROOT / "models" / "licenses.json").read_text(encoding="utf-8"))
        cls.entries = cls.inventory["files"]
        cls.by_path = {entry["path"]: entry for entry in cls.entries}

    def test_model_inventory_exactly_matches_manifest(self):
        manifest_paths = [item["path"] for item in self.manifest["files"]]
        inventory_paths = [item["path"] for item in self.entries]
        self.assertEqual(len(inventory_paths), len(set(inventory_paths)), "授权矩阵存在重复 path")
        self.assertEqual(set(inventory_paths), set(manifest_paths))
        self.assertEqual(len(inventory_paths), self.manifest["fileCount"])

    def test_every_model_has_complete_license_and_review_metadata(self):
        for entry in self.entries:
            with self.subTest(path=entry["path"]):
                for field in REQUIRED_MODEL_FIELDS:
                    self.assertIsInstance(entry.get(field), str, f"缺少字符串字段 {field}")
                    self.assertTrue(entry[field].strip(), f"字段 {field} 不能为空")
                self.assertRegex(entry["officialPage"], r"^https://")
                self.assertRegex(entry["licenseUrl"], r"^https://")
                self.assertIn(entry["commercialUse"], STATUSES)
                self.assertIn(entry["redistribution"], STATUSES)
                self.assertRegex(entry["verifiedAt"], r"^\d{4}-\d{2}-\d{2}$")

    def test_unknown_never_implies_commercial_or_redistribution_permission(self):
        for entry in self.entries:
            if entry["commercialUse"] == "unknown" or entry["redistribution"] == "unknown":
                with self.subTest(path=entry["path"]):
                    self.assertEqual(entry["commercialUse"], "unknown")
                    self.assertEqual(entry["redistribution"], "unknown")
                    self.assertTrue(
                        "unknown" in entry["license"] or "待" in entry["license"],
                        "未知权限必须在许可证字段中显式标出",
                    )

    def test_high_risk_license_decisions_cannot_silently_relax(self):
        qwen = self.by_path["diffusion_models/qwen_image_2.1_int8_convrot.safetensors"]
        identity = self.by_path["loras/krea2_identity_edit_v2.safetensors"]
        self.assertEqual(qwen["commercialUse"], "non-commercial")
        self.assertIn("Research", qwen["license"])
        self.assertEqual(identity["commercialUse"], "non-commercial")
        for entry in self.entries:
            if "minimax_h3" in entry["path"] or entry["path"].endswith("h3_character_swap_v1.5.safetensors"):
                with self.subTest(path=entry["path"]):
                    self.assertIn("H3", entry["license"])
                    self.assertEqual(entry["commercialUse"], "conditional")

    def test_locked_node_inventory_matches_installer(self):
        document = json.loads((ROOT / "third_party" / "nodes.json").read_text(encoding="utf-8"))
        nodes = document["nodes"]
        self.assertEqual(len(nodes), len(NODE_PACKAGES))
        actual = {item["directory"]: (item["repository"], item["commit"]) for item in nodes}
        self.assertEqual(actual, NODE_PACKAGES)
        for item in nodes:
            with self.subTest(node=item["directory"]):
                self.assertRegex(item["commit"], re.compile(r"^[0-9a-f]{40}$"))
                self.assertIn(item["license"], {"GPL-3.0", "Apache-2.0", "MIT"})
                self.assertIn(item["commit"], item["licenseUrl"])

    def test_repository_license_is_explicit(self):
        package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
        license_text = (ROOT / "LICENSE").read_text(encoding="utf-8")
        notice = (ROOT / "NOTICE").read_text(encoding="utf-8")
        self.assertEqual(package["license"], "Apache-2.0")
        self.assertNotIn("private", package)
        self.assertIn("Apache License", license_text)
        self.assertIn("Version 2.0", license_text)
        self.assertIn("does not relicense", notice)

    def test_gpl_linked_plugin_has_separate_license_and_notice(self):
        plugin = ROOT / "comfy-nodes" / "h3_workbench_refine"
        license_text = (plugin / "LICENSE").read_text(encoding="utf-8")
        notice = (plugin / "NOTICE").read_text(encoding="utf-8")
        root_notice = (ROOT / "NOTICE").read_text(encoding="utf-8")
        source = (plugin / "__init__.py").read_text(encoding="utf-8")
        self.assertIn("GNU GENERAL PUBLIC LICENSE", license_text)
        self.assertIn("Version 3, 29 June 2007", license_text)
        self.assertIn("GPL-3.0-only", notice)
        self.assertIn("H3 Relay", notice)
        self.assertIn("custom_nodes.h3-relay.h3_relay.toolkit", source)
        self.assertIn("comfy-nodes/h3_workbench_refine", root_notice)
        self.assertIn("GPL-3.0-only", root_notice)


if __name__ == "__main__":
    unittest.main()
