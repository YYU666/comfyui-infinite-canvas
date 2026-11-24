import os
from fractions import Fraction as F
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase, main
from unittest.mock import patch

from h3_compare import _media_path, inspect_h3_result, refine_source, serve_h3_compare, synchronize


def frame_list(*times, end=1):
    return 832, 480, tuple(map(F, times)), F(end) if end is not None else None


def receipt(source="workbench/source.mp4"):
    return {
        "source": {"class_type": "LoadVideo", "inputs": {"file": source}},
        "components": {"class_type": "GetVideoComponents", "inputs": {"video": ["source", 0]}},
        "probe": {"class_type": "GetImageSizeAndCount", "inputs": {"image": ["components", 0]}},
        "upscale": {"class_type": "MinimaxH3LatentUpscaler3D", "inputs": {"latent": ["a", 0]}},
        "video": {"class_type": "CreateVideo", "inputs": {"fps": ["components", 2]}},
        "save": {"class_type": "SaveVideo", "inputs": {"video": ["video", 0], "filename_prefix": "video/H3_HD_Refine"}},
    }


class H3CompareTest(TestCase):
    def test_matched_cfr_and_vfr(self):
        cfr = frame_list(0, "1/24", "1/12", end="1/8")
        self.assertEqual(synchronize(cfr, cfr)["clock"]["step"], {"num": 1, "den": 24})
        vfr = frame_list(0, "1/25", "1/10")
        self.assertEqual(synchronize(vfr, vfr)["clock"]["times"], [0, .04, .1])

    def test_mismatches_without_nominal_fps_guess(self):
        source = frame_list(0, "1/24")
        for reason, refined in {
            "frame-count": frame_list(0),
            "timestamps": frame_list(0, "1/25"),
            "nonzero-start": frame_list("1/24", "1/12"),
            "video-end": frame_list(0, "1/24", end=None),
        }.items():
            with self.subTest(reason=reason):
                self.assertEqual(synchronize(source, refined), {"reason": reason})

    def test_only_recorded_refine_graph_can_select_source(self):
        self.assertEqual(refine_source(receipt("workbench/一采.mp4 [input]")), "workbench/一采.mp4")
        bad = receipt()
        bad["components"]["inputs"]["video"] = ["foreign", 0]
        self.assertIsNone(refine_source(bad))
        self.assertIsNone(refine_source({"source": receipt()["source"]}))

    def test_missing_and_changed_source_never_grant_a_clock(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            out = root / "H3_HD_Refine_1.mp4"
            out.write_bytes(b"fixture")
            data = {"kind": "video", "filename": out.name, "type": "output"}
            with patch("h3_compare._embedded_graph", return_value=receipt("source.mp4")):
                self.assertEqual(inspect_h3_result(data, root, root)["reason"], "source-missing")
                source = root / "source.mp4"
                source.write_bytes(b"fixture")
                os.utime(source, ns=(out.stat().st_atime_ns, out.stat().st_mtime_ns + 1_000_000_000))
                self.assertEqual(inspect_h3_result(data, root, root)["reason"], "source-newer")
                self.assertIsNone(_media_path(root, "../source.mp4"))
                self.assertIsNone(_media_path(root, "C:/source.mp4"))

    def test_only_saved_result_nodes_can_be_inspected(self):
        class Handler:
            path = "/api/h3-compare?projectId=prj_test&nodeId=old"
            def send_json(self, status, data):
                self.status, self.data = status, data
        class Store:
            def get(self, key):
                assert key == "prj_test"
                return {"canvas": {"nodes": []}}
        handler = Handler()
        self.assertTrue(serve_h3_compare(handler, "/api/h3-compare", Store(), ".", "."))
        self.assertEqual(handler.status, 404)
        handler.path += "&nodeId=other"
        self.assertTrue(serve_h3_compare(handler, "/api/h3-compare", Store(), ".", "."))
        self.assertEqual(handler.status, 400)


if __name__ == "__main__":
    main()
