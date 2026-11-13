"""Green-screen white-model plate: document, SAM3 graph, and a mocked mask."""
from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from fractions import Fraction
from pathlib import Path

import numpy as np

from project_store import ProjectStore
from video_edit_ffmpeg import Runner, find_ffmpeg, probe
from video_plate_document import PlateDocumentError, normalize_plate_document
from video_plate_ffmpeg import render_plate
from video_plate_jobs import VideoPlateJobs
from video_plate_sam3 import SAM_CHECKPOINT, build_sam3_plate_workflow

WIDTH, HEIGHT = 64, 100


def write_rgb(path, frames, audio=False, fps=Fraction(24, 1)):
    height, width = frames[0].shape[:2]
    payload = b"".join(np.ascontiguousarray(frame, dtype=np.uint8).tobytes() for frame in frames)
    args = [find_ffmpeg(), "-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24",
            "-s", f"{width}x{height}", "-framerate", f"{fps.numerator}/{fps.denominator}", "-i", "pipe:0"]
    if audio:
        args += ["-f", "lavfi", "-i", f"sine=frequency=440:sample_rate=48000:duration={len(frames) / float(fps):.3f}"]
    args += ["-c:v", "libx264rgb", "-pix_fmt", "rgb24", "-qp", "0", "-preset", "veryfast", "-frames:v", str(len(frames))]
    if audio:
        args += ["-map", "0:v:0", "-map", "1:a:0", "-c:a", "aac", "-b:a", "128k"]
    subprocess.run(args + [str(path)], input=payload, check=True, capture_output=True)
    return path


def write_yuv(path, frames, fps=Fraction(24, 1)):
    height, width = frames[0].shape[:2]
    payload = b"".join(np.ascontiguousarray(frame, dtype=np.uint8).tobytes() for frame in frames)
    subprocess.run(
        [find_ffmpeg(), "-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24",
         "-s", f"{width}x{height}", "-framerate", f"{fps.numerator}/{fps.denominator}", "-i", "pipe:0",
         "-c:v", "libx264", "-preset", "veryfast", "-crf", "12", "-pix_fmt", "yuv420p", "-frames:v", str(len(frames)), str(path)],
        input=payload, check=True, capture_output=True,
    )
    return path


