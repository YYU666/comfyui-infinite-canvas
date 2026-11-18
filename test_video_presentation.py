"""Schema and real FFmpeg checks for native, narration-timed slides."""
import sys
import tempfile
import unittest
from fractions import Fraction
from pathlib import Path
from unittest.mock import patch

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

from video_edit_document import EditDocumentError, normalize_document, plan
from video_edit_ffmpeg import Runner, probe, render
from video_edit_testmedia import audio_marks, make_video
from video_presentation import PresentationRenderer

FPS = Fraction(24)
FRAME = {"num": 1, "den": 24}


def page(**patches):
    return {"id": "page1", "startFrame": 8, "endFrame": 24, "title": "A quick tour",
            "bullets": ["Explain the first step", "Show the result"], "layout": "fullscreen",
            "motion": "fade", **patches}


def document(**patches):
    clips = [{"id": "clip1", "inputSlot": "v1", "sourceInPts": 0, "sourceOutPts": 56, "timebase": FRAME}]
    return {"schemaVersion": 1, "clips": clips, **patches}


def decoded_luma(runner, path, size):
    encoded = runner.run(["-i", str(path), "-map", "0:v:0", "-pix_fmt", "gray", "-f", "rawvideo", "-"])
    width, height = size
    return np.frombuffer(encoded, dtype=np.uint8).reshape(-1, height, width)


