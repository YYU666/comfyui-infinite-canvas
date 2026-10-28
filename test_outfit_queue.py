import sys
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_workbench_queue import wait_for
from workbench_queue import ComfyQueueAdapter, QueueManager


class EmptyResponse:
    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def read(self):
        return b""


class FakeOutfitAdapter:
    def __init__(self):
        self.submitted = []
        self.uploads = []
        self.downloads = []
        self.free_calls = 0
        self.results = {}
        self.done = True

    def submit(self, workflow, client_id):
        prompt_id = f"prompt-{len(self.submitted) + 1}"
        prefix = workflow["save"]["inputs"]["filename_prefix"].split("/")[-1]
        width, height = (768, 768) if prefix == "H3_OutfitSingle_tl" else (1200, 800)
        if prefix.startswith("H3_OutfitHD"):
            width, height = 1152, 1152
        file = {
            "filename": f"{prefix}_00001_.png", "subfolder": "image", "type": "output",
            "metadata": {"kind": "image", "width": width, "height": height},
        }
        outputs = {"save": {"images": [file]}}
        self.submitted.append({"id": prompt_id, "workflow": workflow, "clientId": client_id})
        self.results[prompt_id] = outputs
        return prompt_id

    def poll(self, prompt_id):
        if not self.done:
            return {"status": "running", "progress": 40}
        outputs = self.results[prompt_id]
        return {"status": "done", "progress": 100, "outputs": outputs, "history": {"status": {"completed": True}, "outputs": outputs}}

    def download(self, file):
        self.downloads.append(file["filename"])
        return b"fake-image"

    def upload_image(self, filename, content):
        name = f"workbench/{filename}"
        self.uploads.append({"name": name, "content": content})
        return name

    def free(self):
        self.free_calls += 1

    def cancel(self, prompt_id):
        pass


def single(panel_id):
    return {"save": {"class_type": "SaveImage", "inputs": {"filename_prefix": f"image/H3_OutfitSingle_{panel_id}"}}}


def hd(panel_id):
    return {
        "source": {"class_type": "LoadImage", "inputs": {"image": "__H3_OUTFIT_CURRENT__"}},
        "save": {"class_type": "SaveImage", "inputs": {"filename_prefix": f"image/H3_OutfitHD_{panel_id}"}},
    }


def plan(selected=None):
    panel_ids = [selected] if selected else ["tl", "tr"]
    images = {panel_id: f"__H3_OUTFIT_PANEL_{panel_id}__" for panel_id in panel_ids}
    stitch = None if selected else {
        "tl_load": {"class_type": "LoadImage", "inputs": {"image": images["tl"]}},
        "tr_load": {"class_type": "LoadImage", "inputs": {"image": images["tr"]}},
        "save": {"class_type": "SaveImage", "inputs": {"filename_prefix": "image/H3_OutfitQuad"}},
    }
    return {
        "kind": "outfit", "selectedPanel": selected, "stitch": stitch,
        "panels": [{"id": panel_id, "label": panel_id, "single": single(panel_id), "hd": hd(panel_id)} for panel_id in panel_ids],
    }


class OutfitQueueTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.adapter = FakeOutfitAdapter()
        self.manager = QueueManager(Path(self.temporary.name) / "queue.json", self.adapter, poll_interval=0.01)

    def tearDown(self):
        self.manager.stop()
        self.temporary.cleanup()

    def test_hd_only_below_1k_then_stitch_and_recover_final_history(self):
        job = self.manager.enqueue({"projectId": "prj_test", "nodeId": "outfit-1", "clientId": "client-test", "plan": plan()})
        self.manager.start()
        wait_for(lambda: self.manager.get(job["id"])["status"] == "done")
        result = self.manager.get(job["id"])
        prefixes = [item["workflow"]["save"]["inputs"]["filename_prefix"] for item in self.adapter.submitted]
        self.assertEqual(prefixes, ["image/H3_OutfitSingle_tl", "image/H3_OutfitHD_tl", "image/H3_OutfitSingle_tr", "image/H3_OutfitQuad"])
        self.assertEqual(self.adapter.submitted[1]["workflow"]["source"]["inputs"]["image"], "workbench/H3_OutfitSingle_tl_00001_.png")
        stitched = self.adapter.submitted[3]["workflow"]
        self.assertEqual(stitched["tl_load"]["inputs"]["image"], "workbench/H3_OutfitHD_tl_00001_.png")
        self.assertEqual(stitched["tr_load"]["inputs"]["image"], "workbench/H3_OutfitSingle_tr_00001_.png")
        self.assertEqual(result["progress"], 100)
        self.assertEqual(result["comfyPromptId"], "prompt-4")
        self.assertEqual(result["planState"]["promptIds"], ["prompt-1", "prompt-2", "prompt-3", "prompt-4"])
        self.assertEqual(result["history"]["outputs"]["save"]["images"][0]["filename"], "H3_OutfitQuad_00001_.png")
        self.assertEqual(self.adapter.free_calls, 3)
        self.assertNotIn("plan", result)
        self.assertNotIn("workflow", result)

    def test_single_native_panel_finishes_without_stitch_or_hd(self):
        job = self.manager.enqueue({"projectId": "prj_test", "nodeId": "outfit-2", "plan": plan("tr")})
        self.manager.start()
        wait_for(lambda: self.manager.get(job["id"])["status"] == "done")
        result = self.manager.get(job["id"])
        self.assertEqual(len(self.adapter.submitted), 1)
        self.assertEqual(result["history"]["outputs"]["save"]["images"][0]["filename"], "H3_OutfitSingle_tr_00001_.png")
        self.assertEqual(result["planState"]["images"]["tr"], "workbench/H3_OutfitSingle_tr_00001_.png")

    def test_restart_recovers_submitted_stage_without_duplicate(self):
        self.adapter.done = False
        job = self.manager.enqueue({"projectId": "prj_test", "nodeId": "outfit-3", "plan": plan()})
        self.manager.start()
        wait_for(lambda: len(self.adapter.submitted) == 1)
        self.manager.stop()
        self.adapter.done = True
        recovered = QueueManager(Path(self.temporary.name) / "queue.json", self.adapter, poll_interval=0.01)
        self.manager = recovered
        recovered.start()
        wait_for(lambda: recovered.get(job["id"])["status"] == "done")
        self.assertEqual(len(self.adapter.submitted), 4)
        self.assertEqual([item["id"] for item in self.adapter.submitted], ["prompt-1", "prompt-2", "prompt-3", "prompt-4"])
        self.assertEqual(recovered.get(job["id"])["planState"]["promptIds"], ["prompt-1", "prompt-2", "prompt-3", "prompt-4"])

    def test_free_accepts_comfy_empty_success_response(self):
        adapter = ComfyQueueAdapter()
        with patch.object(adapter, "_request", return_value={"queue_running": [], "queue_pending": []}), patch("urllib.request.urlopen", return_value=EmptyResponse()) as open_url:
            self.assertTrue(adapter.free())
        request = open_url.call_args.args[0]
        self.assertTrue(request.full_url.endswith("/free"))

    def test_invalid_plan_is_rejected(self):
        with self.assertRaises(ValueError):
            self.manager.enqueue({"plan": {"kind": "outfit", "panels": []}})


if __name__ == "__main__":
    unittest.main()
