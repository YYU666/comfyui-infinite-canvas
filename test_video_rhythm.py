"""Curve math and FFmpeg checks for constant speed and time remap."""
import sys
import tempfile
import unittest
from fractions import Fraction
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from project_store import ProjectStore
from video_edit_testmedia import has_audio, make_video, read_indices
from video_rhythm_document import (
    RhythmDocumentError,
    normalize_remap_document,
    normalize_speed_document,
    remap_frame_indices,
    sample_source_time,
    speed_frame_indices,
    speed_rate,
)
from video_rhythm_ffmpeg import atempo_filter
from video_rhythm_jobs import VideoRhythmJobs
from video_edit_ffmpeg import Runner, probe


def speed_doc(speed=0.5, audio="preserve"):
    return {"schemaVersion": 1, "operation": "speed", "speed": speed, "audio": audio}


def remap_doc(keyframes):
    return {"schemaVersion": 1, "operation": "remap", "keyframes": keyframes}


def freeze_keys():
    return [
        {"output": 0, "source": 0, "interpolation": "linear"},
        {"output": 2, "source": 2, "interpolation": "linear"},
        {"output": 3, "source": 2, "interpolation": "linear"},
    ]


class CurveTests(unittest.TestCase):
    def test_speed_normalizes_common_rates(self):
        self.assertEqual(normalize_speed_document(speed_doc(0.5))["speed"], {"num": 1, "den": 2})
        self.assertEqual(normalize_speed_document(speed_doc(2))["speed"], {"num": 2, "den": 1})
        self.assertEqual(normalize_speed_document(speed_doc(1))["audio"], "preserve")

    def test_speed_indices_hold_or_skip_frames(self):
        slow = speed_frame_indices(24, Fraction(1, 2))
        fast = speed_frame_indices(24, Fraction(2, 1))
        self.assertEqual(slow, [index // 2 for index in range(48)])
        self.assertEqual(fast, [index * 2 for index in range(12)])
        self.assertEqual(speed_frame_indices(24, Fraction(1, 1)), list(range(24)))

    def test_flat_segment_is_a_one_second_freeze(self):
        document = normalize_remap_document(remap_doc(freeze_keys()))
        self.assertEqual(sample_source_time(document["keyframes"], Fraction(0)), 0)
        self.assertEqual(sample_source_time(document["keyframes"], Fraction(2)), 2)
        self.assertEqual(sample_source_time(document["keyframes"], Fraction(5, 2)), 2)
        self.assertEqual(sample_source_time(document["keyframes"], Fraction(71, 24)), 2)
        probe_info = {"frameCount": 96, "frameTimes": [Fraction(index, 24) for index in range(96)],
                      "duration": Fraction(96, 24), "frameTimebase": Fraction(1, 24), "width": 128, "height": 72}
        indices = remap_frame_indices(probe_info, document["keyframes"])
        self.assertEqual(indices, list(range(48)) + [48] * 24)

    def test_ease_changes_slope_but_not_a_freeze(self):
        ramp = normalize_remap_document(remap_doc([
            {"output": 0, "source": 0, "interpolation": "easeInOut"},
            {"output": 4, "source": 2},
        ]))["keyframes"]
        self.assertAlmostEqual(float(sample_source_time(ramp, 1)), 2 * (0.25 ** 2) * (3 - 2 * 0.25), places=6)
        self.assertNotAlmostEqual(float(sample_source_time(ramp, 1)), 0.5, places=3)
        self.assertEqual(float(sample_source_time(ramp, 0)), 0)
        self.assertEqual(float(sample_source_time(ramp, 4)), 2)
        frozen = normalize_remap_document(remap_doc([
            {"output": 0, "source": 2, "interpolation": "easeInOut"},
            {"output": 1, "source": 2},
        ]))["keyframes"]
        self.assertEqual(sample_source_time(frozen, Fraction(1, 2)), 2)

    def test_rejects_filters_paths_and_reverse(self):
        for bad in (
            {**speed_doc(), "filter": "atempo=2"},
            {**speed_doc(), "path": "C:/secret.mp4"},
            speed_doc(0),
            speed_doc(8),
            speed_doc(float("nan")),
            remap_doc([{"output": 0, "source": 1}, {"output": 1, "source": 0}]),
            remap_doc([{"output": 1, "source": 0}, {"output": 2, "source": 1}]),
            remap_doc([{"output": 0, "source": 0, "interpolation": "expression"}]),
        ):
            with self.assertRaises(RhythmDocumentError):
                if "speed" in bad and "keyframes" not in bad:
                    normalize_speed_document(bad)
                else:
                    normalize_remap_document(bad)

    def test_atempo_chain_is_a_plain_decimal(self):
        self.assertEqual(atempo_filter(Fraction(1, 2)), "atempo=0.5")
        self.assertEqual(atempo_filter(Fraction(2, 1)), "atempo=2.0")
        self.assertEqual(atempo_filter(Fraction(1, 4)), "atempo=0.5,atempo=0.5")
        with self.assertRaises(ValueError):
            atempo_filter("0.5;rm -rf")


class FfmpegRhythmTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory()
        root = Path(cls.temporary.name)
        cls.store = ProjectStore(root / "projects", "video-rhythm-test")
        cls.project = cls.store.create("节奏测试")["id"]
        media = root / "media"
        media.mkdir()
        cls.assets = {}
        for name, frames in {"short": 24, "hold": 96}.items():
            path = make_video(media / f"{name}.mp4", frames=frames, text=False)
            with path.open("rb") as stream:
                cls.assets[name] = cls.store.put_asset(cls.project, path.name, stream, "video/mp4")["asset"]["path"]
        cls.jobs = VideoRhythmJobs(root / "jobs", cls.store)

    @classmethod
    def tearDownClass(cls):
        cls.store.close()
        cls.temporary.cleanup()

    def export(self, name, operation, settings):
        job = self.jobs.submit({"projectId": self.project, "nodeId": "videoSpeed-test", "input": self.assets[name], "operation": operation, "settings": settings})
        done = self.jobs.wait(job["id"], 180)
        self.assertEqual(done["status"], "completed", done.get("error"))
        return done, self.jobs.output_file(job["id"])

    def test_ffmpeg_speed_and_freeze_match_frame_indices(self):
        slow, slow_path = self.export("short", "speed", {"schemaVersion": 1, "speed": 0.5, "audio": "mute"})
        self.assertEqual(read_indices(slow_path), [index // 2 for index in range(48)])
        self.assertEqual(slow["result"]["frames"], 48)
        self.assertEqual(slow["result"]["audio"], "mute")
        self.assertFalse(has_audio(slow_path))
        fast, fast_path = self.export("short", "speed", {"schemaVersion": 1, "speed": 2, "audio": "preserve"})
        self.assertEqual(read_indices(fast_path), [index * 2 for index in range(12)])
        self.assertEqual(fast["result"]["audio"], "preserve")
        self.assertTrue(has_audio(fast_path))
        frozen, frozen_path = self.export("hold", "remap", {"schemaVersion": 1, "keyframes": freeze_keys()})
        self.assertEqual(read_indices(frozen_path), list(range(48)) + [48] * 24)
        self.assertEqual(frozen["result"]["frames"], 72)
        self.assertEqual(frozen["result"]["audio"], "mute")

    def test_eased_ramp_is_not_linear_and_is_what_ffmpeg_writes(self):
        keyframes = [
            {"output": 0, "source": 0, "interpolation": "easeIn"},
            {"output": 2, "source": 2, "interpolation": "linear"},
        ]
        info = probe(Runner(), self.jobs.store.asset_file(self.project, self.assets["hold"]))
        eased = remap_frame_indices(info, normalize_remap_document(remap_doc(keyframes))["keyframes"])
        linear = remap_frame_indices(info, normalize_remap_document(remap_doc([
            {"output": 0, "source": 0, "interpolation": "linear"},
            {"output": 2, "source": 2},
        ]))["keyframes"])
        self.assertNotEqual(eased, linear)
        _, path = self.export("hold", "remap", {"schemaVersion": 1, "keyframes": keyframes})
        self.assertEqual(read_indices(path), eased)

    def test_speed_rate_used_by_render_matches_document(self):
        document = normalize_speed_document(speed_doc(0.5))
        self.assertEqual(speed_rate(document), Fraction(1, 2))


if __name__ == "__main__":
    unittest.main()
