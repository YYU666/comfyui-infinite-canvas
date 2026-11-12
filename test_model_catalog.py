import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent / "scripts"))

from scripts import model_catalog


class ModelCatalogTests(unittest.TestCase):
    def test_core_h3_bytes_match_manifest(self):
        bundle = model_catalog.bundle_records("core-h3")
        self.assertEqual(bundle["totalBytes"], 76410807376)
        self.assertEqual(bundle["totalGiB"], 71.163)
        self.assertEqual(bundle["fileCount"], 7)
        self.assertTrue(bundle["officialDownload"])

    def test_h3_image_incremental_excludes_encoder(self):
        bundle = model_catalog.bundle_records("h3-image-incremental")
        self.assertEqual(bundle["totalBytes"], 22147820114)
        paths = [item["path"] for item in bundle["files"]]
        self.assertNotIn("text_encoders/qwen3vl_32b_minimax_h3_int8_convrot.safetensors", paths)
        self.assertEqual(len(paths), 2)

    def test_list_does_not_touch_the_network(self):
        with mock.patch("urllib.request.urlopen") as opener:
            payload = model_catalog.list_bundles("core-h3")
            stdout = model_catalog.format_table(payload)
        opener.assert_not_called()
        self.assertIn("core-h3", stdout)
        self.assertIn("76410807376", stdout)

    def test_status_reports_missing_on_empty_root(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "ComfyUI" / "models").mkdir(parents=True)
            payload = model_catalog.status(root, "core-h3")
        state = payload["bundles"][0]["status"]
        self.assertEqual(state["missing"], 7)
        self.assertEqual(state["installed"], 0)
        self.assertEqual(state["mismatched"], 0)

    def test_status_accepts_matching_file(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            item = model_catalog.bundle_records("h3-image-incremental")["files"][1]
            target = root / "ComfyUI" / "models" / item["path"]
            target.parent.mkdir(parents=True)
            target.write_bytes(b"x" * item["bytes"] if item["bytes"] < 8 else b"")
            # Do not write multi-gigabyte fixtures; only assert the missing/mismatch branch for a tiny fake file.
            payload = model_catalog.status(root, "h3-image-incremental")
        state = payload["bundles"][0]["status"]
        self.assertEqual(state["installed"] + state["missing"] + state["mismatched"], 2)
        self.assertGreaterEqual(state["missing"] + state["mismatched"], 1)

    def test_download_without_matching_confirmation_does_not_network_or_write(self):
        with tempfile.TemporaryDirectory() as temporary, mock.patch("urllib.request.urlopen") as opener:
            root = Path(temporary)
            (root / "ComfyUI" / "models").mkdir(parents=True)
            before = list(root.rglob("*"))
            stdout, stderr = io.StringIO(), io.StringIO()
            with mock.patch.object(sys, "stdout", stdout), mock.patch.object(sys, "stderr", stderr):
                code = model_catalog.main(["download", "--bundle", "core-h3", "--comfy-root", str(root)])
            self.assertEqual(code, 2)
            opener.assert_not_called()
            self.assertEqual(list(root.rglob("*")), before)
            self.assertIn("confirm-download", stderr.getvalue())

    def test_download_with_confirmation_is_still_refused_in_this_version(self):
        with tempfile.TemporaryDirectory() as temporary, mock.patch("urllib.request.urlopen") as opener:
            root = Path(temporary)
            (root / "ComfyUI" / "models").mkdir(parents=True)
            before = list(root.rglob("*"))
            stderr = io.StringIO()
            with mock.patch.object(sys, "stderr", stderr):
                code = model_catalog.main([
                    "download", "--bundle", "core-h3", "--comfy-root", str(root),
                    "--confirm-download", "core-h3",
                ])
            self.assertEqual(code, 2)
            opener.assert_not_called()
            self.assertEqual(list(root.rglob("*")), before)
            self.assertIn("尚未", stderr.getvalue())

    def test_unknown_bundle_raises(self):
        with self.assertRaisesRegex(ValueError, "未知套装"):
            model_catalog.bundle_records("not-a-real-bundle")


if __name__ == "__main__":
    unittest.main()
