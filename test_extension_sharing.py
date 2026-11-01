import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

from extension_sharing import share_extension
from workflow_extensions import ExtensionError, ExtensionStore


class SharingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = ExtensionStore(Path(self.temp.name) / "extensions")
        self.workflow = {
            "load": {"class_type": "LoadImage", "inputs": {"image": "private-person.png"}, "_meta": {"title": "secret-title"}},
            "text": {"class_type": "CLIPTextEncode", "inputs": {"text": "private prompt"}},
            "model": {"class_type": "UNETLoader", "inputs": {"unet_name": "model.safetensors", "weight_dtype": "default"}},
            "save": {"class_type": "SaveImage", "inputs": {"images": ["load", 0], "filename_prefix": "C:/private/results"}},
        }
        self.payload = {"workflow": self.workflow, "name": "共享节点", "packageId": "artist/test", "version": "1.0.0", "description": "公开说明"}
        self.info = {
            "LoadImage": {"input": {"required": {"image": [["private-person.png"]]}}},
            "CLIPTextEncode": {"input": {"required": {"text": ["STRING"]}}},
            "UNETLoader": {"input": {"required": {"unet_name": [["model.safetensors"]], "weight_dtype": [["default"]]}}},
            "SaveImage": {"input": {"required": {"images": ["IMAGE"], "filename_prefix": ["STRING"]}}},
        }

    def test_scrubs_private_defaults_and_adds_dependency_readme(self):
        result = share_extension(self.store, self.payload, self.info)
        with zipfile.ZipFile(io.BytesIO(self.store.download(result["digest"]))) as archive:
            text = "\n".join(archive.read(name).decode() for name in archive.namelist())
            self.assertNotIn("private-person", text)
            self.assertNotIn("private prompt", text)
            self.assertNotIn("secret-title", text)
            self.assertNotIn("C:/private", text)
            self.assertIn("model.safetensors", text)
            self.assertIn("UNETLoader", archive.read("README.md").decode())
        self.assertEqual(result["manifest"]["licenses"]["workflow"], "UNSPECIFIED")
        self.assertEqual(self.workflow["text"]["inputs"]["text"], "private prompt")

    def test_explicit_prompt_inclusion_and_custom_current_parameters(self):
        result = share_extension(self.store, {**self.payload, "includePrompts": True}, self.info)
        definition = result["nodes"][0]["definition"]
        field = next(b["sourceId"] for b in definition["bindings"] if b["nodeId"] == "text")
        payload = {k: v for k, v in self.payload.items() if k != "workflow"}
        copied = share_extension(self.store, {**payload, "digest": result["digest"], "nodeDefinitionId": "workflow", "parameters": {field: "changed prompt"}}, self.info)
        self.assertEqual(copied["nodes"][0]["workflow"]["text"]["inputs"]["text"], "")
        copied = share_extension(self.store, {**payload, "digest": result["digest"], "nodeDefinitionId": "workflow", "parameters": {field: "changed prompt"}, "includePrompts": True}, self.info)
        self.assertEqual(copied["nodes"][0]["workflow"]["text"]["inputs"]["text"], "changed prompt")

    def test_rejects_credentials_local_paths_and_bad_metadata(self):
        for fields in ({"api_key": "private"}, {"other": "C:/private/file"}, {"other": "file:///private"}, {"blob": "data:image/png;base64,aGVsbG8="}, {"value": "Bearer " + "a" * 30}):
            workflow = {**self.workflow, "extra": {"class_type": "Custom", "inputs": fields}}
            with self.assertRaises(ExtensionError):
                share_extension(self.store, {**self.payload, "workflow": workflow}, self.info)
        for override in ({"includePrompts": "yes"}, {"packageId": "../escape"}, {"version": "latest"}, {"license": "invalid"}, {"parameters": {}}):
            with self.assertRaises(ExtensionError):
                share_extension(self.store, {**self.payload, **override}, self.info)
        self.assertFalse(self.store.root.exists())

    def test_model_and_enum_names_containing_text_are_not_prompts(self):
        self.workflow["extra"] = {"class_type": "CustomLoader", "inputs": {"text_encoder": "encoder.safetensors", "text_encoder_device": "cpu", "positive": "private prompt"}}
        self.info["CustomLoader"] = {"input": {"required": {"text_encoder": [["encoder.safetensors"]], "text_encoder_device": [["cpu", "cuda"]], "positive": ["STRING"]}}}
        result = share_extension(self.store, self.payload, self.info)
        inputs = result["nodes"][0]["workflow"]["extra"]["inputs"]
        self.assertEqual(inputs, {"text_encoder": "encoder.safetensors", "text_encoder_device": "cpu", "positive": ""})
        self.assertTrue(any(m["name"] == "encoder.safetensors" for m in result["manifest"]["dependencies"]["models"]))


if __name__ == "__main__":
    unittest.main()
