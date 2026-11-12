"""Schema, placement, and FFmpeg checks for the green-screen composite node."""
import subprocess
import sys
import tempfile
import unittest
from fractions import Fraction
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

from project_store import ProjectStore, StoreError
from video_chroma_document import (
    ChromaDocumentError,
    normalize_chroma_document,
    plan_placement,
)
from video_chroma_ffmpeg import build_graph
from video_chroma_jobs import VideoChromaJobs
from video_edit_ffmpeg import Runner, find_ffmpeg, probe
from video_edit_testmedia import dimensions, has_audio


def _close(pixel, expected, tolerance=28):
    return all(abs(int(channel) - int(target)) <= tolerance for channel, target in zip(pixel, expected))


def write_png(path, rgb):
    height, width = rgb.shape[:2]
    subprocess.run(
        [find_ffmpeg(), "-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24",
         "-s", f"{width}x{height}", "-i", "pipe:0", "-frames:v", "1", str(path)],
        input=np.ascontiguousarray(rgb, dtype=np.uint8).tobytes(), check=True, capture_output=True,
    )
    return path


def write_clip(path, frames, audio=False, fps=Fraction(24)):
    height, width = frames[0].shape[:2]
    payload = b"".join(np.ascontiguousarray(frame, dtype=np.uint8).tobytes() for frame in frames)
    args = [find_ffmpeg(), "-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24",
            "-s", f"{width}x{height}", "-framerate", f"{fps.numerator}/{fps.denominator}", "-i", "pipe:0"]
    if audio:
        seconds = f"{len(frames) / float(fps):.3f}"
        args += ["-f", "lavfi", "-i", f"sine=frequency=1000:sample_rate=48000:duration={seconds}"]
    args += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "12", "-pix_fmt", "yuv420p", "-frames:v", str(len(frames))]
    if audio:
        args += ["-map", "0:v:0", "-map", "1:a:0", "-c:a", "aac", "-b:a", "128k", "-shortest"]
    subprocess.run(args + [str(path)], input=payload, check=True, capture_output=True)
    return path