class VideoPresentationTests(unittest.TestCase):
    def test_schema_normalizes_pages_and_preserves_old_signatures(self):
        self.assertEqual(normalize_document(document()), normalize_document(document(presentation=[])))
        normalized = normalize_document(document(presentation=[page(title=" 中文课件 ", bullets=[" 要点一 ", "要点二"])]))
        self.assertEqual(normalized["presentation"][0]["title"], "中文课件")
        self.assertEqual(normalized["presentation"][0]["bullets"], ["要点一", "要点二"])
        for bad in (None, [page(title="\x00")], [page(title="\ud800")], [page(layout="css")],
                    [page(endFrame=8)], [page(), page(id="overlap", startFrame=12, endFrame=48)],
                    [page(), page(startFrame=24, endFrame=48)], [page(path="external")]):
            with self.subTest(bad=bad), self.assertRaises(EditDocumentError):
                normalize_document(document(presentation=bad))

    def test_explicit_timebase_bounds_include_last_frame_padding(self):
        with self.assertRaisesRegex(EditDocumentError, "超出成片"):
            normalize_document(document(presentation=[page(endFrame=57)]))
        padded = document(presentation=[page(endFrame=57)])
        padded["clips"][0]["pad"] = {"mode": "last_frame", "count": 1}
        self.assertEqual(normalize_document(padded)["presentation"][0]["endFrame"], 57)

    def test_planner_validates_deferred_source_timebase_bounds(self):
        source = {"width": 320, "height": 180, "frameTimes": [n / FPS for n in range(56)],
                  "duration": 56 / FPS, "timebase": 1 / FPS, "audioOffset": None}
        inferred = document(presentation=[page(endFrame=57)])
        inferred["clips"][0].pop("timebase")
        normalized = normalize_document(inferred)
        with self.assertRaisesRegex(EditDocumentError, "超出成片"):
            plan(normalized, {"v1": source})

    def test_missing_cjk_font_is_actionable(self):
        with patch("video_presentation._font_candidates", return_value=iter([(None, None)])):
            with self.assertRaisesRegex(EditDocumentError, "缺少可用字体"):
                PresentationRenderer([page(title="视频顺序")], 320, 180, FPS)

    def test_side_reveal_changes_only_right_region_and_holds_all_rows(self):
        width, height = 320, 180
        sample = bytes([83]) * (width * height * 3 // 2)
        compositor = PresentationRenderer([page(startFrame=6, endFrame=22, layout="side", motion="reveal")], width, height, FPS)
        self.assertIs(compositor.frame(5, sample), sample)
        first = np.frombuffer(compositor.frame(6, sample), dtype=np.uint8, count=width * height).reshape(height, width)
        full = np.frombuffer(compositor.frame(15, sample), dtype=np.uint8, count=width * height).reshape(height, width)
        np.testing.assert_array_equal(full[:, :width - width * 42 // 200 * 2], 83)
        self.assertGreater(np.count_nonzero(full != first), 200)
        self.assertIs(compositor.frame(22, sample), sample)

    def test_export_preserves_audio_and_exact_half_open_frame_ranges(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            width, height = 320, 180
            source = make_video(root / "source.mp4", 56, width=width, height=height, text=False)
            runner = Runner()
            probes = {"v1": probe(runner, source)}
            files = {"v1": source}
            targets = []
            pages = [page(), page(id="page2", startFrame=30, endFrame=50, layout="side", motion="reveal")]
            for count, presentation in enumerate(([], pages)):
                work = root / f"job{count}"
                work.mkdir()
                doc = normalize_document(document(presentation=presentation))
                target = root / f"result{count}.mp4"
                result = render(runner, doc, plan(doc, probes), files, probes, target, work)
                self.assertEqual(result["frames"], 56)
                self.assertEqual(result["audio"], "clips")
                targets.append(target)

            baseline, composite = [decoded_luma(runner, path, (width, height)) for path in targets]
            self.assertEqual(composite.shape, (56, height, width))
            self.assertEqual(audio_marks(targets[0], FPS, 56), audio_marks(targets[1], FPS, 56))
            # Stable source patch avoids using the location of the test media's bit markers.
            source_delta = np.abs(baseline.astype(np.int16) - composite.astype(np.int16))
            for untouched in (7, 24, 29, 50):
                self.assertLess(source_delta[untouched, 125:150, 20:70].mean(), 3)
                self.assertLess(source_delta[untouched, 125:150, 240:290].mean(), 3)
            opening = source_delta[8, 50:75, 7:15].mean()
            solid = source_delta[15, 50:75, 7:15].mean()
            self.assertGreater(opening, 2)
            self.assertGreater(solid, opening + 10)
            self.assertLess(source_delta[40, 125:150, 20:70].mean(), 3)
            self.assertGreater(source_delta[40, 125:150, 240:290].mean(), 20)

    def test_export_keeps_timestamped_audio_gap_and_the_following_speech_position(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, target = root / "gap.webm", root / "gap.mp4"
            runner = Runner()
            runner.run([
                "-f", "lavfi", "-i", "color=blue:size=160x90:rate=24:duration=4",
                "-f", "lavfi", "-i", "sine=frequency=1000:sample_rate=48000:duration=4",
                "-af", r"asetnsamples=n=960:p=0,aselect=gte(t\,0.20)*not(between(t\,0.8\,1.78))",
                "-c:v", "libvpx-vp9", "-c:a", "libopus", str(source),
            ])
            probes = {"v1": probe(runner, source)}
            self.assertGreater(probes["v1"]["audioOffset"], Fraction(3, 20))
            self.assertGreater(probes["v1"]["audioDuration"], Fraction(39, 10))
            doc = normalize_document(document(clips=[
                {"id": "clip1", "inputSlot": "v1", "sourceInPts": 0, "sourceOutPts": 96, "timebase": FRAME},
            ]))
            result = render(runner, doc, plan(doc, probes), {"v1": source}, probes, target, root)
            self.assertEqual(result["frames"], 96)
            decoded = runner.run(["-i", str(target), "-map", "0:a:0", "-ac", "1", "-ar", "48000",
                                  "-f", "f32le", "pipe:1"])
            audio = np.frombuffer(decoded, dtype=np.float32)

            def rms(start, end):
                region = audio[round(start * 48000):round(end * 48000)]
                return np.sqrt(np.mean(region ** 2))

            self.assertLess(rms(0.02, 0.13), 0.003)
            self.assertGreater(rms(0.3, 0.6), 0.03)
            self.assertLess(rms(1.0, 1.6), 0.003)
            self.assertGreater(rms(2.0, 2.4), 0.03)
            self.assertGreater(rms(3.5, 3.8), 0.03)


if __name__ == "__main__":
    unittest.main()
