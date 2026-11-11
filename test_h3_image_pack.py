import io
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

from extension_dependencies import canonical_sources, dependency_report
from scripts.build_h3_image_pack import MODELS, build_pack
from workflow_extensions import ExtensionStore, inspect_package


class H3ImagePackTests(unittest.TestCase):
    def test_deterministic_private_data_free_pack(self):
        data = build_pack()
        self.assertEqual(data, build_pack())
        bundle = inspect_package(data)
        self.assertEqual(len(bundle["nodes"]), 5)
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            self.assertEqual(len(z.namelist()), 13)
            for name in z.namelist():
                self.assertTrue(name.endswith((".json", ".md")) or name == "LICENSE")
                text = z.read(name).decode("utf-8")
                for private in ("C:/Users/", "D:/H3", "api_key", "Bearer ", "data:image"):
                    self.assertNotIn(private, text)

    def test_bindings_with_real_native_schema(self):
        schema_file = Path(__file__).parent / "fixtures/h3-image-object-info.json"
        info = json.loads(schema_file.read_text(encoding="utf-8"))["nodes"]
        data = build_pack()
        bundle = inspect_package(data)
        with tempfile.TemporaryDirectory() as directory:
            store = ExtensionStore(Path(directory))
            store.import_bytes(data)
            for count, node in enumerate(bundle["nodes"]):
                definition = node["definition"]
                values = {p["id"]: f'uploads/{p["id"]}.png' for p in definition["inputs"]}
                payload = {"nodeDefinitionId": definition["nodeDefinitionId"], "inputs": values, "parameters": {"prompt": "Edit <Picture 1>.", "seed": 0}}
                result = store.prepare(bundle["digest"], payload, info)
                self.assertEqual(result["workflow"]["sample"]["inputs"]["seed"], 0)
                for number in range(1, count + 1):
                    self.assertEqual(result["workflow"]["positive"]["inputs"][f"images.image_{number}"], [f"image_{number}", 0])
                    self.assertEqual(result["workflow"][f"image_{number}"]["inputs"]["image"], values[f"image_{number}"])
                self.assertTrue(dependency_report(bundle, {"nodeDefinitionId": definition["nodeDefinitionId"], "parameters": {}}, info)["ready"])

    def test_pinned_model_sources_use_image_license(self):
        sources = canonical_sources()
        for category, key in (("diffusion_models", "unet"), ("vae", "vae")):
            source = sources[f"{category}/{MODELS[key]}"]
            self.assertIn("/892de7cb61df49753bf15145a711154803a355cb/", source["url"])
            self.assertEqual(source["verification"], "sha256")
            self.assertEqual(len(source["sha256"]), 64)
            self.assertIn("H3-Image", source["license"])


if __name__ == "__main__":
    unittest.main()
