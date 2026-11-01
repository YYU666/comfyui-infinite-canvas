import copy
import io
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

from workflow_extensions import ExtensionError, ExtensionStore, convert_api_json, inspect_package, scalar


def workflow_fixture():
    return {"a": {"class_type": "LoadImage", "inputs": {"image": "a.png"}},
            "b": {"class_type": "LoadImage", "inputs": {"image": "b.png"}},
            "c": {"class_type": "LoadImage", "inputs": {"image": "c.png"}},
            "mix": {"class_type": "MixThree", "inputs": {"first": ["a", 0], "second": ["b", 0], "third": ["c", 0], "amount": 0.5, "enabled": True, "steps": 4, "model_name": "fixture.safetensors"}},
            "save": {"class_type": "SaveImage", "inputs": {"images": ["mix", 0], "filename_prefix": "../../unsafe"}}}


def info_fixture():
    return {"LoadImage": {"input": {"required": {"image": [["old.png"]]}}, "output": ["IMAGE", "MASK"]},
            "MixThree": {"input": {"required": {"first": ["IMAGE"], "second": ["IMAGE"], "third": ["IMAGE"], "amount": ["FLOAT", {"min": 0, "max": 1}], "enabled": ["BOOLEAN"], "steps": ["INT", {"min": 1, "max": 20}], "model_name": [["fixture.safetensors"]]}}, "output": ["IMAGE"]},
            "SaveImage": {"input": {"required": {"images": ["IMAGE"], "filename_prefix": ["STRING"]}}, "output": []}}


def rewrite_package(data, mutate):
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        files = {name: z.read(name) for name in z.namelist()}
    mutate(files)
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as z:
        for name, content in files.items():
            z.writestr(name, content)
    return out.getvalue()


class ExtensionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = ExtensionStore(Path(self.temp.name) / "runtime" / "extensions")
        self.raw = json.dumps(workflow_fixture()).encode()
        self.package = convert_api_json(self.raw, "three-images.json")
        self.imported = self.store.import_bytes(self.package)
        self.digest = self.imported["digest"]
        self.payload = {"nodeDefinitionId": "workflow", "inputs": {"image_a": "uploads/first.png", "image_b": "second.png", "image_c": "third.png"}, "parameters": {}}

    def test_three_images_and_immutable_conversion(self):
        prepared = self.store.prepare(self.digest, self.payload, info_fixture())
        self.assertEqual(prepared["workflow"]["a"]["inputs"]["image"], "uploads/first.png")
        self.assertEqual(prepared["workflow"]["b"]["inputs"]["image"], "second.png")
        self.assertEqual(prepared["workflow"]["c"]["inputs"]["image"], "third.png")
        self.assertTrue(prepared["workflow"]["save"]["inputs"]["filename_prefix"].startswith("H3/extensions/"))
        self.assertEqual(self.store.get(self.digest)["nodes"][0]["workflow"]["a"]["inputs"]["image"], "input.png")
        self.assertEqual(convert_api_json(self.raw, "three-images.json"), self.package)
        self.assertEqual(self.store.import_bytes(self.package)["digest"], self.digest)
        self.assertEqual(len(self.store.list()["items"]), 1)
        self.assertEqual(inspect_package(self.store.download(self.digest))["digest"], self.digest)

    def test_missing_dependency_model_range_and_required_input(self):
        for edit in (lambda info: info.pop("MixThree"), lambda info: info["MixThree"]["input"]["required"].update(model_name=[["other.safetensors"]]), lambda info: info["MixThree"]["input"]["required"].update(amount=["FLOAT", {"max": 0.1}]), lambda info: info["MixThree"]["input"]["required"].update(missing=["INT"])):
            info = info_fixture()
            edit(info)
            with self.assertRaises(ExtensionError):
                self.store.prepare(self.digest, self.payload, info)

    def test_strict_ports_parameters_and_types(self):
        cases = [{**self.payload, "inputs": {"image_a": "one.png"}}, {**self.payload, "parameters": {"unknown": 1}}, {**self.payload, "parameters": {"node_mix__steps": True}}, {**self.payload, "inputs": {**self.payload["inputs"], "image_a": "../bad.png"}}]
        for payload in cases:
            with self.assertRaises(ExtensionError):
                self.store.prepare(self.digest, payload, info_fixture())

    def test_bad_binding_and_unsupported_schema(self):
        def mutate(files, change):
            value = json.loads(files["nodes/workflow.json"])
            change(value)
            files["nodes/workflow.json"] = json.dumps(value).encode()
        changes = [lambda d: d["bindings"][0].update(input="missing"), lambda d: d["inputs"][0].update(list=True), lambda d: d["parameters"]["properties"]["node_mix__amount"].update(pattern=".*"), lambda d: d["bindings"].append(copy.deepcopy(d["bindings"][0]))]
        for change in changes:
            bad = rewrite_package(self.package, lambda files: mutate(files, change))
            with self.assertRaises(ExtensionError):
                self.store.import_bytes(bad)

    def test_zip_path_duplicates_symlinks_ratio_crc(self):
        for name in ("../escape.json", "C:/escape.json", "/absolute.json"):
            bad = rewrite_package(self.package, lambda files: files.update({name: b"{}"}))
            with self.assertRaises(ExtensionError):
                inspect_package(bad)
        bad = rewrite_package(self.package, lambda files: files.update({"a/bad.json": b"{}"})).replace(b"a/bad.json", b"a\\bad.json")
        with self.assertRaises(ExtensionError):
            inspect_package(bad)
        out = io.BytesIO()
        with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED) as z:
            z.writestr("bomb.json", b"a" * (2 * 1024 * 1024))
        with self.assertRaises(ExtensionError):
            inspect_package(out.getvalue())
        for mode in (0o120777, 0o020600):
            out = io.BytesIO()
            with zipfile.ZipFile(out, "w") as z:
                item = zipfile.ZipInfo("link.json")
                item.create_system = 3
                item.external_attr = mode << 16
                z.writestr(item, "target")
            with self.assertRaises(ExtensionError):
                inspect_package(out.getvalue())
        bad = rewrite_package(self.package, lambda files: files.update({"MANIFEST.json": b"{}"}))
        with self.assertRaises(ExtensionError):
            inspect_package(bad)
        raw = bytearray(rewrite_package(self.package, lambda files: None))
        raw[50] ^= 1
        with self.assertRaises(ExtensionError):
            inspect_package(bytes(raw))

    def test_reject_ui_json_and_unsafe_json(self):
        for raw in (b'{"nodes":[],"links":[]}', b'{"__proto__":{}}', b'{"x":1,"x":2}'):
            with self.assertRaises(ExtensionError):
                self.store.import_bytes(raw)

    def test_loadimage_cannot_be_a_parameter(self):
        def mutate(files):
            definition = json.loads(files["nodes/workflow.json"])
            definition["inputs"] = [p for p in definition["inputs"] if p["id"] != "image_a"]
            definition["parameters"]["properties"]["path"] = {"type": "string", "default": "C:/private/file.png"}
            definition["bindings"][0].update(sourceKind="parameter", sourceId="path")
            files["nodes/workflow.json"] = json.dumps(definition).encode()
        with self.assertRaises(ExtensionError):
            self.store.import_bytes(rewrite_package(self.package, mutate))

    def test_input_description_cannot_be_object(self):
        def mutate(files):
            definition = json.loads(files["nodes/workflow.json"])
            definition["inputs"][0]["description"] = {}
            files["nodes/workflow.json"] = json.dumps(definition).encode()
        with self.assertRaises(ExtensionError):
            inspect_package(rewrite_package(self.package, mutate))

    def test_unsafe_integer_precision_rejected(self):
        for number in (2 ** 53, -(2 ** 53), 10 ** 500):
            workflow = workflow_fixture()
            workflow["mix"]["inputs"]["steps"] = number
            with self.assertRaises(ExtensionError):
                convert_api_json(json.dumps(workflow).encode())
            payload = {**self.payload, "parameters": {"node_mix__steps": number}}
            with self.assertRaises(ExtensionError):
                self.store.prepare(self.digest, payload, info_fixture())
            def mutate(files):
                definition = json.loads(files["nodes/workflow.json"])
                definition["parameters"]["properties"]["node_mix__steps"]["default"] = number
                files["nodes/workflow.json"] = json.dumps(definition).encode()
            with self.assertRaises(ExtensionError):
                inspect_package(rewrite_package(self.package, mutate))

    def test_number_enum_accepts_equivalent_json_number(self):
        scalar(1, {"type": "number", "enum": [1.0]}, "amount")
        scalar(1.0, {"type": "number", "enum": [1]}, "amount")
        with self.assertRaises(ExtensionError):
            scalar(True, {"type": "integer", "enum": [1]}, "steps")

    def test_workbench_version_constraints(self):
        def changed(value):
            def mutate(files):
                manifest = json.loads(files["manifest.json"])
                manifest["compatibility"]["workbenchVersion"] = value
                files["manifest.json"] = json.dumps(manifest).encode()
            return rewrite_package(self.package, mutate)
        inspect_package(changed(">=1.0.1 <2"))
        for value in (">=2", "^1.0", "invalid"):
            with self.assertRaises(ExtensionError):
                inspect_package(changed(value))

    def test_store_refuses_reparse_points(self):
        from unittest.mock import patch
        from types import SimpleNamespace
        with patch.object(Path, "lstat", return_value=SimpleNamespace(st_mode=0o100644, st_file_attributes=0x400)):
            with self.assertRaises(ExtensionError):
                self.store.download(self.digest)

    def test_versions_survive_new_store_and_program_replacement(self):
        changed = workflow_fixture()
        changed["mix"]["inputs"]["steps"] = 8
        second = self.store.import_bytes(json.dumps(changed).encode())
        recreated = ExtensionStore(self.store.root)
        self.assertEqual(len(recreated.list()["items"]), 2)
        self.assertNotEqual(second["digest"], self.digest)
        self.assertEqual(recreated.download(self.digest), self.package)

    def test_concurrent_imports_publish_one_complete_digest(self):
        from concurrent.futures import ThreadPoolExecutor
        root = Path(self.temp.name) / "parallel"
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda _: ExtensionStore(root).import_bytes(self.package), range(8)))
        self.assertEqual({result["digest"] for result in results}, {self.digest})
        self.assertEqual(len(list(root.iterdir())), 1)
        self.assertEqual(ExtensionStore(root).download(self.digest), self.package)

    def test_known_seed_contract(self):
        # A tiny synthetic copy of the public image-resize contract, never personal assets.
        def resize(files):
            definition = {"nodeDefinitionSchemaVersion": "0.1", "nodeDefinitionId": "workflow", "name": "Resize", "inputs": [{"id": "image", "type": "image", "required": True, "list": False}], "parameters": {"type": "object", "additionalProperties": False, "required": ["width"], "properties": {"width": {"type": "integer", "minimum": 64, "maximum": 8192, "default": 1024}}}, "bindings": [{"sourceKind": "input", "sourceId": "image", "nodeId": "load", "input": "image"}, {"sourceKind": "parameter", "sourceId": "width", "nodeId": "scale", "input": "width"}], "outputs": [{"id": "image", "type": "image", "nodeId": "save"}]}
            workflow = {"load": {"class_type": "LoadImage", "inputs": {"image": "example.png"}}, "scale": {"class_type": "ImageScale", "inputs": {"image": ["load", 0], "width": 1024}}, "save": {"class_type": "SaveImage", "inputs": {"images": ["scale", 0], "filename_prefix": "H3/image-resize"}}}
            files["nodes/workflow.json"] = json.dumps(definition).encode()
            files["workflows/workflow.json"] = json.dumps(workflow).encode()
        result = inspect_package(rewrite_package(self.package, resize))
        self.assertEqual(result["nodes"][0]["definition"]["parameters"]["properties"]["width"]["default"], 1024)


if __name__ == "__main__":
    unittest.main()