def read_rgb(path):
    width, height = dimensions(path)
    raw = subprocess.run(
        [find_ffmpeg(), "-hide_banner", "-loglevel", "error", "-i", str(path), "-map", "0:v:0", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
        capture_output=True, check=True,
    ).stdout
    frame_bytes = width * height * 3
    count = len(raw) // frame_bytes
    return np.frombuffer(raw[:count * frame_bytes], dtype=np.uint8).reshape(count, height, width, 3)


def green_plate(width, height, box, color=(220, 40, 40)):
    image = np.zeros((height, width, 3), np.uint8)
    image[:, :, 1] = 255
    x, y, box_w, box_h = box
    image[y:y + box_h, x:x + box_w] = color
    return image


class DocumentTests(unittest.TestCase):
    def test_defaults_place_a_portrait_plate_on_the_background(self):
        document = normalize_chroma_document({})
        self.assertEqual(document["keyColor"], "#00FF00")
        self.assertEqual(document["similarity"], 0.2)
        self.assertEqual(document["spill"], "green")
        self.assertEqual(document["audio"], "preserve")
        placed = plan_placement(document, 480, 832, 720, 1280)
        self.assertEqual(placed, {
            "outputWidth": 720, "outputHeight": 1280,
            "foregroundWidth": 480, "foregroundHeight": 832,
            "overlayX": 120, "overlayY": 224,
        })

    def test_odd_background_floors_to_even_and_scale_can_overflow(self):
        odd = plan_placement(normalize_chroma_document({}), 480, 832, 721, 1281)
        self.assertEqual((odd["outputWidth"], odd["outputHeight"], odd["overlayX"], odd["overlayY"]), (720, 1280, 120, 224))
        foreground = plan_placement(normalize_chroma_document({"outputSize": "foreground"}), 481, 833, 720, 1280)
        self.assertEqual((foreground["outputWidth"], foreground["outputHeight"]), (480, 832))
        doubled = plan_placement(normalize_chroma_document({"scale": 2}), 480, 832, 720, 1280)
        self.assertEqual((doubled["foregroundWidth"], doubled["foregroundHeight"], doubled["overlayX"], doubled["overlayY"]), (960, 1664, -120, -192))
        bottom = plan_placement(normalize_chroma_document({"anchor": "bottom", "offsetX": 10, "offsetY": -4}), 480, 832, 720, 1280)
        self.assertEqual((bottom["overlayX"], bottom["overlayY"]), (130, 444))

    def test_blue_screen_selects_blue_despill_and_rejects_injection(self):
        self.assertEqual(normalize_chroma_document({"keyColor": "#0000ff"})["spill"], "blue")
        for bad in (
            {"keyColor": "#00FF00;rm"},
            {"keyColor": "#00FF00", "filter": "chromakey=color=red"},
            {"similarity": 2},
            {"similarity": float("nan")},
            {"anchor": "expression"},
            {"choke": 9},
            {"scale": 0.01},
            {"outputSize": "../x"},
            {"startOffset": -1},
            {"schemaVersion": 2},
            {"path": "C:/secret.mp4"},
        ):
            with self.assertRaises(ChromaDocumentError):
                normalize_chroma_document(bad)

    def test_filtergraph_uses_only_validated_tokens(self):
        foreground = {"width": 480, "height": 832, "fps": Fraction(24, 1), "frameCount": 12, "duration": Fraction(12, 24), "isImage": False, "hasAudio": True}
        image = {"width": 720, "height": 1280, "isImage": True, "frameCount": 1, "duration": Fraction(0), "fps": None, "hasAudio": False}
        graph, placed = build_graph(normalize_chroma_document({}), foreground, image, "export")
        self.assertIn("chromakey=color=0x00FF00:similarity=0.200:blend=0.080:yuv=0", graph)
        self.assertIn("despill=type=green:mix=0.500:expand=0.0", graph)
        self.assertIn("overlay=x=120:y=224:format=rgb", graph)
        self.assertEqual((placed["outputWidth"], placed["outputHeight"]), (720, 1280))
        self.assertNotIn("[1:v]", build_graph(normalize_chroma_document({}), foreground, image, "matte")[0].split(";", 1)[0])
        matte, _ = build_graph(normalize_chroma_document({}), foreground, image, "matte")
        self.assertIn("chromakey=", matte)
        self.assertIn("geq=", matte)
        self.assertNotIn("[1:v]", matte)
        plain, _ = build_graph(normalize_chroma_document({}), foreground, image, "foreground")
        self.assertNotIn("chromakey", plain)
        blue, _ = build_graph(normalize_chroma_document({"keyColor": "#0000FF"}), foreground, image, "export")
        self.assertIn("despill=type=blue", blue)
        short = {"width": 64, "height": 64, "isImage": False, "frameCount": 4, "duration": Fraction(4, 24), "fps": Fraction(24, 1), "hasAudio": False}
        plate = {"width": 64, "height": 64, "fps": Fraction(24, 1), "frameCount": 8, "duration": Fraction(8, 24), "isImage": False, "hasAudio": False}
        held, _ = build_graph(normalize_chroma_document({}), plate, short, "export")
        self.assertIn("tpad=stop_mode=clone:stop_duration=", held)
        same, _ = build_graph(normalize_chroma_document({}), plate, {**short, "frameCount": 8, "duration": Fraction(8, 24)}, "export")
        self.assertNotIn("tpad=", same)
        skipped, _ = build_graph(normalize_chroma_document({"startOffset": 1}), plate, short, "export")
        self.assertIn("trim=start_frame=3:end_frame=4", skipped)
        choked, _ = build_graph(normalize_chroma_document({"choke": 2, "feather": 2}), foreground, image, "export")
        self.assertIn("erosion,erosion", choked)
        self.assertIn("boxblur=2:1", choked)


class FfmpegChromaTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory()
        root = Path(cls.temporary.name)
        cls.store = ProjectStore(root / "projects", "video-chroma-test")
        cls.project = cls.store.create("绿幕测试")["id"]
        media = root / "media"
        media.mkdir()
        plate = green_plate(480, 832, (180, 300, 120, 200))
        cls.plate_path = write_clip(media / "plate.mp4", [plate] * 12, audio=True)
        night = np.zeros((1280, 720, 3), np.uint8)
        night[:, :] = (11, 16, 32)
        cls.night_path = write_png(media / "night.png", night)
        small = green_plate(64, 64, (24, 24, 16, 16))
        cls.small_path = write_clip(media / "small.mp4", [small] * 8, audio=False)
        colors = [(20, 40, 180), (20, 90, 180), (20, 40, 90), (90, 40, 180)]
        bg_frames = [np.full((64, 64, 3), color, np.uint8) for color in colors]
        cls.hold_path = write_clip(media / "hold.mp4", bg_frames, audio=False)
        odd = np.full((81, 65, 3), (16, 32, 96), np.uint8)
        cls.odd_path = write_png(media / "odd.png", odd)
        cls.assets = {}
        for name, path, mime in (
            ("plate", cls.plate_path, "video/mp4"),
            ("night", cls.night_path, "image/png"),
            ("small", cls.small_path, "video/mp4"),
            ("hold", cls.hold_path, "video/mp4"),
            ("odd", cls.odd_path, "image/png"),
        ):
            with path.open("rb") as stream:
                cls.assets[name] = cls.store.put_asset(cls.project, path.name, stream, mime)["asset"]["path"]
        cls.jobs = VideoChromaJobs(root / "jobs", cls.store)

    @classmethod
    def tearDownClass(cls):
        cls.store.close()
        cls.temporary.cleanup()

    def export(self, foreground, background, settings, node="videoChromaKey-test"):
        job = self.jobs.submit({
            "projectId": self.project, "nodeId": node, "foreground": self.assets[foreground],
            "background": self.assets[background], "settings": settings,
        })
        done = self.jobs.wait(job["id"], 180)
        self.assertEqual(done["status"], "completed", done.get("error"))
        return done, self.jobs.output_file(job["id"])

    def test_portrait_still_keys_green_and_keeps_foreground_audio(self):
        done, path = self.export("plate", "night", {"schemaVersion": 1})
        frames = read_rgb(path)
        self.assertEqual(frames.shape, (12, 1280, 720, 3))
        self.assertTrue(_close(frames[0, 8, 8], (11, 16, 32)))
        self.assertTrue(_close(frames[0, 244, 140], (11, 16, 32)))
        self.assertGreater(int(frames[0, 624, 360, 0]), 160)
        self.assertLess(int(frames[0, 624, 360, 1]), 90)
        info = probe(Runner(), path)
        self.assertEqual(info["frameCount"], 12)
        self.assertEqual((info["width"], info["height"]), (720, 1280))
        self.assertEqual(info["frameTimebase"], Fraction(1, 24))
        self.assertEqual(done["result"]["audio"], "preserve")
        self.assertEqual(done["result"]["overlay"], {"x": 120, "y": 224, "width": 480, "height": 832})
        self.assertTrue(has_audio(path))
        self.assertEqual(info["width"] % 2, 0)
        muted, muted_path = self.export("plate", "night", {"audio": "mute"}, node="videoChromaKey-mute")
        self.assertEqual(muted["result"]["audio"], "mute")
        self.assertFalse(has_audio(muted_path))

    def test_short_video_background_holds_its_last_frame(self):
        _done, path = self.export("small", "hold", {}, node="videoChromaKey-hold")
        frames = read_rgb(path)
        self.assertEqual(len(frames), 8)
        self.assertTrue(_close(frames[0, 4, 4], (20, 40, 180)))
        self.assertTrue(_close(frames[7, 4, 4], (90, 40, 180)))
        self.assertFalse(_close(frames[7, 4, 4], (20, 40, 180), tolerance=12))
        self.assertGreater(int(frames[0, 32, 32, 0]), 160)

    def test_odd_background_exports_even_and_preview_frame_matches(self):
        done, path = self.export("small", "odd", {}, node="videoChromaKey-odd")
        self.assertEqual((done["result"]["width"], done["result"]["height"]), (64, 80))
        self.assertEqual(dimensions(path), (64, 80))
        preview = self.jobs.preview({
            "projectId": self.project, "nodeId": "videoChromaKey-preview",
            "foreground": self.assets["plate"], "background": self.assets["night"],
            "settings": {}, "time": 0, "mode": "composite",
        })
        self.assertEqual((preview["width"], preview["height"], preview["frame"], preview["mode"]), (720, 1280, 0, "composite"))
        png = Path(self.temporary.name) / "preview.png"
        png.write_bytes(__import__("base64").b64decode(preview["pngBase64"]))
        frame = read_rgb(png)[0]
        self.assertTrue(_close(frame[8, 8], (11, 16, 32)))
        self.assertGreater(int(frame[624, 360, 0]), 160)
        matte = self.jobs.preview({
            "projectId": self.project, "nodeId": "videoChromaKey-preview",
            "foreground": self.assets["plate"], "background": self.assets["night"],
            "settings": {}, "time": 0, "mode": "matte",
        })
        matte_path = Path(self.temporary.name) / "matte.png"
        matte_path.write_bytes(__import__("base64").b64decode(matte["pngBase64"]))
        matte_frame = read_rgb(matte_path)[0]
        self.assertGreater(abs(int(matte_frame[8, 8, 0]) - 11) + abs(int(matte_frame[8, 8, 2]) - 32), 40)
        self.assertLess(abs(int(matte_frame[244, 140, 0]) - int(matte_frame[244, 140, 1])), 12)
        raw = self.jobs.preview({
            "projectId": self.project, "nodeId": "videoChromaKey-preview",
            "foreground": self.assets["plate"], "background": self.assets["night"],
            "settings": {}, "time": 0, "mode": "foreground",
        })
        raw_path = Path(self.temporary.name) / "raw.png"
        raw_path.write_bytes(__import__("base64").b64decode(raw["pngBase64"]))
        raw_frame = read_rgb(raw_path)[0]
        self.assertGreater(int(raw_frame[244, 140, 1]), 180)
        self.assertLess(int(raw_frame[244, 140, 0]), 40)

    def test_rejects_paths_filters_and_a_still_foreground(self):
        payload = {"projectId": self.project, "nodeId": "videoChromaKey-bad", "foreground": self.assets["plate"], "background": self.assets["night"], "settings": {}}
        for bad in (
            {**payload, "foreground": "../secret.mp4"},
            {**payload, "settings": {"filter": "chromakey=color=red"}},
            {**payload, "foreground": self.assets["night"]},
        ):
            with self.assertRaises(StoreError):
                self.jobs.submit(bad)


if __name__ == "__main__":
    unittest.main()
