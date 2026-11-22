"""Exercise the real FFmpeg analysis and the video editor job boundary."""
import tempfile
import unittest
from fractions import Fraction
from pathlib import Path

from project_store import ProjectStore, StoreError
from video_auto_cut import _cut_ranges, _keep_ranges, suggest_cuts
from video_edit_document import MAX_CLIPS, EditDocumentError
from video_edit_ffmpeg import Runner, probe
from video_edit_jobs import VideoEditJobs


class AutoCutTests(unittest.TestCase):
    def test_longest_gaps_fit_timeline_without_losing_other_frames(self):
        intervals = [(Fraction(second), Fraction(second + 2)) for second in range(1, 320, 4)]
        intervals.append((Fraction(323), Fraction(326)))
        cuts = _cut_ranges(intervals, Fraction(1, 30), 9900, Fraction(0))
        self.assertEqual(len(cuts), MAX_CLIPS - 1)
        self.assertEqual(cuts[-1], (9690, 9780))
        keep = _keep_ranges(cuts, 9900)
        self.assertEqual(len(keep), MAX_CLIPS)
        self.assertEqual(sum(end - start for start, end in keep), 9900 - 62 * 60 - 90)

    def test_real_media_analysis_and_project_scope(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.mov"
            runner = Runner()
            runner.run([
                "-f", "lavfi", "-i", "color=white:s=128x72:r=30:d=6",
                "-f", "lavfi", "-i",
                r"aevalsrc=exprs=if(between(t\,1\,3)\,0\,0.25*sin(2*PI*440*t)):s=48000:d=6",
                "-vf", "drawbox=c=black:t=fill:enable='gte(t,2)*lt(t,4)'",
                "-c:v", "libx264", "-c:a", "pcm_s16le", str(source),
            ])
            store = ProjectStore(root / "projects", "auto-cut-test")
            jobs = VideoEditJobs(root / "jobs", store)
            try:
                project_id = store.create("Auto cut")["id"]
                with source.open("rb") as stream:
                    saved = store.put_asset(project_id, source.name, stream, "video/quicktime")
                payload = {"projectId": project_id, "nodeId": "edit", "slot": "v1",
                           "assetPath": saved["asset"]["path"], "mode": "black"}
                with self.assertRaises(StoreError):
                    jobs.submit_auto_cut({**payload, "assetPath": str(source)})
                for mode, cuts in (("black", [(60, 120)]), ("silence", [(36, 84)])):
                    job = jobs.submit_auto_cut({**payload, "mode": mode})
                    result = jobs.wait(job["id"], 15)
                    self.assertEqual(result["status"], "completed", result["error"])
                    self.assertEqual(result["result"]["cuts"], cuts)
                    self.assertEqual(result["result"]["removedFrames"], cuts[0][1] - cuts[0][0])
                    self.assertEqual(
                        [(c["sourceInPts"], c["sourceOutPts"]) for c in result["result"]["document"]["clips"]],
                        [(0, cuts[0][0]), (cuts[0][1], 180)],
                    )
                    with self.assertRaises(StoreError):
                        jobs.commit(job["id"], {"projectId": project_id, "revision": saved["revision"]})
                self.assertEqual(store.get(project_id)["revision"], saved["revision"])
            finally:
                jobs.close()
                store.close()

    def test_all_black_and_no_audio_do_not_make_a_destructive_suggestion(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "black.mp4"
            runner = Runner()
            runner.run(["-f", "lavfi", "-i", "color=black:s=128x72:r=30:d=2",
                        "-c:v", "libx264", str(source)])
            info = probe(runner, source)
            with self.assertRaisesRegex(EditDocumentError, "整段素材"):
                suggest_cuts(runner, source, info, "v1", "black")
            with self.assertRaisesRegex(EditDocumentError, "没有音轨"):
                suggest_cuts(runner, source, info, "v1", "silence")


if __name__ == "__main__":
    unittest.main()