def read_rgb(path):
    info = probe(Runner(), path)
    raw = subprocess.run(
        [find_ffmpeg(), "-hide_banner", "-loglevel", "error", "-i", str(path), "-map", "0:v:0", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
        capture_output=True, check=True,
    ).stdout
    frame_bytes = info["width"] * info["height"] * 3
    count = len(raw) // frame_bytes
    return np.frombuffer(raw[:count * frame_bytes], dtype=np.uint8).reshape(count, info["height"], info["width"], 3), info


def scene_frames(count):
    frame = np.zeros((HEIGHT, WIDTH, 3), np.uint8)
    frame[:, :] = (20, 30, 80)
    frame[63:, :] = (250, 250, 250)
    frame[8:40, 10:28] = (220, 40, 40)
    frame[12:30, 14:22] = (245, 245, 245)
    frame[8:80, 40:46] = (30, 30, 30)
    return [frame.copy() for _ in range(count)]


def mask_frame():
    mask = np.zeros((HEIGHT, WIDTH, 3), np.uint8)
    mask[8:40, 10:28] = 255
    mask[8:80, 40:46] = 255
    return mask


def _render(directory, name, frames, mask_count, settings, audio=False):
    video = write_rgb(directory / f"{name}-v.mp4", frames, audio=audio)
    mask = write_rgb(directory / f"{name}-m.mp4", [mask_frame()] * mask_count)
    target = directory / f"{name}-out.mp4"
    document = normalize_plate_document(settings)
    result = render_plate(Runner(), document, video, mask, target)
    pixels, info = read_rgb(target)
    return result, pixels, info


def sample_report():
    """Synthetic clip: the bottom 37 rows are a white floor the keyer could not remove."""
    root = Path(tempfile.mkdtemp())
    try:
        frames = scene_frames(8)
        result, pixels, info = _render(root, "flat", frames, 7, {
            "keepPrompts": ["person", "pole"], "maskGrow": 0, "maskFeather": 0, "shadeMode": "flat", "greenColor": "#00FF00",
        }, audio=True)
        shaded, shade_px, _info = _render(root, "shade", frames, 8, {"shadeMode": "shaded", "maskGrow": 0, "maskFeather": 0})
        _grown, grow_px, _ginfo = _render(root, "grow", frames, 8, {"maskGrow": 2, "maskFeather": 0, "shadeMode": "flat"})
        return {
            "width": result["width"], "height": result["height"], "frames": result["frames"],
            "fps": f"{info['frameTimebase'].denominator}/{info['frameTimebase'].numerator}" if info["frameTimebase"] == Fraction(1, 24) else str(info["frameTimebase"]),
            "frameTimebase": [info["frameTimebase"].numerator, info["frameTimebase"].denominator],
            "hasAudio": info.get("audioOffset") is not None,
            "floor": pixels[0, 90, 10].tolist(),
            "background": pixels[0, 2, 2].tolist(),
            "person": pixels[0, 36, 12].tolist(),
            "poleOnFloor": pixels[0, 70, 43].tolist(),
            "lastFloor": pixels[-1, 90, 10].tolist(),
            "shadedFloor": shade_px[0, 90, 10].tolist(),
            "shadedPerson": shade_px[0, 36, 12].tolist(),
            "shadedLight": shade_px[0, 20, 18].tolist(),
            "growEdge": grow_px[0, 20, 8].tolist(),
            "growOutside": grow_px[0, 20, 7].tolist(),
            "keepPrompts": result["keepPrompts"],
        }
    finally:
        # The directory holds only small synthetic clips.
        import shutil
        shutil.rmtree(root, ignore_errors=True)


class PlateDocumentTest(unittest.TestCase):
    def test_defaults_keep_person_and_pole(self):
        document = normalize_plate_document({})
        self.assertEqual(document["keepPrompts"], ["person", "pole"])
        self.assertEqual(document["maskGrow"], 8)
        self.assertEqual(document["maskFeather"], 2)
        self.assertEqual(document["shadeMode"], "flat")
        self.assertEqual(document["greenColor"], "#00FF00")

    def test_prompt_string_and_rejections(self):
        self.assertEqual(normalize_plate_document({"keepPrompts": "person，pole"})["keepPrompts"], ["person", "pole"])
        for bad in (
            {"keepPrompts": []},
            {"keepPrompts": ["person"] * 5},
            {"keepPrompts": ["floor;rm"]},
            {"shadeMode": "clay"},
            {"greenColor": "#00FF00;rm"},
            {"maskGrow": -1},
            {"maskGrow": True},
            {"maskFeather": 1.5},
            {"schemaVersion": 2},
            {"points": [[0, 0]]},
        ):
            with self.assertRaises(PlateDocumentError):
                normalize_plate_document(bad)


class Sam3WorkflowTest(unittest.TestCase):
    def test_reuses_official_sam3_and_unions_person_and_pole(self):
        graph = build_sam3_plate_workflow("h3plate-abc.mp4", ["person", "pole"], 175, 24)
        encoded = json.dumps(graph)
        self.assertNotIn("http", encoded)
        self.assertNotIn("huggingface", encoded)
        self.assertEqual(graph["sam"]["inputs"]["ckpt_name"], SAM_CHECKPOINT)
        texts = [node["inputs"]["text"] for node in graph.values() if node["class_type"] == "CLIPTextEncode"]
        self.assertEqual(texts, ["person", "pole"])
        tracks = [node for node in graph.values() if node["class_type"] == "SAM3_VideoTrack"]
        self.assertEqual(len(tracks), 2)
        self.assertTrue(all(node["inputs"]["max_objects"] == 1 for node in tracks))
        self.assertTrue(all(node["class_type"] != "ImageScale" for node in graph.values()))
        expands = [node for node in graph.values() if node["class_type"] == "H3RelayExpandMask"]
        self.assertTrue(all(node["inputs"]["expansion_px"] == 0 for node in expands))
        unions = [node for node in graph.values() if node["class_type"] == "MaskComposite"]
        self.assertEqual(len(unions), 1)
        self.assertEqual(unions[0]["inputs"]["operation"], "add")
        keys = {key for node in graph.values() for key in node["inputs"]}
        self.assertTrue({"points", "boxes", "positive_points"}.isdisjoint(keys))
        classes = {node["class_type"] for node in graph.values()}
        self.assertTrue({
            "LoadVideo", "GetVideoComponents", "CheckpointLoaderSimple", "CLIPTextEncode",
            "SAM3_Detect", "H3RelaySelectMask", "SAM3_VideoTrack", "SAM3_TrackToMask",
            "H3RelayRecoverMasks", "H3RelayExpandMask", "MaskComposite", "MaskToImage", "CreateVideo", "SaveVideo",
        }.issubset(classes))

    def test_one_prompt_has_no_union(self):
        graph = build_sam3_plate_workflow("clip.mp4", ["person"], 8, Fraction(24, 1))
        self.assertFalse(any(node["class_type"] == "MaskComposite" for node in graph.values()))
        self.assertEqual(graph["mask_video"]["inputs"]["fps"], 24.0)


class PlatePixelsTest(unittest.TestCase):
    def test_floor_is_exact_green_and_pole_stays_white(self):
        report = sample_report()
        self.assertEqual((report["width"], report["height"], report["frames"]), (64, 100, 8))
        self.assertEqual(report["frameTimebase"], [1, 24])
        self.assertTrue(report["hasAudio"])
        self.assertEqual(report["keepPrompts"], ["person", "pole"])
        for key in ("floor", "background", "lastFloor", "shadedFloor"):
            self.assertEqual(report[key], [0, 255, 0], key)
        self.assertEqual(report["person"], [255, 255, 255])
        self.assertEqual(report["poleOnFloor"], [255, 255, 255])
        for key in ("shadedPerson", "shadedLight"):
            pixel = report[key]
            self.assertEqual(len(set(pixel)), 1, pixel)
            self.assertGreaterEqual(min(pixel), 210, pixel)
            self.assertNotEqual(pixel, [0, 255, 0])
        self.assertGreater(sum(report["shadedLight"]), sum(report["shadedPerson"]))
        self.assertEqual(report["growEdge"], [255, 255, 255])
        self.assertEqual(report["growOutside"], [0, 255, 0])


class FakeMask:
    def __init__(self, frame, count):
        self.frame = frame
        self.count = count
        self.prompts = None
        self.frames = None

    def __call__(self, video_path, document, info, workdir, progress, cancelled):
        self.prompts = list(document["keepPrompts"])
        self.frames = info["frameCount"]
        progress(0.3, "模拟 SAM3")
        path = Path(workdir) / "mask.mp4"
        write_rgb(path, [self.frame] * self.count)
        return path


class PlateJobTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        root = Path(self.temporary.name)
        self.store = ProjectStore(root / "projects", "video-plate-test")
        self.project = self.store.create("白模测试")["id"]
        self.jobs_root = root / "jobs"

    def tearDown(self):
        self.store.close()
        self.temporary.cleanup()

    def _asset(self, path):
        with path.open("rb") as stream:
            return self.store.put_asset(self.project, path.name, stream, "video/mp4")["asset"]["path"]

    def test_mocked_mask_matches_input_frames(self):
        media = Path(self.temporary.name)
        video = write_rgb(media / "scene.mp4", scene_frames(8), audio=True)
        fake = FakeMask(mask_frame(), 7)
        jobs = VideoPlateJobs(self.jobs_root, self.store, segmenter=fake)
        job = jobs.submit({
            "projectId": self.project, "nodeId": "videoWhitePlate-test", "video": self._asset(video),
            "settings": {"schemaVersion": 1, "keepPrompts": "person, pole", "maskGrow": 0, "maskFeather": 0, "shadeMode": "flat", "greenColor": "#00ff00"},
        })
        done = jobs.wait(job["id"], 120)
        self.assertEqual(done["status"], "completed", done.get("error"))
        self.assertEqual(fake.prompts, ["person", "pole"])
        self.assertEqual(fake.frames, 8)
        pixels, info = read_rgb(jobs.output_file(job["id"]))
        self.assertEqual(pixels.shape, (8, 100, 64, 3))
        self.assertEqual(info["frameTimebase"], Fraction(1, 24))
        self.assertEqual(tuple(pixels[0, 90, 10]), (0, 255, 0))
        self.assertEqual(tuple(pixels[0, 70, 43]), (255, 255, 255))
        self.assertEqual(tuple(pixels[-1, 2, 2]), (0, 255, 0))
        self.assertIsNotNone(info.get("audioOffset"))
        self.assertEqual(done["result"]["frames"], 8)
        self.assertEqual(done["result"]["greenColor"], "#00FF00")

    def test_one_frame_short_mask_keeps_175(self):
        media = Path(self.temporary.name)
        frame = np.zeros((32, 32, 3), np.uint8)
        frame[:, :] = (250, 250, 250)
        frame[8:20, 8:20] = (220, 40, 40)
        video = write_yuv(media / "count.mp4", [frame] * 175, fps=Fraction(24, 1))
        probed = probe(Runner(), video)
        self.assertEqual(probed["frameCount"], 175)
        self.assertEqual(probed["duration"], Fraction(175, 24))
        mask = np.zeros((32, 32, 3), np.uint8)
        mask[8:20, 8:20] = 255
        fake = FakeMask(mask, 174)
        jobs = VideoPlateJobs(self.jobs_root, self.store, segmenter=fake)
        job = jobs.submit({
            "projectId": self.project, "nodeId": "videoWhitePlate-count", "video": self._asset(video),
            "settings": {"maskGrow": 0, "maskFeather": 0},
        })
        done = jobs.wait(job["id"], 180)
        self.assertEqual(done["status"], "completed", done.get("error"))
        pixels, info = read_rgb(jobs.output_file(job["id"]))
        self.assertEqual(info["frameCount"], 175)
        self.assertEqual((info["width"], info["height"]), (32, 32))
        self.assertEqual(info["frameTimebase"], Fraction(1, 24))
        self.assertEqual(tuple(pixels[0, 2, 2]), (0, 255, 0))
        self.assertEqual(tuple(pixels[0, 12, 12]), (255, 255, 255))
        self.assertEqual(tuple(pixels[-1, 2, 2]), (0, 255, 0))


if __name__ == "__main__":
    unittest.main()
