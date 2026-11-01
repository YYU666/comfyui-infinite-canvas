import copy
import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import urllib.request

from extension_dependencies import (ModelDownloads, _ModelRedirect, _NoRedirect, canonical_sources,
                                    catalog_import, dependency_report)
from extension_api import ExtensionAPI
from test_extension_api import Handler
from test_workflow_extensions import info_fixture, workflow_fixture, rewrite_package
from workflow_extensions import ExtensionError, ExtensionStore, convert_api_json, inspect_package


class DependencyTests(unittest.TestCase):
    def setUp(self):
        self.bundle = inspect_package(convert_api_json(json.dumps(workflow_fixture()).encode()))
        self.payload = {"nodeDefinitionId": "workflow", "parameters": {}}

    def test_same_loader_candidates_are_not_claimed_compatible(self):
        info = info_fixture()
        info["MixThree"]["input"]["required"]["model_name"] = [["different.gguf"]]
        report = dependency_report(self.bundle, self.payload, info)
        row = report["models"][0]
        self.assertEqual(row["status"], "missing")
        self.assertEqual(row["parameterId"], "node_mix__model_name")
        self.assertEqual(row["candidates"][0]["compatibility"], "loader-option")
        self.assertFalse(report["ready"])
        self.assertIsNone(row["download"])
        self.assertEqual(self.bundle["nodes"][0]["workflow"]["mix"]["inputs"]["model_name"], "fixture.safetensors")

    def test_explicit_parameter_changes_are_analyzed(self):
        info = info_fixture()
        info["MixThree"]["input"]["required"]["model_name"] = [["other.safetensors"]]
        self.payload["parameters"] = {"node_mix__model_name": "other.safetensors"}
        report = dependency_report(self.bundle, self.payload, info)
        self.assertEqual(report["models"][0]["name"], "other.safetensors")
        self.assertTrue(report["ready"])

    def test_missing_class_is_reported_and_model_is_unknown(self):
        info = info_fixture()
        del info["MixThree"]
        report = dependency_report(self.bundle, self.payload, info)
        self.assertEqual(report["missingNodes"], 1)
        self.assertEqual(report["models"][0]["status"], "unknown")

    def test_empty_model_disabled_and_unknown_custom_folder(self):
        for name in ("", "None", "disabled"):
            report = dependency_report(self.bundle, {**self.payload, "parameters": {"node_mix__model_name": name}}, info_fixture())
            self.assertEqual(report["models"], [])
        bundle = copy.deepcopy(self.bundle)
        bundle["nodes"][0]["workflow"]["mix"]["class_type"] = "H3UnetLoaderImitation"
        report = dependency_report(bundle, self.payload, {})
        self.assertEqual(report["models"][0]["category"], "unknown")
        self.assertIsNone(report["models"][0]["download"])


    def test_model_download_requires_exact_category_and_filename(self):
        bundle = copy.deepcopy(self.bundle)
        node = bundle["nodes"][0]
        node["workflow"]["mix"]["class_type"] = "UNETLoader"
        node["workflow"]["mix"]["inputs"]["unet_name"] = "minimax_h3_ref2va_pruned_int8_convrot.safetensors"
        del node["workflow"]["mix"]["inputs"]["model_name"]
        node["definition"]["bindings"][-1]["input"] = "unet_name"
        node["definition"]["parameters"]["properties"]["node_mix__model_name"]["default"] = "minimax_h3_ref2va_pruned_int8_convrot.safetensors"
        info = {"UNETLoader": {"input": {"required": {"unet_name": [[]]}}}}
        row = dependency_report(bundle, self.payload, info)["models"][0]
        self.assertEqual(row["download"]["bytes"], 20970379616)
        self.assertEqual(row["download"]["verification"], "sha256")
        self.payload["parameters"] = {"node_mix__model_name": "other/minimax_h3_ref2va_pruned_int8_convrot.safetensors"}
        self.assertIsNone(dependency_report(bundle, self.payload, info)["models"][0]["download"])

    def test_invalid_parameter_and_traversal_never_download(self):
        for parameters in ({"bad": "value"}, {"node_mix__steps": "wrong"}):
            with self.assertRaises(ExtensionError):
                dependency_report(self.bundle, {**self.payload, "parameters": parameters}, info_fixture())
        report = dependency_report(self.bundle, {**self.payload, "parameters": {"node_mix__model_name": "../fixture.safetensors"}}, info_fixture())
        self.assertEqual(report["models"][0]["status"], "unknown")
        self.assertIsNone(report["models"][0]["download"])

    def test_sources_exclude_unresolved_weight_and_have_valid_known_hashes(self):
        sources = canonical_sources()
        self.assertNotIn("diffusion_models/Krea2-MuseByStable_v30Turbo_fp8.safetensors", sources)
        self.assertGreaterEqual(len(sources), 12)
        self.assertTrue(all(value["url"].startswith("https://huggingface.co/") and len(value["sha256"]) == 64 for value in sources.values()))


class CatalogTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = ExtensionStore(Path(self.temp.name) / "extensions")
        self.data = convert_api_json(json.dumps(workflow_fixture()).encode())
        bundle = inspect_package(self.data)
        self.payload = {"packageId": bundle["manifest"]["packageId"], "version": bundle["manifest"]["version"], "digest": "sha256:" + bundle["digest"]}

    def test_pinned_catalog_import(self):
        urls = []
        def open_resource(url, **kwargs):
            urls.append(url)
            return io.BytesIO(self.data)
        result = catalog_import(self.store, self.payload, open_resource)
        self.assertEqual(result["digest"], self.payload["digest"][7:])
        self.assertTrue(urls[0].startswith("https://refmuse.cn/api/open/items/local/"))

    def test_digest_identity_and_url_tampering_do_not_write(self):
        for changes in ({"digest": "0" * 64}, {"packageId": "other/package"}, {"version": "1.0.0"}, {"packageId": "../../bad"}, {"url": "http://127.0.0.1/"}):
            with self.assertRaises(ExtensionError):
                catalog_import(self.store, {**self.payload, **changes}, lambda *a, **k: io.BytesIO(self.data))
            self.assertFalse(self.store.root.exists())

    def test_redirect_boundaries(self):
        request = urllib.request.Request("https://huggingface.co/known/repo/resolve/main/model")
        for url in ("http://127.0.0.1/private", "https://huggingface.co.evil.test/a", "https://user@huggingface.co/a", "https://huggingface.co:8443/a", "file:///etc/passwd"):
            with self.assertRaises(ExtensionError):
                _ModelRedirect().redirect_request(request, None, 302, "", {}, url)
        redirected = _ModelRedirect().redirect_request(request, None, 302, "", {}, "https://cas-bridge.xethub.hf.co/path")
        self.assertEqual(redirected.full_url, "https://cas-bridge.xethub.hf.co/path")
        with self.assertRaises(ExtensionError):
            _NoRedirect().redirect_request(request, None, 302, "", {}, "https://refmuse.cn/other")


class DownloadTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "ComfyUI").mkdir()
        (self.root / "ComfyUI" / "main.py").touch()
        self.data = b"verified-model-bytes"
        self.source = {"path": "loras/fixture.safetensors", "url": "https://huggingface.co/test/model", "bytes": len(self.data), "sha256": hashlib.sha256(self.data).hexdigest()}
        self.manager = ModelDownloads(self.root, sources={self.source["path"]: self.source}, opener=lambda *a, **k: io.BytesIO(self.data))
        self.report = {"models": [{"id": "1:lora_name", "download": self.source}]}

    def run_synchronously(self):
        with patch("extension_dependencies.threading.Thread"):
            job = self.manager.start(self.report, ["1:lora_name"])
        self.manager._run(job["jobId"], [self.source])
        return self.manager.get(job["jobId"])

    def test_verified_download_and_preserve_existing(self):
        job = self.run_synchronously()
        self.assertEqual(job["status"], "completed")
        target = self.root / "ComfyUI/models/loras/fixture.safetensors"
        self.assertEqual(target.read_bytes(), self.data)
        job = self.run_synchronously()
        self.assertEqual(job["status"], "failed")
        self.assertIn("未覆盖", job["error"])
        self.assertEqual(target.read_bytes(), self.data)
        self.assertFalse(list(target.parent.glob("*.part")))

    def test_hash_or_size_mismatch_never_publish(self):
        for data in (b"x" * len(self.data), self.data + b"extra", b"short"):
            self.manager.opener = lambda *a, **k: io.BytesIO(data)
            job = self.run_synchronously()
            self.assertEqual(job["status"], "failed")
            self.assertFalse((self.root / "ComfyUI/models/loras/fixture.safetensors").exists())
            self.assertFalse(list((self.root / "ComfyUI/models/loras").glob("*.part")))

    def test_missing_source_and_duplicate_jobs(self):
        with self.assertRaises(ExtensionError):
            self.manager.start({"models": [{"id": "x", "download": None}]}, ["x"])
        with patch("extension_dependencies.threading.Thread"):
            first = self.manager.start(self.report, ["1:lora_name"])
            second = self.manager.start(self.report, ["1:lora_name"])
        self.assertEqual(first["jobId"], second["jobId"])
        self.assertEqual(len(self.manager.jobs), 1)

    def test_target_path_escape_rejected(self):
        self.source["path"] = "../escape.safetensors"
        self.manager.sources = {self.source["path"]: self.source}
        self.assertEqual(self.run_synchronously()["status"], "failed")
        self.assertFalse((self.root / "ComfyUI/escape.safetensors").exists())

    def test_target_reparse_or_symlink_rejected(self):
        target_dir = self.root / "ComfyUI/models/loras"
        target_dir.mkdir(parents=True)
        with patch.object(ExtensionStore, "_regular_path", side_effect=ExtensionError("reparse blocked")):
            self.assertEqual(self.run_synchronously()["status"], "failed")
        self.assertEqual(list(target_dir.iterdir()), [])

    def test_api_dependency_and_job_routes(self):
        store = ExtensionStore(self.root / "extensions")
        bundle = store.import_bytes(json.dumps(workflow_fixture()).encode())
        api = ExtensionAPI(store, object_info=info_fixture, comfy_root=self.root)
        handler = Handler(json.dumps({"nodeDefinitionId": "workflow", "parameters": {}}).encode())
        api.handle_post(handler, "/api/extensions/" + bundle["digest"] + "/dependencies")
        self.assertEqual(handler.status, 200)
        self.assertTrue(handler.payload["ready"])
        handler = Handler()
        api.handle_get(handler, "/api/extensions/download-jobs/missing")
        self.assertEqual(handler.status, 404)

    def test_api_share_and_download_post_routes(self):
        store = ExtensionStore(self.root / "extensions")
        bundle = store.import_bytes(json.dumps(workflow_fixture()).encode())
        api = ExtensionAPI(store, object_info=info_fixture, comfy_root=self.root)
        handler = Handler(json.dumps({"workflow": workflow_fixture(), "name": "Shared"}).encode())
        with patch("extension_sharing.share_extension", return_value={"shared": True}) as share:
            api.handle_post(handler, "/api/extensions/share")
            self.assertEqual(handler.payload, {"shared": True})
            share.assert_called_once()
        payload = {"nodeDefinitionId": "workflow", "parameters": {}, "modelIds": ["mix:model_name"]}
        handler = Handler(json.dumps(payload).encode())
        with patch.object(api.downloads, "start", return_value={"jobId": "job", "status": "queued"}) as start:
            api.handle_post(handler, "/api/extensions/" + bundle["digest"] + "/models/download")
            self.assertEqual(handler.status, 200)
            self.assertEqual(start.call_args.args[1], ["mix:model_name"])
        handler = Handler(json.dumps({**payload, "url": "http://localhost"}).encode())
        api.handle_post(handler, "/api/extensions/" + bundle["digest"] + "/models/download")
        self.assertEqual(handler.status, 400)


if __name__ == "__main__":
    unittest.main()
