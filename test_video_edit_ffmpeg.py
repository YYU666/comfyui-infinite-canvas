"""End-to-end FFmpeg tests on synthetic media (frame index blocks + audio markers)."""
import io
import json
import sys
import tempfile
import unittest
from fractions import Fraction
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from project_store import ProjectStore, StoreError
from video_edit_api import VideoEditAPI
from video_edit_jobs import VideoEditJobs
from video_edit_testmedia import MARK_EVERY, audio_marks, dimensions, has_audio, make_video, read_indices

F24 = {"num": 1, "den": 24}
F2997 = {"num": 1001, "den": 30000}


class VideoEditRenderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory()
        root = Path(cls.temporary.name)
        cls.store = ProjectStore(root / "projects", "video-edit-test")
        cls.project = cls.store.create("视频编辑测试")["id"]
        media = root / "media"
        media.mkdir()
        cls.assets = {}
        for name, kwargs in {
            "v24": {"frames": 120},
            "v24b": {"frames": 72},
            "v2997": {"frames": 150, "fps": Fraction(30000, 1001)},
            "silent": {"frames": 48, "audio": False},
            "big": {"frames": 30, "width": 160, "height": 120},
            "vfr": {"frames": 90, "vfr": True, "audio": False},  # fixture audio would not follow the VFR shifts
        }.items():
            path = make_video(media / f"{name}.mp4", **kwargs)
            with path.open("rb") as stream:
                cls.assets[name] = cls.store.put_asset(cls.project, path.name, stream, "video/mp4")["asset"]["path"]
        cls.jobs = VideoEditJobs(root / "jobs", cls.store)

    @classmethod
    def tearDownClass(cls):
        cls.store.close()
        cls.temporary.cleanup()

    def export(self, clips, inputs, **profile):
        document = {"schemaVersion": 1, "outputProfile": {"fps": {"num": 24, "den": 1}, **profile}, "clips": clips}
        job = self.jobs.submit({"projectId": self.project, "nodeId": "videoEdit-test", "inputs": {slot: self.assets[name] for slot, name in inputs.items()}, "document": document})
        done = self.jobs.wait(job["id"], 300)
        self.assertEqual(done["status"], "completed", done.get("error"))
        return done, self.jobs.output_file(job["id"])

    def assert_audio_sync(self, path, fps, indices, pads=()):
        marks, _ = audio_marks(path, fps, len(indices))
        expected = [index % MARK_EVERY == 0 and position not in pads for position, index in enumerate(indices)]
        for position, flag in enumerate(expected):
            if flag:
                self.assertTrue(any(marks[max(0, position - 1):position + 2]), f"缺少第 {position} 帧的音频标记")
        for position, flag in enumerate(marks):
            if flag:
                self.assertTrue(any(expected[max(0, position - 1):position + 2]), f"第 {position} 帧出现多余音频标记")

    def test_non_keyframe_cut_is_frame_exact(self):
        done, path = self.export([{"id": "a", "inputSlot": "v1", "sourceInPts": 17, "sourceOutPts": 53, "timebase": F24}], {"v1": "v24"})
        indices = read_indices(path)
        self.assertEqual(indices, list(range(17, 53)))  # 17 is not a keyframe (GOP 12)
        self.assertEqual(done["result"]["frames"], 36)
        self.assert_audio_sync(path, Fraction(24), indices)

    def test_default_source_timebase_matches_probe(self):
        info = self.jobs.probe_asset({"projectId": self.project, "assetPath": self.assets["v24"]})
        self.assertEqual((info["frameCount"], info["fps"], info["hasAudio"]), (120, {"num": 24, "den": 1}, True))
        tb = info["timebase"]
        start, end = 5 * tb["den"] // (24 * tb["num"]), 29 * tb["den"] // (24 * tb["num"])
        _, path = self.export([{"id": "a", "inputSlot": "v1", "sourceInPts": start, "sourceOutPts": end}], {"v1": "v24"})
        self.assertEqual(read_indices(path), list(range(5, 29)))

    def test_reverse_then_restore_matches_original(self):
        _, reversed_path = self.export([{"id": "r", "inputSlot": "v1", "sourceInPts": 10, "sourceOutPts": 40, "timebase": F24, "reverse": True}], {"v1": "v24"})
        reversed_indices = read_indices(reversed_path)
        self.assertEqual(reversed_indices, list(range(39, 9, -1)))
        self.assert_audio_sync(reversed_path, Fraction(24), reversed_indices)
        with reversed_path.open("rb") as stream:
            asset = self.store.put_asset(self.project, "reversed.mp4", stream, "video/mp4")["asset"]["path"]
        self.assets["reversed"] = asset
        _, restored = self.export([{"id": "u", "inputSlot": "v1", "sourceInPts": 0, "sourceOutPts": 30, "timebase": F24, "reverse": True}], {"v1": "reversed"})
        restored_indices = read_indices(restored)
        self.assertEqual(restored_indices, list(range(10, 40)))
        self.assert_audio_sync(restored, Fraction(24), restored_indices)

    def test_last_frame_pad_is_exact_and_silent(self):
        _, path = self.export([{"id": "p", "inputSlot": "v1", "sourceInPts": 31, "sourceOutPts": 41, "timebase": F24, "reverse": True, "pad": {"mode": "last_frame", "count": 7}}], {"v1": "v24"})
        indices = read_indices(path)
        self.assertEqual(indices, list(range(40, 30, -1)) + [31] * 7)
        marks, _ = audio_marks(path, Fraction(24), len(indices))
        self.assertFalse(any(marks[11:]), "补帧段必须静音")
        self.assert_audio_sync(path, Fraction(24), indices, pads=set(range(10, 17)))

    def test_multi_clip_concat_sums_and_stays_in_sync(self):
        clips = [{"id": "c1", "inputSlot": "v1", "sourceInPts": 3, "sourceOutPts": 21, "timebase": F24},
                 {"id": "c2", "inputSlot": "v2", "sourceInPts": 40, "sourceOutPts": 67, "timebase": F24},
                 {"id": "c3", "inputSlot": "v1", "sourceInPts": 90, "sourceOutPts": 119, "timebase": F24, "gain": 0.8}]
        done, path = self.export(clips, {"v1": "v24", "v2": "v24b"})
        indices = read_indices(path)
        self.assertEqual(len(indices), 18 + 27 + 29)
        self.assertEqual(indices, list(range(3, 21)) + list(range(40, 67)) + list(range(90, 119)))
        self.assertEqual([clip["timelineStartFrame"] for clip in done["result"]["clips"]], [0, 18, 45])
        self.assert_audio_sync(path, Fraction(24), indices)

    def test_2997_native_and_resampled_to_24(self):
        done, path = self.export([{"id": "n", "inputSlot": "v1", "sourceInPts": 7, "sourceOutPts": 113, "timebase": F2997}], {"v1": "v2997"}, fps={"num": 30000, "den": 1001})
        indices = read_indices(path)
        self.assertEqual(indices, list(range(7, 113)))
        self.assertEqual(done["result"]["timelineTimebase"], F2997)
        self.assert_audio_sync(path, Fraction(30000, 1001), indices)
        cuts = [(0, 37), (37, 101), (101, 150)]
        done, path = self.export([{"id": f"c{i}", "inputSlot": "v1", "sourceInPts": a, "sourceOutPts": b, "timebase": F2997} for i, (a, b) in enumerate(cuts)], {"v1": "v2997"})
        whole, whole_path = self.export([{"id": "w", "inputSlot": "v1", "sourceInPts": 0, "sourceOutPts": 150, "timebase": F2997}], {"v1": "v2997"})
        self.assertEqual(read_indices(path), read_indices(whole_path))  # no per-clip rounding drift
        expected = sum(-(-b * 24 * 1001 // 30000) - -(-a * 24 * 1001 // 30000) for a, b in cuts)
        self.assertEqual(done["result"]["frames"], expected)
        self.assert_audio_sync(path, Fraction(24), read_indices(path))

    def test_variable_frame_rate_uses_one_global_map(self):
        times = [Fraction(j) / 24 + (Fraction(1, 48) if j >= 30 else 0) - (Fraction(j - 60, 96) if j >= 60 else 0) for j in range(90)]
        def nearest(t):
            best = min(range(90), key=lambda j: (abs(times[j] - t), j))
            return best
        cut = [(0, 31), (31, 58), (58, 80)]
        done, path = self.export([{"id": f"c{i}", "inputSlot": "v1", "sourceInPts": a, "sourceOutPts": b, "timebase": F24} for i, (a, b) in enumerate(cut)], {"v1": "vfr"})
        _, whole = self.export([{"id": "w", "inputSlot": "v1", "sourceInPts": 0, "sourceOutPts": 80, "timebase": F24}], {"v1": "vfr"})
        expected = [nearest(Fraction(k, 24)) for k in range(80)]
        self.assertEqual(read_indices(whole), expected)
        self.assertEqual(read_indices(path), expected)
        self.assertEqual(done["result"]["frames"], 80)
        self.assertNotEqual(expected, list(range(80)))  # the source really is VFR

    def test_silent_source_and_mute(self):
        _, path = self.export([{"id": "s", "inputSlot": "v1", "sourceInPts": 0, "sourceOutPts": 24, "timebase": F24}], {"v1": "silent"})
        self.assertFalse(has_audio(path))
        self.assertEqual(len(read_indices(path)), 24)
        _, mixed = self.export([{"id": "s", "inputSlot": "v1", "sourceInPts": 0, "sourceOutPts": 12, "timebase": F24},
                                {"id": "t", "inputSlot": "v2", "sourceInPts": 0, "sourceOutPts": 12, "timebase": F24, "muted": True}], {"v1": "silent", "v2": "v24"})
        self.assertTrue(has_audio(mixed))
        marks, _ = audio_marks(mixed, Fraction(24), 24)
        self.assertFalse(any(marks))
        _, muted = self.export([{"id": "m", "inputSlot": "v1", "sourceInPts": 0, "sourceOutPts": 24, "timebase": F24}], {"v1": "v24"}, audio="mute")
        self.assertFalse(has_audio(muted))

    def test_different_resolution_is_unified_or_rejected(self):
        clips = [{"id": "a", "inputSlot": "v1", "sourceInPts": 0, "sourceOutPts": 10, "timebase": F24},
                 {"id": "b", "inputSlot": "v2", "sourceInPts": 0, "sourceOutPts": 10, "timebase": F24}]
        document = {"schemaVersion": 1, "outputProfile": {"fps": {"num": 24, "den": 1}}, "clips": clips}
        job = self.jobs.submit({"projectId": self.project, "nodeId": "videoEdit-res", "inputs": {"v1": self.assets["v24"], "v2": self.assets["big"]}, "document": document})
        failed = self.jobs.wait(job["id"], 120)
        self.assertEqual(failed["status"], "failed")
        self.assertIn("width", failed["error"])
        _, path = self.export(clips, {"v1": "v24", "v2": "big"}, width=128, height=72)
        self.assertEqual(dimensions(path), (128, 72))
        self.assertEqual(read_indices(path)[:10], list(range(10)))

    def test_external_original_audio_covers_whole_cut(self):
        clips = [{"id": "a", "inputSlot": "v1", "sourceInPts": 24, "sourceOutPts": 48, "timebase": F24, "reverse": True},
                 {"id": "b", "inputSlot": "v1", "sourceInPts": 48, "sourceOutPts": 72, "timebase": F24, "muted": True}]
        done, path = self.export(clips, {"v1": "v24"}, audio="external", audioFrom={"inputSlot": "v1", "sourceInPts": 24, "sourceOutPts": 72, "timebase": F24})
        self.assertEqual(done["result"]["frames"], 48)
        marks, samples = audio_marks(path, Fraction(24), 48)
        self.assertLessEqual(abs(samples - 2 * 48000), 2048)  # AAC frame granularity
        expected = [(24 + position) % MARK_EVERY == 0 for position in range(48)]  # original order, not reversed
        for position, flag in enumerate(expected):
            if flag:
                self.assertTrue(any(marks[max(0, position - 1):position + 2]))
        mismatch = {"inputSlot": "v1", "sourceInPts": 0, "sourceOutPts": 30, "timebase": F24}
        job = self.jobs.submit({"projectId": self.project, "nodeId": "videoEdit-ext", "inputs": {"v1": self.assets["v24"]},
                                "document": {"schemaVersion": 1, "outputProfile": {"audio": "external", "audioFrom": mismatch}, "clips": clips}})
        result = self.jobs.wait(job["id"], 120)
        self.assertEqual(result["status"], "failed")
        self.assertIn("相差一帧以上", result["error"])

    def test_malicious_inputs_are_rejected(self):
        good = {"schemaVersion": 1, "clips": [{"id": "a", "inputSlot": "v1", "sourceInPts": 0, "sourceOutPts": 5, "timebase": F24}]}
        bad_inputs = ["C:/Windows/System32/drivers/etc/hosts", "../../project.json", "assets/../project.json", "http://127.0.0.1:8188/view?filename=x.mp4",
                      "assets/" + "0" * 64 + ".mp4", "/etc/passwd", "assets/" + "a" * 64 + ".exe"]
        for value in bad_inputs:
            with self.subTest(value=value), self.assertRaises(StoreError):
                self.jobs.submit({"projectId": self.project, "nodeId": "videoEdit-x", "inputs": {"v1": value}, "document": good})
        for document in ({**good, "outputProfile": {"filter": "movie=/etc/passwd"}},
                         {**good, "clips": [{**good["clips"][0], "inputSlot": "v1;del"}]},
                         {**good, "clips": [{**good["clips"][0], "sourceOutPts": -3}]}):
            with self.subTest(document=document), self.assertRaises(StoreError):
                self.jobs.submit({"projectId": self.project, "nodeId": "videoEdit-x", "inputs": {"v1": self.assets["v24"]}, "document": document})
        with self.assertRaises(StoreError):
            self.jobs.submit({"projectId": "prj_../../x", "nodeId": "n", "inputs": {"v1": self.assets["v24"]}, "document": good})
        with self.assertRaises(StoreError):
            self.jobs.submit({"projectId": self.project, "nodeId": "n", "inputs": {"v9": self.assets["v24"]}, "document": good})
        job = self.jobs.submit({"projectId": self.project, "nodeId": "videoEdit-oob", "inputs": {"v1": self.assets["v24"]},
                                "document": {**good, "clips": [{**good["clips"][0], "sourceOutPts": 121}]}})
        result = self.jobs.wait(job["id"], 120)
        self.assertEqual(result["status"], "failed")
        self.assertIn("超出", result["error"])

    def test_commit_uses_page_revision_and_cancel_is_scoped(self):
        done, _ = self.export([{"id": "a", "inputSlot": "v1", "sourceInPts": 0, "sourceOutPts": 12, "timebase": F24}], {"v1": "v24"})
        revision = self.store.get(self.project)["revision"]
        with self.assertRaises(StoreError):
            self.jobs.commit(done["id"], {"projectId": self.project, "revision": revision - 1 if revision > 1 else revision + 5})
        saved = self.jobs.commit(done["id"], {"projectId": self.project, "revision": revision})
        self.assertRegex(saved["asset"]["path"], r"^assets/[a-f0-9]{64}\.mp4$")
        self.assertEqual(read_indices(self.store.asset_file(self.project, saved["asset"]["path"])), list(range(12)))
        with self.assertRaises(StoreError):
            self.jobs.commit(done["id"], {"projectId": "prj_other", "revision": saved["revision"]})
        job = self.jobs.submit({"projectId": self.project, "nodeId": "videoEdit-cancel", "inputs": {"v1": self.assets["v24"]},
                                "document": {"schemaVersion": 1, "clips": [{"id": "a", "inputSlot": "v1", "sourceInPts": 0, "sourceOutPts": 120, "timebase": F24}]}})
        self.jobs.cancel(job["id"], self.project)
        self.assertIn(self.jobs.wait(job["id"], 120)["status"], {"cancelled", "completed"})
        with self.assertRaises(StoreError):
            self.jobs.cancel(job["id"], "prj_other")


class FakeHandler:
    def __init__(self, body=b"", headers=None):
        self.rfile = io.BytesIO(body)
        self.headers = {"Content-Length": str(len(body)), **(headers or {})}
        self.sent = None

    def send_json(self, status, payload):
        self.sent = (status, payload)


class VideoEditAPITests(unittest.TestCase):
    def test_routes_and_rejections(self):
        class Jobs:
            def submit(self, payload): return {"id": "ved_" + "0" * 32, "echo": payload}
            def get(self, job_id): raise StoreError("NOT_FOUND", "x", 404)
        api = VideoEditAPI(Jobs())
        self.assertFalse(api.handle_get(FakeHandler(), "/api/projects"))
        handler = FakeHandler(json.dumps({"projectId": "prj_a"}).encode())
        api.handle_post(handler, "/api/video-edit/jobs")
        self.assertEqual(handler.sent[0], 201)
        handler = FakeHandler(b"NaN")
        api.handle_post(handler, "/api/video-edit/jobs")
        self.assertEqual(handler.sent[0], 400)
        handler = FakeHandler()
        api.handle_get(handler, "/api/video-edit/jobs/ved_" + "1" * 32)
        self.assertEqual(handler.sent[0], 404)
        handler = FakeHandler()
        api.handle_get(handler, "/api/video-edit/jobs/../../x")
        self.assertEqual(handler.sent[0], 404)


if __name__ == "__main__":
    unittest.main()
