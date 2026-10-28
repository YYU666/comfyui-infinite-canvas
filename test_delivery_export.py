import copy
import io
import subprocess
import sys
import tempfile
import time
import unittest
import unittest.mock
from datetime import datetime
from pathlib import Path

import imageio_ffmpeg
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))

from delivery_export import export_delivery
from project_store import ProjectStore, StoreError


class DeliveryExportTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.store = ProjectStore(Path(self.temporary.name), "export-test")
        self.document = self.store.create("交付测试")

    def tearDown(self):
        self.store.close()
        self.temporary.cleanup()

    def add_shot(self, take_count=1, video=False):
        takes = []
        for index in range(1, take_count + 1):
            image = Image.new("RGB", (640, 360), ((index * 31) % 255, 80, 140))
            content = io.BytesIO()
            image.save(content, "PNG")
            extension = "png"
            if video:
                source = Path(self.temporary.name) / "source.mp4"
                subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=blue:s=320x180:d=1", "-pix_fmt", "yuv420p", str(source)], check=True, timeout=30)
                content = io.BytesIO(source.read_bytes())
                extension = "mp4"
            content.seek(0)
            result = self.store.put_asset(self.document["id"], f"take-{index}.{extension}", content, "video/mp4" if video else "image/png")
            takes.append({
                "id": f"t{index}", "asset": result["asset"]["path"], "poster": None,
                "recipe": {"model": "test-model", "seed": 42 + index, "steps": 4, "refs": ["c1", "o1"]},
                "rating": index % 6, "selected": True, "createdAt": "2026-10-29T00:00:00+00:00",
            })
        document = self.store.get(self.document["id"])
        document["shots"].append({
            "id": "s1", "number": "S01", "name": "雨夜", "prompt": "固定机位，角色回头", "characterId": "c1", "outfitId": "o1", "locationId": None,
            "params": {"ratio": "16:9", "resolution": "480P", "duration": 5, "seed": 42, "turbo": False},
            "takes": takes, "status": "done", "tags": ["测试"],
        })
        self.store.save(document["id"], document, document["revision"])

    def test_twenty_selected_exports_have_stable_manifest_and_contact_sheets(self):
        self.add_shot(20)
        started = time.monotonic()
        result = export_delivery(self.store, self.document["id"], now=datetime(2026, 10, 29))
        elapsed = time.monotonic() - started
        self.assertLess(elapsed, 60)
        self.assertEqual(result["count"], 20)
        target = Path(result["path"])
        self.assertEqual(target.name, "交付测试-20261029")
        manifest = __import__("json").loads((target / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(len(manifest["items"]), 20)
        first = manifest["items"][0]
        self.assertEqual(first["file"], "S01/S01_T01.png")
        self.assertEqual(first["prompt"], "固定机位，角色回头")
        self.assertEqual(first["seed"], 42)
        self.assertEqual(first["references"], {"characterId": "c1", "outfitId": "o1", "locationId": None, "recipeRefs": ["c1", "o1"]})
        self.assertEqual(first["recipe"]["steps"], 4)
        self.assertEqual(len(first["source"]["sha256"]), 64)
        self.assertEqual(len(list((target / "S01").glob("*.png"))), 20)
        with Image.open(target / "contact-sheet.jpg") as sheet:
            self.assertGreater(sheet.width, 1000)
        self.assertTrue((target / "contact-sheet.pdf").read_bytes().startswith(b"%PDF"))

    def test_explicit_take_selection_is_repeatable_and_missing_ids_fail(self):
        self.add_shot(3)
        first = export_delivery(self.store, self.document["id"], ["t2"], now=datetime(2026, 10, 29))
        second = export_delivery(self.store, self.document["id"], ["t2"], now=datetime(2026, 10, 29))
        self.assertEqual(first["path"], second["path"])
        self.assertEqual(first["manifest"], second["manifest"])
        with self.assertRaises(StoreError) as caught:
            export_delivery(self.store, self.document["id"], ["t99"])
        self.assertEqual(caught.exception.code, "EXPORT_TAKE_NOT_FOUND")

    def test_video_uses_ffmpeg_thumbnail(self):
        self.add_shot(1, video=True)
        result = export_delivery(self.store, self.document["id"], now=datetime(2026, 10, 29))
        target = Path(result["path"])
        self.assertTrue((target / "S01" / "S01_T01.mp4").is_file())
        with Image.open(target / "contact-sheet.jpg") as sheet:
            self.assertEqual(sheet.format, "JPEG")

    def test_external_comfy_result_is_copied_only_on_export(self):
        content = io.BytesIO()
        Image.new("RGB", (640, 360), (35, 80, 140)).save(content, "PNG")
        document = self.store.get(self.document["id"])
        document["shots"].append({
            "id": "s1", "number": "S01", "name": "外部结果", "prompt": "保持引用", "characterId": None, "outfitId": None, "locationId": None,
            "params": {"ratio": "16:9", "resolution": "480P", "duration": 5, "seed": 42, "turbo": False},
            "takes": [{"id": "t1", "asset": "assets/not-copied-yet.png", "poster": None,
                       "recipe": {"output": {"filename": "H3_test.png", "subfolder": "", "type": "output", "url": "/view?filename=H3_test.png&type=output"}},
                       "rating": 5, "selected": True, "createdAt": "2026-10-29T00:00:00+00:00"}],
            "status": "done", "tags": [],
        })
        self.store.save(document["id"], document, document["revision"])
        project_dir = self.store._project_path(self.document["id"]).parent
        self.assertFalse((project_dir / "assets" / "not-copied-yet.png").exists())
        content.seek(0)
        with unittest.mock.patch("delivery_export.urllib.request.urlopen", return_value=content) as requested:
            result = export_delivery(self.store, self.document["id"], now=datetime(2026, 10, 29))
        self.assertIn("filename=H3_test.png", requested.call_args.args[0])
        self.assertTrue((project_dir / "outputs" / "S01" / "S01_T01.png").is_file())
        self.assertTrue((Path(result["path"]) / "S01" / "S01_T01.png").is_file())
        self.assertFalse((project_dir / "assets" / "not-copied-yet.png").exists())

    def test_empty_selection_is_rejected(self):
        self.add_shot(2)
        with self.assertRaises(StoreError) as caught:
            export_delivery(self.store, self.document["id"], [])
        self.assertEqual(caught.exception.code, "EXPORT_EMPTY")


if __name__ == "__main__":
    unittest.main()
