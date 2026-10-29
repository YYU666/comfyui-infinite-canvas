from __future__ import annotations

import copy
import io
import json
import os
import sys
import tempfile
import threading
import time
import unittest
import zipfile
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

from project_store import ProjectStore, RevisionConflict, StoreError, new_document
from scripts.validate_project import validate_project


class ProjectStoreTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.store = ProjectStore(self.root, "owner-a")
        self.document = self.store.create("测试项目")
        self.path = self.root / "测试项目" / "project.json"

    def tearDown(self):
        self.store.close()
        self.temporary.cleanup()

    def test_01_create_has_v3_layout(self):
        self.assertEqual(validate_project(self.document), [])
        for folder in ("assets", "backups", "outputs", "exports", ".cache"):
            self.assertTrue((self.path.parent / folder).is_dir())

    def test_02_list_get_and_external_project_round_trip(self):
        self.assertEqual(self.store.list()[0]["nodeCount"], 0)
        self.assertEqual(self.store.get(self.document["id"])["name"], "测试项目")
        with tempfile.TemporaryDirectory() as external:
            created = self.store.create("外部项目", directory=Path(external) / "外部项目")
            opened = self.store.open_path(Path(external) / "外部项目")
            opened["name"] = "外部项目-已保存"
            saved = self.store.save(created["id"], opened, opened["revision"])
            self.assertEqual(saved["name"], "外部项目-已保存")
            self.assertEqual(self.store.get(created["id"])["name"], "外部项目-已保存")

    def test_03_save_increments_revision_and_writes_backup(self):
        document = copy.deepcopy(self.document)
        document["canvas"]["nodes"].append({"id": "n1", "type": "text"})
        saved = self.store.save(document["id"], document, 1)
        self.assertEqual(saved["revision"], 2)
        self.assertTrue((self.path.parent / "backups" / "project-r1.json").is_file())

    def test_04_revision_conflict_preserves_both_versions(self):
        stale = copy.deepcopy(self.document)
        current = copy.deepcopy(self.document)
        current["name"] = "已更新"
        self.store.save(current["id"], current, 1)
        stale["name"] = "冲突修改"
        with self.assertRaises(RevisionConflict) as caught:
            self.store.save(stale["id"], stale, 1)
        self.assertEqual(caught.exception.status, 409)
        self.assertEqual(self.store.get(current["id"])["name"], "已更新")
        self.assertEqual(len(list(self.path.parent.glob(".conflict-*.json"))), 1)

    def test_05_concurrent_write_has_one_winner(self):
        results = []
        def worker(name):
            document = copy.deepcopy(self.document)
            document["name"] = name
            try:
                self.store.save(document["id"], document, 1)
                results.append("ok")
            except RevisionConflict:
                results.append("conflict")
        threads = [threading.Thread(target=worker, args=(name,)) for name in ("A", "B")]
        for thread in threads: thread.start()
        for thread in threads: thread.join()
        self.assertEqual(sorted(results), ["conflict", "ok"])

    def test_06_backup_retention_is_twenty(self):
        document = copy.deepcopy(self.document)
        for _ in range(23):
            document = self.store.save(document["id"], document, document["revision"])
        self.assertEqual(len(list(self.path.parent.glob("backups/project-r*.json"))), 20)

    def test_07_second_instance_is_locked(self):
        self.store.acquire_lock(self.path)
        other = ProjectStore(self.root, "owner-b")
        try:
            with self.assertRaises(StoreError) as caught:
                other.acquire_lock(self.path)
            self.assertEqual(caught.exception.status, 423)
        finally:
            other.close()

    def test_08_only_stale_dead_process_lock_can_be_taken_over(self):
        self.store.acquire_lock(self.path)
        lock = self.path.parent / ".lock"
        payload = json.loads(lock.read_text(encoding="utf-8"))
        payload["heartbeat"] = time.time() - 31
        lock.write_text(json.dumps(payload), encoding="utf-8")
        other = ProjectStore(self.root, "owner-b")
        try:
            with self.assertRaises(StoreError) as caught:
                other.acquire_lock(self.path)
            self.assertEqual(caught.exception.status, 423)
            payload["pid"] = 99999999
            lock.write_text(json.dumps(payload), encoding="utf-8")
            self.assertEqual(other.acquire_lock(self.path)["owner"], "owner-b")
        finally:
            other.close()

    def test_09_duplicate_gets_new_identity(self):
        duplicate = self.store.duplicate(self.document["id"])
        self.assertNotEqual(duplicate["id"], self.document["id"])
        self.assertEqual(duplicate["revision"], 1)

    def test_10_delete_moves_to_trash_and_restore(self):
        deleted = self.store.delete(self.document["id"])
        self.assertTrue(Path(deleted["trashPath"]).is_dir())
        trash_rows = self.store.list_trash()
        self.assertEqual(len(trash_rows), 1)
        self.assertEqual(trash_rows[0]["trashName"], Path(deleted["trashPath"]).name)
        restored = self.store.restore(Path(deleted["trashPath"]).name)
        self.assertEqual(restored["id"], self.document["id"])
        self.assertEqual(self.store.list_trash(), [])

    def test_11_asset_hash_deduplicates(self):
        first = self.store.put_asset(self.document["id"], "a.png", io.BytesIO(b"same"), "image/png")
        second = self.store.put_asset(self.document["id"], "b.png", io.BytesIO(b"same"), "image/png")
        self.assertEqual(first["asset"]["path"], second["asset"]["path"])
        self.assertEqual(len(list((self.path.parent / "assets").glob("*.png"))), 1)
        self.assertEqual(len(self.store.get(self.document["id"])["assets"]), 1)

    def test_12_asset_type_is_whitelisted(self):
        with self.assertRaises(StoreError) as caught:
            self.store.put_asset(self.document["id"], "bad.exe", io.BytesIO(b"x"))
        self.assertEqual(caught.exception.status, 415)

    def test_13_asset_range_full_partial_and_suffix(self):
        result = self.store.put_asset(self.document["id"], "a.mp4", io.BytesIO(b"0123456789"), "video/mp4")
        path = self.store.asset_file(self.document["id"], result["asset"]["path"])
        self.assertEqual(self.store.range_response(path)[0:4:2], (200, 0))
        status, headers, start, length = self.store.range_response(path, "bytes=2-5")
        self.assertEqual((status, start, length, headers["Content-Range"]), (206, 2, 4, "bytes 2-5/10"))
        self.assertEqual(self.store.range_response(path, "bytes=-3")[2:4], (7, 3))
        with self.assertRaises(StoreError) as caught:
            self.store.range_response(path, "bytes=20-")
        self.assertEqual(caught.exception.status, 416)

    def test_14_asset_path_traversal_is_rejected(self):
        for value in ("../secret", "assets/../secret", "assets\\..\\secret", "C:/secret", "other/a.png"):
            with self.subTest(value=value), self.assertRaises(StoreError):
                self.store.asset_file(self.document["id"], value)

    def test_15_export_and_import_round_trip(self):
        self.store.put_asset(self.document["id"], "a.png", io.BytesIO(b"image"), "image/png")
        archive = self.store.export(self.document["id"])
        target_root = self.root / "imported"
        imported_store = ProjectStore(target_root)
        try:
            imported = imported_store.import_zip(archive)
            self.assertEqual(imported["id"], self.document["id"])
            self.assertEqual(len(imported["assets"]), 1)
            self.assertEqual(len(list((target_root / "测试项目" / "assets").glob("*.png"))), 1)
        finally:
            imported_store.close()

    def test_16_zip_slip_is_rejected(self):
        archive = self.root / "bad.zip"
        with zipfile.ZipFile(archive, "w") as output:
            output.writestr("project.json", json.dumps(self.document))
            output.writestr("../escape", "bad")
        with self.assertRaises(StoreError):
            self.store.import_zip(archive)
        self.assertFalse((self.root / "escape").exists())

    def test_17_zip_windows_paths_cannot_escape_or_overwrite(self):
        sentinel = self.root / "sentinel.txt"
        sentinel.write_bytes(b"keep")
        attacks = [
            sentinel.as_posix(),
            "C:escape.txt",
            "..\\escape.txt",
            "assets\\..\\escape.txt",
            "\\\\server\\share\\escape.txt",
        ]
        for index, member in enumerate(attacks):
            archive = self.root / f"bad-windows-{index}.zip"
            with zipfile.ZipFile(archive, "w") as output:
                output.writestr("project.json", json.dumps(self.document))
                output.writestr(member, "bad")
            with self.subTest(member=member), self.assertRaises(StoreError):
                self.store.import_zip(archive)
            self.assertEqual(sentinel.read_bytes(), b"keep")
        self.assertFalse((self.root / "escape.txt").exists())

    def test_18_v2_migration_keeps_canvas_and_backup(self):
        legacy = {"schemaVersion": 2, "id": self.document["id"], "name": "旧项目", "revision": 0, "createdAt": 1, "updatedAt": 2, "canvas": {"nodes": [{"id": "n1"}], "edges": []}}
        self.path.write_text(json.dumps(legacy), encoding="utf-8")
        migrated = self.store.get(self.document["id"])
        self.assertEqual(migrated["schemaVersion"], 3)
        self.assertEqual(migrated["canvas"]["nodes"], [{"id": "n1"}])
        self.assertTrue(list(self.path.parent.glob("backups/*before-v3.json")))

    def test_19_invalid_schema_is_not_overwritten(self):
        invalid = dict(self.document, revision=0)
        original = json.dumps(invalid)
        self.path.write_text(original, encoding="utf-8")
        with self.assertRaises(StoreError):
            self.store.get(self.document["id"])
        self.assertEqual(self.path.read_text(encoding="utf-8"), original)

    def test_20_one_hundred_projects_are_listed(self):
        for index in range(99):
            self.store.create(f"项目-{index:03d}")
        rows = self.store.list()
        self.assertEqual(len(rows), 100)
        self.assertTrue(all(row["id"] for row in rows))

    def test_21_invalid_project_name_is_rejected(self):
        for name in ("", "a/b", "CON", "name."):
            with self.subTest(name=name), self.assertRaises(StoreError):
                self.store.create(name)

    def test_22_release_and_server_side_read_only(self):
        self.store.open(self.document["id"])
        other = ProjectStore(self.root, "owner-b")
        try:
            opened = other.open(self.document["id"], read_only=True)
            opened["name"] = "只读修改不应落盘"
            with self.assertRaises(StoreError) as caught:
                other.save(opened["id"], opened, opened["revision"])
            self.assertEqual(caught.exception.code, "READ_ONLY")
            with self.assertRaises(StoreError) as caught:
                other.put_asset(opened["id"], "a.png", io.BytesIO(b"not-written"), "image/png")
            self.assertEqual(caught.exception.code, "READ_ONLY")
            self.store.release(self.document["id"])
            editable = other.open(self.document["id"])
            editable["name"] = "释放后可编辑"
            saved = other.save(editable["id"], editable, editable["revision"])
            self.assertEqual(saved["name"], "释放后可编辑")
        finally:
            other.close()
        self.assertEqual(self.store.get(self.document["id"])["name"], "释放后可编辑")

    def test_23_transient_windows_project_read_is_retried(self):
        original = Path.read_text
        attempts = 0

        def flaky_read(path, *args, **kwargs):
            nonlocal attempts
            if Path(path) == self.path and attempts == 0:
                attempts += 1
                raise PermissionError(13, "模拟原子替换期间的共享冲突", str(path))
            return original(path, *args, **kwargs)

        with mock.patch.object(Path, "read_text", new=flaky_read), \
             mock.patch("project_store.time.sleep") as sleep:
            self.assertEqual(self.store.get(self.document["id"])["name"], "测试项目")
            sleep.assert_called_once_with(0.01)


if __name__ == "__main__":
    unittest.main()
