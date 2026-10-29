from __future__ import annotations

import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))

from agent_mcp import TOOLS
from agent_protocol import AgentProtocol, estimate_tokens
from project_domain import ProjectDomain
from project_store import ProjectStore, RevisionConflict, StoreError
from workbench_queue import QueueManager


_png_buffer = io.BytesIO()
Image.new("RGB", (8, 8), "#63768a").save(_png_buffer, "PNG")
PNG = _png_buffer.getvalue()


class FakeAdapter:
    def __init__(self):
        self.submissions = 0
        self.uploads = []
        self.preflights = []
        self.preflight_error = None

    def submit(self, workflow, client_id):
        self.submissions += 1
        return f"prompt-{self.submissions}"

    def poll(self, prompt_id):
        entry = {"status": {"completed": True, "status_str": "success"}, "outputs": {"save": {"images": [{"filename": "H3_Agent_Test.png", "subfolder": "", "type": "output"}]}}}
        return {"status": "done", "progress": 100, "history": entry, "outputs": entry["outputs"]}

    def upload_image(self, filename, content):
        self.uploads.append((filename, content))
        return f"workbench/{filename}"

    def preflight(self, workflow):
        self.preflights.append(workflow)
        if self.preflight_error:
            raise ValueError(self.preflight_error)
        return {"nodes": len(workflow), "models": []}

    def cancel(self, prompt_id):
        return None


class AgentProtocolTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        root = Path(self.temporary.name)
        self.store = ProjectStore(root / "projects", "agent-test")
        self.adapter = FakeAdapter()
        self.queue = QueueManager(root / "queue.json", adapter=self.adapter, poll_interval=0.01)
        self.queue.start()
        self.protocol = AgentProtocol(self.store, self.queue)

    def tearDown(self):
        self.queue.stop()
        self.store.close()
        self.temporary.cleanup()

    def test_fixture_budgets_handles_increment_and_conflict(self):
        nodes = []
        for index in range(200):
            kind = "generator" if index % 4 == 0 else "media"
            nodes.append({"id": f"old-{index}", "type": kind, "position": {"x": index * 20, "y": 0},
                          "data": {"title": f"N{index}", "mode": "reference" if kind == "generator" else None,
                                   "kind": "image" if kind == "media" else None, "status": "idle", "prompt": "长提示词" * 100}})
        document = self.store.create("200 节点基准", {"nodes": nodes, "edges": [], "viewport": {"x": 0, "y": 0, "zoom": 1}})
        pid = document["id"]
        digest = self.protocol.state(pid)
        self.assertLessEqual(digest["meta"]["estTokens"], 100, digest)
        self.assertIn("nodes=200", digest["digest"])
        query = self.protocol.query(pid, {"fields": ["handle", "title", "status"], "limit": 5})
        self.assertLessEqual(query["meta"]["estTokens"], 150, query)
        self.assertEqual(len(query["rows"]), 5)
        self.assertEqual(query["rows"][0]["handle"], "g1")
        receipt = self.protocol.apply(pid, {"opId": "budget-set", "ops": [{"op": "set", "target": "g1", "settings": {"seed": 42}}]})
        self.assertLessEqual(receipt["meta"]["estTokens"], 30, receipt)
        increment = self.protocol.state(pid, since=1)
        self.assertEqual(increment["changed"], ["g1"])
        self.assertEqual(self.protocol.state(pid, since=receipt["rev"])["unchanged"], True)
        before = self.store.get(pid)
        with self.assertRaises(RevisionConflict):
            self.protocol.apply(pid, {"opId": "stale", "revision": 1, "ops": [{"op": "set", "target": "g1", "settings": {"seed": 99}}]})
        after = self.store.get(pid)
        self.assertEqual(before["canvas"]["nodes"][0]["data"]["seed"], 42)
        self.assertEqual(after["canvas"]["nodes"][0]["data"]["seed"], 42)
        self.assertLessEqual(estimate_tokens({"tools": TOOLS}), 600)

    def test_apply_four_ops_idempotent_and_wait(self):
        document = self.store.create("批量生成")
        pid = document["id"]
        result = self.protocol.apply(pid, {"opId": "four-ops", "ops": [
            {"op": "create", "preset": "text_video", "title": "批量镜头", "prompt": "雨夜"},
            {"op": "create", "preset": "prompt_optimizer", "title": "提示"},
            {"op": "connect", "from": "p1", "to": "g1", "port": "prompt"},
            {"op": "set", "target": "g1", "settings": {"seed": 7}},
            {"op": "generate", "target": "g1"},
        ]})
        job = next(item["job"] for item in result["results"] if "job" in item)
        waited = self.protocol.wait(pid, [job], 2000)
        self.assertEqual(waited["jobs"][0]["status"], "done")
        self.assertLessEqual(waited["meta"]["estTokens"], 50, waited)
        replay = self.protocol.apply(pid, {"opId": "four-ops", "ops": [{"op": "delete", "target": "g1"}]})
        self.assertTrue(replay["idempotent"])
        self.assertEqual(self.adapter.submissions, 1)
        self.assertEqual(self.protocol.prompt_get(pid, self.protocol.query(pid, {"fields": ["prompt"], "where": {"handle": "g1"}})["rows"][0]["prompt"]["hash"])["text"], "雨夜")

    def test_semantic_full_chain_without_browser(self):
        document = self.store.create("语义全链路")
        pid = document["id"]
        asset = self.store.put_asset(pid, "reference.png", io.BytesIO(PNG), "image/png")["asset"]["path"]
        revision = self.store.get(pid)["revision"]
        for collection, name in (("characters", "男主"), ("outfits", "夏装"), ("locations", "海边")):
            result = self.protocol.domain.create(pid, collection, {"name": name, "refs": [asset]}, revision)
            revision = result["project"]["revision"]
        result = self.protocol.apply(pid, {"opId": "semantic-generate", "ops": [
            {"op": "shot.create", "character": "c1", "outfit": "o1", "location": "l1", "prompt": "看向镜头", "duration": 5},
            {"op": "generate", "target": "s1"},
        ]})
        self.assertEqual(len(self.adapter.uploads), 1, "相同素材只上传一次")
        self.assertEqual(len(self.store.get(pid)["canvas"]["edges"]), 1, "相同素材只展开一条去重参考连线")
        job = next(item["job"] for item in result["results"] if "job" in item)
        waited = self.protocol.wait(pid, job, 2000)
        self.assertEqual(waited["jobs"][0]["status"], "done")
        self.assertEqual(waited["jobs"][0]["takes"], ["t1"])
        document = self.store.get(pid)
        shot = document["shots"][0]
        self.assertEqual((shot["characterId"], shot["outfitId"], shot["locationId"]), ("c1", "o1", "l1"))
        self.assertEqual(shot["takes"][0]["recipe"]["output"]["filename"], "H3_Agent_Test.png")
        self.assertEqual(len(document["assets"]), 1)
        self.protocol.apply(pid, {"opId": "select", "ops": [{"op": "take.rate", "shot": "s1", "take": "t1", "rating": 5}, {"op": "take.select", "shot": "s1", "take": "t1"}]})
        # Export uses the existing local-asset path; external download is covered by delivery tests.
        document = self.store.get(pid)
        document["shots"][0]["takes"][0]["asset"] = asset
        self.store.save(pid, document, document["revision"])
        exported = self.protocol.apply(pid, {"opId": "export", "ops": [{"op": "delivery.export"}]})
        self.assertEqual(exported["results"][0]["export"]["count"], 1)

    def test_pending_business_checkpoint_recovers_after_exception_and_system_exit(self):
        for failure in (RuntimeError("injected"), SystemExit("injected")):
            with self.subTest(failure=type(failure).__name__):
                document = self.store.create(f"业务边界-{type(failure).__name__}")
                pid = document["id"]
                original_save = self.store.save
                injected = [False]

                def failing_save(*args, **kwargs):
                    saved = original_save(*args, **kwargs)
                    pending = saved["settings"].get("agentOperations", {}).get("recover-business", {})
                    if pending.get("phase") == "business" and not injected[0]:
                        injected[0] = True
                        raise failure
                    return saved

                self.store.save = failing_save
                with self.assertRaises(type(failure)):
                    self.protocol.apply(pid, {"opId": "recover-business", "ops": [{"op": "create", "preset": "text_video"}]})
                self.store.save = original_save
                pending = self.store.get(pid)["settings"]["agentOperations"]["recover-business"]
                self.assertEqual(pending["status"], "pending")
                receipt = self.protocol.apply(pid, {"opId": "recover-business", "ops": [{"op": "create", "preset": "text_video"}]})
                self.assertTrue(receipt["ok"])
                self.assertEqual(len(self.store.get(pid)["canvas"]["nodes"]), 1)

    def test_generate_crash_after_enqueue_recovers_exactly_one_job(self):
        document = self.store.create("生成边界恢复")
        pid = document["id"]
        original_enqueue = self.queue.enqueue
        injected = [False]

        def failing_enqueue(payload):
            job = original_enqueue(payload)
            if payload.get("clientId", "").endswith(":1") and not injected[0]:
                injected[0] = True
                raise SystemExit("process lost after enqueue")
            return job

        self.queue.enqueue = failing_enqueue
        payload = {"opId": "recover-generate", "ops": [{"op": "create", "preset": "text_video"}, {"op": "generate", "target": "g1"}]}
        with self.assertRaises(SystemExit):
            self.protocol.apply(pid, payload)
        self.queue.enqueue = original_enqueue
        self.assertEqual(self.store.get(pid)["settings"]["agentOperations"]["recover-generate"]["status"], "pending")
        receipt = self.protocol.apply(pid, payload)
        job_rows = [item for item in receipt["results"] if "job" in item]
        self.assertEqual(len(job_rows), 1)
        jobs = [job for job in self.queue.snapshot()["jobs"] if job.get("projectId") == pid]
        self.assertEqual(len(jobs), 1)
        self.assertEqual(jobs[0]["id"], job_rows[0]["job"])
        self.assertEqual(self.store.get(pid)["canvas"]["nodes"][0]["data"]["queueJobId"], jobs[0]["id"])
        replay = self.protocol.apply(pid, payload)
        self.assertTrue(replay["idempotent"])
        self.assertEqual(len([job for job in self.queue.snapshot()["jobs"] if job.get("projectId") == pid]), 1)

    def test_wait_rejects_other_project_without_any_write(self):
        first = self.store.create("项目 A")
        second = self.store.create("项目 B")
        result = self.protocol.apply(first["id"], {"opId": "job-a", "ops": [{"op": "shot.create"}, {"op": "generate", "target": "s1"}]})
        job_id = next(item["job"] for item in result["results"] if "job" in item)
        before_first = self.store.get(first["id"])
        before_second = self.store.get(second["id"])
        with self.assertRaises(StoreError) as caught:
            self.protocol.wait(second["id"], job_id, 0)
        self.assertEqual(caught.exception.code, "JOB_PROJECT_CONFLICT")
        self.assertEqual(self.store.get(first["id"]), before_first)
        self.assertEqual(self.store.get(second["id"]), before_second)

    def test_multi_output_recovery_and_repeated_wait_are_exactly_once(self):
        document = self.store.create("多输出归档")
        pid = document["id"]
        self.protocol.apply(pid, {"opId": "shot-multi", "ops": [{"op": "shot.create"}]})
        document = self.store.get(pid)
        job = {"id": "job_multi", "projectId": pid, "shotId": "s1", "nodeId": document["shots"][0]["canvasNodeId"],
               "status": "done", "attempts": 1, "comfyPromptId": "prompt_multi",
               "history": {"outputs": {"save": {"images": [
                   {"filename": "one.png", "subfolder": "", "type": "output"},
                   {"filename": "two.png", "subfolder": "", "type": "output"},
               ]}}}}
        original_create = self.protocol.domain.create_take
        calls = [0]

        def failing_create(*args, **kwargs):
            result = original_create(*args, **kwargs)
            calls[0] += 1
            if calls[0] == 1:
                raise SystemExit("lost after first output")
            return result

        self.protocol.domain.create_take = failing_create
        with self.assertRaises(SystemExit):
            self.protocol._materialize(pid, job)
        self.protocol.domain.create_take = original_create
        expected = None
        for _ in range(10):
            takes = self.protocol._materialize(pid, job)
            if expected is None:
                expected = takes
            self.assertEqual(takes, expected)
        document = self.store.get(pid)
        self.assertEqual(len(document["shots"][0]["takes"]), 2)
        self.assertTrue(all(take["asset"].startswith("comfy://view?") for take in document["shots"][0]["takes"]))
        self.assertEqual(len({take["recipe"]["outputIdentity"] for take in document["shots"][0]["takes"]}), 2)
        self.assertFalse(any("assets/agent-" in take["asset"] for take in document["shots"][0]["takes"]))
        source = next(node for node in document["canvas"]["nodes"] if node["id"] == job["nodeId"])
        self.assertEqual((source["data"]["status"], source["data"]["progress"]), ("done", 100))

    def test_same_filename_in_different_output_directories_creates_distinct_takes(self):
        document = self.store.create("输出完整身份")
        pid = document["id"]
        self.protocol.apply(pid, {"opId": "shot-output-identity", "ops": [{"op": "shot.create"}]})
        document = self.store.get(pid)
        job = {"id": "job_identity", "projectId": pid, "shotId": "s1", "nodeId": document["shots"][0]["canvasNodeId"],
               "status": "done", "attempts": 2, "comfyPromptId": "prompt_identity",
               "history": {"outputs": {"save": {"images": [
                   {"filename": "same.png", "subfolder": "first", "type": "output"},
                   {"filename": "same.png", "subfolder": "second", "type": "output"},
               ]}}}}
        self.assertEqual(len(self.protocol._materialize(pid, job)), 2)
        self.assertEqual(len(self.protocol._materialize(pid, job)), 2, "repeated completion remains idempotent")
        takes = self.store.get(pid)["shots"][0]["takes"]
        self.assertEqual(len(takes), 2)
        self.assertEqual({take["recipe"]["attempt"] for take in takes}, {2})
        self.assertEqual({take["recipe"]["output"]["subfolder"] for take in takes}, {"first", "second"})

    def test_dry_run_builds_workflow_without_side_effects(self):
        document = self.store.create("预检无副作用")
        pid = document["id"]
        self.protocol.apply(pid, {"opId": "dry-shot", "ops": [{"op": "shot.create", "prompt": "中文😀"}]})
        before = self.store.get(pid)
        jobs_before = len(self.queue.snapshot()["jobs"])
        uploads_before = len(self.adapter.uploads)
        result = self.protocol.apply(pid, {"opId": "dry-generate", "dryRun": True, "ops": [{"op": "generate", "target": "s1"}]})
        self.assertTrue(result["dryRun"])
        self.assertEqual(self.store.get(pid)["revision"], before["revision"])
        self.assertEqual(self.store.get(pid)["settings"].get("agentOperations"), before["settings"].get("agentOperations"))
        self.assertEqual(len(self.queue.snapshot()["jobs"]), jobs_before)
        self.assertEqual(len(self.adapter.uploads), uploads_before)
        self.assertEqual(self.store.get(pid)["shots"][0]["takes"], [])
        self.assertEqual(len(self.adapter.preflights), 1)

    def test_dry_run_rejects_missing_model_without_side_effects(self):
        document = self.store.create("预检拒绝缺模型")
        pid = document["id"]
        self.protocol.apply(pid, {"opId": "dry-model-shot", "ops": [{"op": "shot.create"}]})
        before = self.store.get(pid)
        self.adapter.preflight_error = "ComfyUI 缺少模型或 LoRA：missing.safetensors"
        with self.assertRaises(StoreError) as caught:
            self.protocol.apply(pid, {"opId": "dry-model", "dryRun": True, "ops": [{"op": "generate", "target": "s1"}]})
        self.assertEqual(caught.exception.code, "PREFLIGHT_FAILED")
        self.assertEqual(self.store.get(pid), before)
        self.assertEqual(self.queue.snapshot()["jobs"], [])
        self.assertEqual(self.adapter.submissions, 0)


if __name__ == "__main__":
    unittest.main()
