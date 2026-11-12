import copy
import sys
import unittest
from fractions import Fraction
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from video_edit_document import EditDocumentError, nearest_frame, normalize_document, plan


def doc(clips=None, **profile):
    return {"schemaVersion": 1, "outputProfile": {"fps": {"num": 24, "den": 1}, **profile},
            "clips": clips or [{"id": "c1", "inputSlot": "v1", "sourceInPts": 0, "sourceOutPts": 24, "timebase": {"num": 1, "den": 24}}]}


def fake_probe(frames, fps=Fraction(24), width=128, height=72, audio=True):
    times = [Fraction(index) / fps for index in range(frames)]
    return {"frameTimes": times, "duration": Fraction(frames) / fps, "timebase": 1 / fps, "width": width, "height": height,
            "audioOffset": Fraction(0) if audio else None, "audioDuration": Fraction(frames) / fps if audio else None, "frameCount": frames}


class NormalizeTests(unittest.TestCase):
    def test_defaults_are_filled_and_integer_timebase(self):
        value = normalize_document(doc())
        self.assertEqual(value["timelineTimebase"], {"num": 1, "den": 24})
        self.assertEqual(value["outputProfile"]["crf"], 14)
        self.assertEqual(value["clips"][0]["pad"], {"mode": "none", "count": 0})
        self.assertEqual(value["clips"][0]["gain"], 1)

    def test_rejects_unknown_fields_paths_urls_and_filters(self):
        for bad in (
            {**doc(), "path": "C:/Windows/win.ini"},
            doc([{"id": "c", "inputSlot": "C:/x.mp4", "sourceInPts": 0, "sourceOutPts": 1}]),
            doc([{"id": "c", "inputSlot": "http://evil/x.mp4", "sourceInPts": 0, "sourceOutPts": 1}]),
            doc([{"id": "c", "inputSlot": "v1", "sourceInPts": 0, "sourceOutPts": 1, "filter": "drawtext=text=x"}]),
            doc(filter="hflip"),
            doc(videoCodec="copy"),
            doc([{"id": "c", "inputSlot": "v1", "sourceInPts": 0, "sourceOutPts": 1, "pad": {"mode": "last_frame;rm -rf", "count": 1}}]),
            doc([{"id": "c;ls", "inputSlot": "v1", "sourceInPts": 0, "sourceOutPts": 1}]),
        ):
            with self.subTest(bad=bad), self.assertRaises(EditDocumentError):
                normalize_document(bad)

    def test_rejects_bad_numbers(self):
        for clip in (
            {"sourceInPts": 5, "sourceOutPts": 5}, {"sourceInPts": -1, "sourceOutPts": 5}, {"sourceInPts": 0.5, "sourceOutPts": 5},
            {"sourceInPts": 0, "sourceOutPts": 2 ** 60}, {"sourceInPts": True, "sourceOutPts": 5}, {"gain": 1.5}, {"gain": float("nan")},
            {"pad": {"mode": "last_frame", "count": -1}}, {"pad": {"mode": "none", "count": 3}}, {"reverse": "yes"},
        ):
            value = {"id": "c", "inputSlot": "v1", "sourceInPts": 0, "sourceOutPts": 5, **clip}
            with self.subTest(clip=clip), self.assertRaises(EditDocumentError):
                normalize_document(doc([value]))
        with self.assertRaises(EditDocumentError):
            normalize_document({**doc(), "timelineTimebase": {"num": 1, "den": 25}})
        with self.assertRaises(EditDocumentError):
            normalize_document(doc(width=101, height=72))
        with self.assertRaises(EditDocumentError):
            normalize_document(doc(fps={"num": 1000, "den": 1}))

    def test_audio_from_only_with_external(self):
        with self.assertRaises(EditDocumentError):
            normalize_document(doc(audioFrom={"inputSlot": "v1", "sourceInPts": 0, "sourceOutPts": 1}))
        value = normalize_document(doc(audio="external", audioFrom={"inputSlot": "a1", "sourceInPts": 0, "sourceOutPts": 48000, "timebase": {"num": 1, "den": 48000}}))
        self.assertEqual(value["outputProfile"]["audioFrom"]["inputSlot"], "a1")


