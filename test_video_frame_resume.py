"""Live export frames and continuation after the worker is interrupted."""
import tempfile
import threading
import unittest
from unittest import mock
from pathlib import Path

from PIL import Image

from project_store import ProjectStore
from test_video_prepared_fixture import submit_fixture
from video_edit_ffmpeg import Runner
from video_edit_jobs import VideoEditJobs
from video_edit_testmedia import _frame, make_video, read_indices
from video_frame_export import FrameExporter, atomic_json, write_job_record, write_preview_jpeg
from video_rhythm_jobs import VideoRhythmJobs


class SimulatedInterrupt(BaseException):
    pass


class PreviewFrameTests(unittest.TestCase):
    def test_jpeg_keeps_the_frame_luma_block(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "preview.jpg"
            write_preview_jpeg(_frame(1, 128, 72), 128, 72, path)
            with Image.open(path) as image:
                self.assertEqual(image.size, (128, 72))
                self.assertGreater(image.getpixel((2, 2))[0], 200)
            write_preview_jpeg(_frame(0, 128, 72), 128, 72, path)
            with Image.open(path) as image:
                self.assertLess(image.getpixel((2, 2))[0], 40)

    def test_locked_preview_is_skipped_and_the_export_keeps_the_previous_jpeg(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "preview.jpg"
            write_preview_jpeg(_frame(0, 128, 72), 128, 72, path)
            original = path.read_bytes()
            real_replace = Path.replace

            def locked(self, target):
                if self.name == "preview.jpg.tmp":
                    raise PermissionError("sharing violation")
                return real_replace(self, target)

            with mock.patch.object(Path, "replace", locked):
                write_preview_jpeg(_frame(1, 128, 72), 128, 72, path)
            self.assertEqual(path.read_bytes(), original)
            self.assertFalse((path.parent / "preview.jpg.tmp").exists())

    def test_changed_plan_discards_saved_chunks(self):
        with tempfile.TemporaryDirectory() as temporary:
            workdir = Path(temporary)
            atomic_json(workdir / "checkpoint.json", {"identity": "old", "total": 48})
            (workdir / "chunk-00000.ts").write_bytes(b"partial")
            atomic_json(workdir / "chunk-00000.json", {"frames": 24})
            exporter = FrameExporter(Runner(), workdir, width=128, height=72, fps=__import__("fractions").Fraction(24, 1),
                                     preset="medium", crf=14, total=48, identity="new", progress=lambda *args: None)
            self.assertEqual(exporter.resume_from, 0)
            self.assertFalse((workdir / "chunk-00000.ts").exists())


class InterruptedExportTests(unittest.TestCase):
    def setUp(self):
        self.previous_hook = threading.excepthook
        def ignore_simulated(args):
            if args.exc_type is not SimulatedInterrupt:
                self.previous_hook(args)
        threading.excepthook = ignore_simulated
        self.temporary = tempfile.TemporaryDirectory()
        root = Path(self.temporary.name)
        self.store = ProjectStore(root / "projects", "video-resume-test")
        self.project = self.store.create("续跑")["id"]
        media = root / "media"
        media.mkdir()
        source = make_video(media / "clip.mp4", frames=48, text=False)
        with source.open("rb") as stream:
            self.asset = self.store.put_asset(self.project, source.name, stream, "video/mp4")["asset"]["path"]
        self.root = root

    def tearDown(self):
        threading.excepthook = self.previous_hook
        self.store.close()
        self.temporary.cleanup()

    def test_edit_restart_keeps_frames_and_serves_preview(self):
        reference = VideoEditJobs(self.root / "reference-jobs", self.store)
        try:
            done = reference.wait(submit_fixture(reference, self._edit_payload("edit-reference"))["id"], 180)
            self.assertEqual(done["status"], "completed", done.get("error"))
            expected = read_indices(reference.output_file(done["id"]))
        finally:
            reference.close()
        self.assertEqual(expected, list(range(48)))

        crashed = threading.Event()
        original = FrameExporter._seal

        def seal(exporter):
            original(exporter)
            if not crashed.is_set():
                crashed.set()
                raise SimulatedInterrupt()

        jobs = VideoEditJobs(self.root / "edit-jobs", self.store)
        try:
            with mock.patch.object(FrameExporter, "_seal", seal):
                job = submit_fixture(jobs, self._edit_payload("edit-resume"))
                self.assertTrue(crashed.wait(60))
                jobs.worker.join(10)
            self.assertFalse(jobs.worker.is_alive())
            preview = jobs.preview_jpeg(job["id"])
            self.assertTrue(preview.startswith(b"\xff\xd8"))
            self.assertIsInstance(jobs.get(job["id"])["previewFrame"], int)
            self.assertEqual(jobs.get(job["id"])["status"], "running")
        finally:
            jobs.close()

        resumed = VideoEditJobs(self.root / "edit-jobs", self.store)
        try:
            done = resumed.wait(job["id"], 180)
            self.assertEqual(done["status"], "completed", done.get("error"))
            self.assertEqual(done["result"]["resumedFrames"], 24)
            self.assertEqual(read_indices(resumed.output_file(job["id"])), expected)
            with self.assertRaises(Exception) as error:
                resumed.preview_jpeg(job["id"])
            self.assertEqual(error.exception.status, 404)
        finally:
            resumed.close()
        restored = VideoEditJobs(self.root / "edit-jobs", self.store)
        try:
            project = self.store.get(self.project)
            saved = restored.commit(job["id"], {"projectId": self.project, "revision": project["revision"]})
            self.assertTrue(saved["asset"]["path"].startswith("assets/"))
        finally:
            restored.close()

    def test_interrupted_export_is_kept_ahead_of_newer_finished_jobs(self):
        root = self.root / "priority-jobs"
        finished = "ved_" + "ab" * 16
        running = "ved_" + "cd" * 16
        finished_dir = root / finished
        finished_dir.mkdir(parents=True)
        (finished_dir / "output.mp4").write_bytes(b"done")
        write_job_record(finished_dir, {
            "version": 1, "id": finished, "status": "completed", "projectId": self.project,
            "nodeId": "done", "createdAt": 9000, "submission": self._edit_payload("done"), "result": {"bytes": 4},
        })
        write_job_record(root / running, {
            "version": 1, "id": running, "status": "running", "projectId": self.project,
            "nodeId": "live", "createdAt": 1, "submission": self._edit_payload("live"), "result": None,
        })
        jobs = VideoEditJobs(root, self.store, max_jobs=1)
        try:
            self.assertEqual(set(jobs.jobs), {running})
        finally:
            jobs.close()

    def test_cancelled_edit_is_not_resumed(self):
        jobs = VideoEditJobs(self.root / "cancel-jobs", self.store)
        try:
            job = submit_fixture(jobs, self._edit_payload("edit-cancel"))
            jobs.cancel(job["id"], self.project)
            done = jobs.wait(job["id"], 60)
            self.assertEqual(done["status"], "cancelled")
        finally:
            jobs.close()
        restarted = VideoEditJobs(self.root / "cancel-jobs", self.store)
        try:
            self.assertEqual(restarted.jobs, {})
        finally:
            restarted.close()

    def test_rhythm_restart_continues_the_same_frames(self):
        payload = {"projectId": self.project, "nodeId": "speed-resume", "input": self.asset,
                   "operation": "speed", "settings": {"schemaVersion": 1, "speed": 0.5, "audio": "mute"}}
        reference = VideoRhythmJobs(self.root / "rhythm-reference", self.store)
        try:
            done = reference.wait(submit_fixture(reference, payload)["id"], 180)
            expected = read_indices(reference.output_file(done["id"]))
        finally:
            reference.close()
        self.assertEqual(expected, [index // 2 for index in range(96)])

        crashed = threading.Event()
        original = FrameExporter._seal

        def seal(exporter):
            original(exporter)
            if not crashed.is_set():
                crashed.set()
                raise SimulatedInterrupt()

        jobs = VideoRhythmJobs(self.root / "rhythm-jobs", self.store)
        try:
            with mock.patch.object(FrameExporter, "_seal", seal):
                job = submit_fixture(jobs, {**payload, "nodeId": "speed-interrupted"})
                self.assertTrue(crashed.wait(60))
                jobs.worker.join(10)
        finally:
            jobs.close()
        resumed = VideoRhythmJobs(self.root / "rhythm-jobs", self.store)
        try:
            done = resumed.wait(job["id"], 180)
            self.assertEqual(done["status"], "completed", done.get("error"))
            self.assertEqual(done["result"]["resumedFrames"], 24)
            self.assertEqual(read_indices(resumed.output_file(job["id"])), expected)
        finally:
            resumed.close()

    def _edit_payload(self, node_id):
        return {"projectId": self.project, "nodeId": node_id, "inputs": {"v1": self.asset}, "document": {
            "schemaVersion": 1,
            "outputProfile": {"fps": {"num": 24, "den": 1}, "audio": "clips", "crf": 14},
            "clips": [{"id": "a", "inputSlot": "v1", "sourceInPts": 0, "sourceOutPts": 48, "timebase": {"num": 1, "den": 24}}],
        }}


if __name__ == "__main__":
    unittest.main()
