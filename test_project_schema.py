from __future__ import annotations

import copy
import json
import sys
import unittest
from pathlib import Path

from jsonschema import Draft202012Validator

sys.path.insert(0, str(Path(__file__).resolve().parent))

from scripts.validate_project import ROOT, load_schema, validate_project


class ProjectSchemaTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.document = json.loads((ROOT / "schema" / "project.min.json").read_text(encoding="utf-8"))
        Draft202012Validator.check_schema(load_schema())

    def assert_invalid(self, mutate):
        document = copy.deepcopy(self.document)
        mutate(document)
        self.assertTrue(validate_project(document))

    def test_minimum_example_is_valid(self):
        self.assertEqual(validate_project(self.document), [])

    def test_only_schema_v3_is_accepted(self):
        self.assert_invalid(lambda item: item.update(schemaVersion=2))

    def test_revision_starts_at_one(self):
        self.assert_invalid(lambda item: item.update(revision=0))

    def test_asset_path_rejects_parent_traversal(self):
        asset = {"path": "assets/../secret.png", "sha256": "0" * 64, "bytes": 1, "mime": "image/png"}
        self.assert_invalid(lambda item: item["assets"].append(asset))

    def test_asset_path_rejects_absolute_and_backslash_paths(self):
        for path in ("C:/secret.png", "assets\\secret.png"):
            with self.subTest(path=path):
                self.assert_invalid(lambda item: item.update(canvas={"nodes": [], "edges": [], "viewport": {"x": 0, "y": 0, "zoom": 1}}, assets=[{"path": path, "sha256": "0" * 64, "bytes": 1, "mime": "image/png"}]))

    def test_duplicate_entity_ids_are_rejected(self):
        character = {"id": "c1", "name": "角色", "refs": [], "sheet": None, "defaultOutfitId": None, "voice": None, "notes": ""}
        self.assert_invalid(lambda item: item.update(characters=[character, character]))

    def test_complete_prd_shapes_are_valid(self):
        asset = "assets/" + "a" * 64 + ".png"
        document = copy.deepcopy(self.document)
        document.update(
            characters=[{"id": "c1", "name": "角色", "refs": [asset], "sheet": asset, "defaultOutfitId": "o1", "voice": None, "notes": ""}],
            outfits=[{"id": "o1", "name": "服装", "refs": [asset], "prompt": "summer", "lora": None}],
            locations=[{"id": "l1", "name": "场景", "refs": [asset], "prompt": "studio", "notes": ""}],
            shots=[{"id": "s1", "number": "S01", "name": "镜头", "prompt": "test", "characterId": "c1", "outfitId": "o1", "locationId": "l1", "params": {"ratio": "16:9", "resolution": "480P", "duration": 5, "seed": 42, "turbo": False}, "takes": [{"id": "t1", "asset": asset, "poster": asset, "recipe": {"seed": 42}, "rating": 5, "selected": True, "createdAt": document["createdAt"]}], "status": "done", "tags": ["测试"]}],
            assets=[{"path": asset, "sha256": "a" * 64, "bytes": 12, "mime": "image/png"}],
        )
        self.assertEqual(validate_project(document), [])


if __name__ == "__main__":
    unittest.main()
