from __future__ import annotations

import io
import json
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from project_api import ProjectAPI
from project_domain import ProjectDomain
from project_store import ProjectStore, RevisionConflict, StoreError
from video_workbench_launcher import WorkbenchHandler, WorkbenchServer


class ProjectDomainTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.store = ProjectStore(Path(self.temporary.name), "domain-test")
        self.domain = ProjectDomain(self.store)
        self.project = self.store.create("创作层测试")
        self.pid = self.project["id"]
        self.asset = self.store.put_asset(self.pid, "take.png", io.BytesIO(b"image"), "image/png")["asset"]["path"]
        self.project = self.store.get(self.pid)

    def tearDown(self):
        self.store.close()
        self.temporary.cleanup()

    def create(self, collection, **payload):
        result = self.domain.create(self.pid, collection, payload, self.store.get(self.pid)["revision"])
        self.project = result["project"]
        return result["item"]

    def test_character_outfit_location_shot_flow_and_search(self):
        outfit = self.create("outfits", name="雨夜风衣", refs=[self.asset], prompt="深色风衣")
        character = self.create("characters", name="女主", refs=[self.asset], defaultOutfitId=outfit["id"])
        location = self.create("locations", name="旧街", prompt="雨夜霓虹")
        shot = self.create("shots", name="追逐", prompt="雨夜中回头", characterId=character["id"], outfitId=outfit["id"], locationId=location["id"], tags=["雨夜"])
        self.assertEqual(shot["params"]["ratio"], "16:9")
        self.assertEqual(shot["number"], "S01")
        results = self.domain.search(self.store.get(self.pid), "雨夜")
        self.assertEqual({row["kind"] for row in results}, {"outfit", "location", "shot"})
        with self.assertRaises(StoreError) as caught:
            self.domain.delete(self.pid, "characters", character["id"], self.project["revision"])
        self.assertEqual(caught.exception.code, "ENTITY_IN_USE")

    def test_six_takes_selection_rejection_notes_and_export_contract(self):
        shot = self.create("shots", name="六条审片", prompt="雨夜")
        takes = []
        for index in range(6):
            result = self.domain.create_take(self.pid, shot["id"], {"asset": self.asset, "recipe": {"seed": index}}, self.project["revision"])
            self.project = result["project"]
            takes.append(result["item"])
        for take in takes:
            result = self.domain.update_take(self.pid, shot["id"], take["id"], {"rating": 4, "notes": "雨夜候选", "tags": ["候选"]}, self.project["revision"])
            self.project = result["project"]
        result = self.domain.update_take(self.pid, shot["id"], "t4", {"selected": True}, self.project["revision"])
        self.project = result["project"]
        result = self.domain.update_take(self.pid, shot["id"], "t6", {"selected": True}, self.project["revision"])
        self.project = result["project"]
        selected = [take["id"] for take in self.project["shots"][0]["takes"] if take["selected"]]
        self.assertEqual(selected, ["t6"])
        result = self.domain.update_take(self.pid, shot["id"], "t1", {"rejected": True}, self.project["revision"])
        self.assertTrue(result["item"]["rejected"])
        self.assertTrue(any(row["kind"] == "take" for row in self.domain.search(result["project"], "雨夜候选")))

    def test_deleted_ids_are_not_reused_and_conflicts_are_preserved(self):
        first = self.create("characters", name="第一位")
        self.project = self.domain.delete(self.pid, "characters", first["id"], self.project["revision"])["project"]
        second = self.create("characters", name="第二位")
        self.assertEqual((first["id"], second["id"]), ("c1", "c2"))
        with self.assertRaises(RevisionConflict):
            self.domain.update(self.pid, "characters", second["id"], {"name": "旧窗口"}, 1)
        self.assertEqual(self.store.get(self.pid)["characters"][0]["name"], "第二位")

    def test_invalid_assets_ratings_and_links_are_rejected(self):
        with self.assertRaises(StoreError):
            self.create("characters", name="坏引用", refs=["assets/" + "0" * 64 + ".png"])
        shot = self.create("shots", name="输入检查")
        with self.assertRaises(StoreError):
            self.domain.create_take(self.pid, shot["id"], {"asset": self.asset, "rating": 6}, self.project["revision"])
        with self.assertRaises(StoreError):
            self.create("shots", name="不存在角色", characterId="c404")


class ProjectDomainAPITests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.store = ProjectStore(Path(self.temporary.name), "api-test")
        self.project = self.store.create("接口测试")
        self.server = WorkbenchServer(("127.0.0.1", 0), WorkbenchHandler)
        self.server.token = "domain-test-token"
        self.server.project_store = self.store
        self.server.project_api = ProjectAPI(self.store)
        self.server.queue_api = type("UnusedQueueAPI", (), {"handle_get": lambda *_: False, "handle_post": lambda *_: False})()
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.origin = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.store.close()
        self.temporary.cleanup()

    def request(self, method, path, body=None, revision=None):
        headers = {"X-H3-Token": self.server.token}
        if revision is not None:
            headers["If-Match"] = str(revision)
        data = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(body).encode("utf-8")
        request = urllib.request.Request(self.origin + path, method=method, data=data, headers=headers)
        with urllib.request.urlopen(request, timeout=3) as response:
            return response.status, json.load(response)

    def test_http_crud_take_search_and_cas(self):
        pid = self.project["id"]
        revision = self.project["revision"]
        for collection, name in (("characters", "角色"), ("outfits", "服装"), ("locations", "雨夜街道")):
            status, result = self.request("POST", f"/api/projects/{pid}/{collection}", {"name": name, "revision": revision})
            self.assertEqual(status, 201)
            revision = result["project"]["revision"]
        status, result = self.request("POST", f"/api/projects/{pid}/shots", {"name": "雨夜镜头", "characterId": "c1", "outfitId": "o1", "locationId": "l1", "revision": revision})
        self.assertEqual(status, 201)
        revision = result["project"]["revision"]
        status, result = self.request("PUT", f"/api/projects/{pid}/shots/s1", {"prompt": "雨夜奔跑", "tags": ["夜景"], "revision": revision})
        revision = result["project"]["revision"]
        status, result = self.request("GET", f"/api/projects/{pid}/search?q=%E9%9B%A8%E5%A4%9C")
        self.assertEqual(result["count"], 2)
        self.assertEqual({row["kind"] for row in result["results"]}, {"location", "shot"})
        status, result = self.request("PUT", f"/api/projects/{pid}/metadata", {"tags": ["短片"], "favorite": True, "revision": revision})
        self.assertTrue(result["item"]["favorite"])
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.request("PUT", f"/api/projects/{pid}/shots/s1", {"name": "过期写入", "revision": 1})
        self.assertEqual(caught.exception.code, 409)
        status, result = self.request("DELETE", f"/api/projects/{pid}/shots/s1", revision=result["project"]["revision"])
        self.assertEqual(result["project"]["shots"], [])


if __name__ == "__main__":
    unittest.main()