class PlanTests(unittest.TestCase):
    def test_frame_exact_cut_and_pad(self):
        document = normalize_document(doc([{"id": "a", "inputSlot": "v1", "sourceInPts": 7, "sourceOutPts": 19, "timebase": {"num": 1, "den": 24}, "pad": {"mode": "last_frame", "count": 3}}]))
        result = plan(document, {"v1": fake_probe(100)})
        self.assertEqual(result["segments"][0]["frames"], list(range(7, 19)))
        self.assertEqual(result["totalFrames"], 12 + 3)

    def test_reverse_is_exact_reversal(self):
        document = normalize_document(doc([{"id": "a", "inputSlot": "v1", "sourceInPts": 3, "sourceOutPts": 9, "timebase": {"num": 1, "den": 24}, "reverse": True}]))
        self.assertEqual(plan(document, {"v1": fake_probe(20)})["segments"][0]["frames"], [8, 7, 6, 5, 4, 3])

    def test_global_grid_has_no_drift_for_2997(self):
        fps = Fraction(30000, 1001)
        probe = fake_probe(900, fps)
        tb = {"num": 1001, "den": 30000}
        cuts = [(0, 101), (101, 333), (333, 640), (640, 900)]
        document = normalize_document({**doc([{"id": f"c{i}", "inputSlot": "v1", "sourceInPts": a, "sourceOutPts": b, "timebase": tb} for i, (a, b) in enumerate(cuts)], fps={"num": 24, "den": 1})})
        split = plan(document, {"v1": probe})
        whole = plan(normalize_document(doc([{"id": "w", "inputSlot": "v1", "sourceInPts": 0, "sourceOutPts": 900, "timebase": tb}])), {"v1": probe})
        self.assertEqual([f for s in split["segments"] for f in s["frames"]], whole["segments"][0]["frames"])
        self.assertEqual(split["totalFrames"], whole["totalFrames"])
        native = plan(normalize_document(doc([{"id": "n", "inputSlot": "v1", "sourceInPts": 10, "sourceOutPts": 250, "timebase": tb}], fps={"num": 30000, "den": 1001})), {"v1": probe})
        self.assertEqual(native["segments"][0]["frames"], list(range(10, 250)))

    def test_out_of_range_and_mismatched_sizes(self):
        with self.assertRaises(EditDocumentError):
            plan(normalize_document(doc([{"id": "a", "inputSlot": "v1", "sourceInPts": 0, "sourceOutPts": 25, "timebase": {"num": 1, "den": 24}}])), {"v1": fake_probe(24)})
        two = doc([{"id": "a", "inputSlot": "v1", "sourceInPts": 0, "sourceOutPts": 5, "timebase": {"num": 1, "den": 24}},
                   {"id": "b", "inputSlot": "v2", "sourceInPts": 0, "sourceOutPts": 5, "timebase": {"num": 1, "den": 24}}])
        probes = {"v1": fake_probe(24), "v2": fake_probe(24, width=160, height=120)}
        with self.assertRaises(EditDocumentError):
            plan(normalize_document(two), probes)
        fixed = plan(normalize_document({**two, "outputProfile": {**two["outputProfile"], "width": 128, "height": 72}}), probes)
        self.assertEqual((fixed["width"], fixed["height"]), (128, 72))

    def test_external_audio_length_must_match(self):
        base = doc(audio="external", audioFrom={"inputSlot": "v1", "sourceInPts": 0, "sourceOutPts": 30, "timebase": {"num": 1, "den": 24}})
        with self.assertRaises(EditDocumentError):
            plan(normalize_document(base), {"v1": fake_probe(48)})
        good = copy.deepcopy(base)
        good["outputProfile"]["audioFrom"]["sourceOutPts"] = 24
        self.assertEqual(plan(normalize_document(good), {"v1": fake_probe(48)})["audio"], "external")
        with self.assertRaises(EditDocumentError):
            plan(normalize_document(good), {"v1": fake_probe(48, audio=False)})

    def test_nearest_frame_ties_choose_earlier(self):
        times = [Fraction(0), Fraction(1), Fraction(2)]
        self.assertEqual(nearest_frame(times, Fraction(1, 2)), 0)
        self.assertEqual(nearest_frame(times, Fraction(3, 2) + Fraction(1, 100)), 2)
        self.assertEqual(nearest_frame(times, Fraction(9)), 2)


if __name__ == "__main__":
    unittest.main()
