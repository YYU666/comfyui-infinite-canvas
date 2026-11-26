import concurrent.futures
import io
import json
import os
import shutil
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

import project_store as mod
from project_store import ProjectStore, StoreError


class IndexTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "projects"
        self.store = self.new_store("writer")

    def new_store(self, owner):
        store = ProjectStore(self.root, owner)
        self.addCleanup(store.close)
        return store

    def test_filesystem_move_replacement_missing_and_non_objects(self):
        a = self.store.create("A")
        self.assertEqual(self.store.get(a["id"])["id"], a["id"])
        (self.root / "A").rename(self.root / "renamed")
        self.assertEqual(self.store._project_path(a["id"]).parent.name, "renamed")
        path = self.root / "renamed" / "project.json"
        new = {**a, "id": "prj_other"}
        mod.atomic_write_json(path, new)
        with self.assertRaisesRegex(StoreError, "项目不存在"):
            self.store.get(a["id"])
        self.assertEqual(self.store.get("prj_other")["id"], "prj_other")
        path.write_text("[]", encoding="utf-8")
        with self.assertRaisesRegex(StoreError, "项目不存在"):
            self.store.get("prj_other")
        mod.atomic_write_json(path, new)
        self.assertEqual(self.store.get("prj_other")["id"], "prj_other")
        with self.assertRaises(StoreError) as err:
            self.store.get("../prj_other")
        self.assertEqual(err.exception.code, "BAD_REQUEST")

    def test_cold_concurrent_warm_assets_parse_count(self):
        ids = []
        for n in range(8):
            ids.append(self.store.create(f"Project {n}")["id"])
        asset = self.store.put_asset(ids[-1], "pic.png", io.BytesIO(b"asset"), "image/png")["asset"]["path"]
        reader = self.new_store("reader")
        with patch.object(mod, "_read_project_json", wraps=mod._read_project_json) as parse:
            with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
                hashes = list(pool.map(lambda _: reader.asset_file(ids[-1], asset).stem, range(32)))
            self.assertEqual(len(set(hashes)), 1)
            self.assertEqual(parse.call_count, 8)
            reader._project_path(ids[0])
            self.assertEqual(parse.call_count, 8)

    def test_copy_delete_restore_and_external_revalidation(self):
        a = self.store.create("A")
        duplicate = self.store.duplicate(a["id"])
        self.assertNotEqual(a["id"], duplicate["id"])
        self.assertEqual(self.store.get(duplicate["id"])["id"], duplicate["id"])
        deleted = Path(self.store.delete(a["id"])["trashPath"])
        self.assertFalse((deleted / ".lock").exists())
        with self.assertRaises(StoreError):
            self.store.get(a["id"])
        self.assertEqual(self.store.restore(deleted.name)["id"], a["id"])
        external = self.root.parent / "external"
        shutil.copytree(self.root / "A", external)
        with self.assertRaises(StoreError) as err:
            self.store.open_path(external, read_only=True)
        self.assertEqual(err.exception.code, "DUPLICATE_PROJECT_ID")
        mod.atomic_write_json(external / "project.json", {**a, "id": "prj_external"})
        self.assertEqual(self.store.open_path(external, read_only=True)["id"], "prj_external")
        self.assertEqual(self.store._project_path("prj_external"), (external / "project.json").resolve())
        mod.atomic_write_json(external / "project.json", {**a, "id": "prj_replacement"})
        for project_id in ("prj_external", "prj_replacement"):
            with self.assertRaises(StoreError):
                self.store._project_path(project_id)
        self.assertEqual(self.store.open_path(external, read_only=True)["id"], "prj_replacement")

    def test_duplicate_id_is_ambiguous_after_warm_lookup(self):
        a = self.store.create("A")
        self.store.get(a["id"])
        shutil.copytree(self.root / "A", self.root / "ExternalCopy")
        with self.assertRaises(StoreError) as err:
            self.store.get(a["id"])
        self.assertEqual(err.exception.code, "DUPLICATE_PROJECT_ID")
        (self.root / "ExternalCopy").rename(self.root.parent / "ExternalCopy")
        self.assertEqual(self.store.get(a["id"])["id"], a["id"])

    def test_active_and_read_only_deletion_guards_and_nonmutating_preview(self):
        a = self.store.create("A")
        pid = a["id"]
        contents = self.store.put_asset(pid, "a.png", io.BytesIO(b"old"), "image/png")["asset"]["path"]
        path = self.root / "A" / "project.json"
        lock = path.parent / ".lock"
        other = self.new_store("other")
        other.release(pid)
        self.assertTrue(lock.exists(), "a different store cannot close the writer's lock")
        for store in (self.store, other):
            with self.assertRaises(StoreError) as err:
                store.delete(pid)
            self.assertEqual(err.exception.code, "LOCKED")
        with self.assertRaises(StoreError) as err:
            other.collect_orphans(pid, dry_run=False, min_age_days=0)
        self.assertEqual(err.exception.code, "LOCKED")
        previous_lock = lock.read_bytes()
        self.assertEqual(other.collect_orphans(pid, min_age_days=0)["candidates"][0]["path"], contents)
        self.assertEqual(previous_lock, lock.read_bytes())
        self.store.release(pid)
        other.open(pid, read_only=True)
        (self.root / "A").rename(self.root / "renamed")
        for action in (lambda: other.collect_orphans(pid, dry_run=False, min_age_days=0), lambda: other.delete(pid)):
            with self.assertRaises(StoreError) as err:
                action()
            self.assertEqual(err.exception.code, "READ_ONLY")
        self.assertFalse((self.root / "renamed" / ".lock").exists())
        self.assertTrue((self.root / "renamed" / contents).is_file())

    def test_delete_and_writer_lock_have_single_winner(self):
        a = self.store.create("A")
        path = self.root / "A" / "project.json"
        other = self.new_store("other")
        sync = threading.Barrier(2)
        reserve = self.store._create_lock_file
        def pause(path, owner):
            sync.wait(timeout=5)
            reserve(path, owner)
        def attempt(operation):
            try:
                operation()
                return "success"
            except (OSError, StoreError) as err:
                return type(err).__name__
        with patch.object(ProjectStore, "_create_lock_file", side_effect=pause):
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                results = [pool.submit(attempt, action) for action in (
                    lambda: other.open(a["id"]), lambda: self.store.delete(a["id"])
                )]
                self.assertEqual([r.result(timeout=8) for r in results].count("success"), 1)

    @unittest.skipUnless(os.name == "nt", "Windows junction")
    def test_implicit_junction_is_not_an_authorized_external_path(self):
        import subprocess
        a = self.store.create("A")
        elsewhere = self.root.parent / "elsewhere"
        (self.root / "A").rename(elsewhere)
        junction = self.root / "junction"
        subprocess.run(["cmd.exe", "/c", "mklink", "/J", str(junction), str(elsewhere)],
                       check=True, capture_output=True)
        try:
            with self.assertRaises(StoreError):
                self.store.get(a["id"])
            self.assertEqual(self.store.open_path(elsewhere, read_only=True)["id"], a["id"])
        finally:
            junction.rmdir()


if __name__ == "__main__":
    unittest.main()
