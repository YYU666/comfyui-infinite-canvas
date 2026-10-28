import io
import json
import os
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from project_store import ProjectStore, StoreError
from project_api import ProjectAPI
from queue_api import QueueAPI
from video_workbench_launcher import WorkbenchHandler, WorkbenchServer
from workbench_queue import QueueManager


class AssetCollectionStoreTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.store = ProjectStore(self.root, "collection-test")
        self.document = self.store.create("素材回收测试")
        self.project_id = self.document["id"]
        self.project_path = self.root / "素材回收测试"

    def tearDown(self):
        self.store.close()
        self.temporary.cleanup()

    def upload(self, name, content):
        return self.store.put_asset(self.project_id, name, io.BytesIO(content), "image/png")["asset"]["path"]

    def age(self, relative, seconds=40 * 86400):
        path = self.project_path / relative
        old = time.time() - seconds
        os.utime(path, (old, old))

    def test_preview_preserves_current_backup_and_recent_files(self):
        current = self.upload("current.png", b"current")
        historical = self.upload("historical.png", b"historical")
        orphan = self.upload("orphan.png", b"orphan")
        recent = self.upload("recent.png", b"recent")
        document = self.store.get(self.project_id)
        document["canvas"]["nodes"] = [{"id": "n1", "type": "media", "data": {"assetPath": current}}]
        self.store.save(self.project_id, document, document["revision"])
        (self.project_path / "backups" / "custom.json").write_text(json.dumps({"canvas": {"nodes": [{"data": {"assetPath": historical}}]}}), encoding="utf-8")
        for relative in (current, historical, orphan):
            self.age(relative)
        revision = self.store.get(self.project_id)["revision"]
        preview = self.store.collect_orphans(self.project_id)
        self.assertTrue(preview["dryRun"])
        self.assertEqual([item["path"] for item in preview["candidates"]], [orphan])
        self.assertEqual(preview["bytes"], len(b"orphan"))
        self.assertEqual(preview["revision"], revision)
        for relative in (current, historical, orphan, recent):
            self.assertTrue((self.project_path / relative).is_file())
        removed = self.store.collect_orphans(self.project_id, dry_run=False)
        self.assertEqual([item["path"] for item in removed["removed"]], [orphan])
        self.assertFalse((self.project_path / orphan).exists())
        for relative in (current, historical, recent):
            self.assertTrue((self.project_path / relative).is_file())
        self.assertGreater(removed["revision"], revision)
        self.assertNotIn(orphan, [item["path"] for item in self.store.get(self.project_id)["assets"]])

    def test_url_references_and_unreadable_history_are_safe(self):
        referenced = self.upload("referenced.png", b"referenced")
        document = self.store.get(self.project_id)
        document["canvas"]["nodes"] = [{"id": "n1", "type": "media", "data": {"url": f"/api/projects/{self.project_id}/{referenced}?x=1"}}]
        self.store.save(self.project_id, document, document["revision"])
        self.age(referenced)
        self.assertEqual(self.store.collect_orphans(self.project_id, min_age_days=0)["candidates"], [])
        (self.project_path / "backups" / "broken.json").write_text("not-json", encoding="utf-8")
        with self.assertRaises(StoreError):
            self.store.collect_orphans(self.project_id, dry_run=False, min_age_days=0)
        self.assertTrue((self.project_path / referenced).is_file())

    def test_invalid_age_is_rejected(self):
        for value in (-1, 3651, "not-a-number", float("nan")):
            with self.subTest(value=value), self.assertRaises(StoreError):
                self.store.collect_orphans(self.project_id, min_age_days=value)


class AssetCollectionAPITests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        root = Path(self.temporary.name)
        self.store = ProjectStore(root, "collection-api")
        self.document = self.store.create("接口回收测试")
        self.asset = self.store.put_asset(self.document["id"], "orphan.png", io.BytesIO(b"orphan"), "image/png")["asset"]["path"]
        self.server = WorkbenchServer(("127.0.0.1", 0), WorkbenchHandler)
        self.server.token = "collection-test-token"
        self.server.queue_manager = QueueManager(root / "queue.json", poll_interval=0.01)
        self.server.queue_api = QueueAPI(self.server.queue_manager)
        self.server.project_store = self.store
        self.server.project_api = ProjectAPI(self.store)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=3)
        self.server.queue_manager.stop()
        self.store.close()
        self.temporary.cleanup()

    def post(self, payload):
        request = urllib.request.Request(
            self.base + f"/api/projects/{self.document['id']}/assets/collect",
            data=json.dumps(payload).encode(), method="POST",
            headers={"Content-Type": "application/json", "X-H3-Token": self.server.token},
        )
        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as error:
            return error.code, json.load(error)

    def test_default_preview_and_explicit_delete_confirmation(self):
        status, preview = self.post({})
        self.assertEqual(status, 200)
        self.assertTrue(preview["dryRun"])
        self.assertEqual(preview["candidates"], [])
        status, preview = self.post({"minAgeDays": 0})
        self.assertEqual([item["path"] for item in preview["candidates"]], [self.asset])
        status, error = self.post({"dryRun": False, "minAgeDays": 0})
        self.assertEqual(status, 400)
        self.assertIn("DELETE_ORPHANS", error["message"])
        self.assertTrue(self.store.asset_file(self.document["id"], self.asset).is_file())
        status, removed = self.post({"dryRun": False, "confirm": "DELETE_ORPHANS", "minAgeDays": 0})
        self.assertEqual(status, 200)
        self.assertEqual([item["path"] for item in removed["removed"]], [self.asset])
        with self.assertRaises(StoreError):
            self.store.asset_file(self.document["id"], self.asset)


if __name__ == "__main__":
    unittest.main()
