"""Deterministic preview/root/shutdown race coverage without media or processes."""
import threading
from tempfile import TemporaryDirectory
from unittest import TestCase, mock
from project_store import StoreError
from video_chroma_jobs import VideoChromaJobs


class ChromaPreviewLifecycleTests(TestCase):
    def test_preview_blocks_root_change_and_shutdown_cancels_it(self):
        with TemporaryDirectory() as directory:
            runner = mock.Mock()
            jobs = VideoChromaJobs(directory, mock.Mock(), runner_factory=lambda: runner)
            started, release = threading.Event(), threading.Event()
            def render(*args):
                started.set()
                self.assertTrue(release.wait(3))
                return dict(width=1, height=1, frame=0, time=0, mode='composite', png=b'png')
            payload = dict(projectId='prj_test', nodeId='test', settings={})
            errors = []
            def preview():
                try: jobs.preview(payload)
                except Exception as error: errors.append(error)
            with mock.patch.object(jobs, '_sources', return_value=('fg','bg',True)), mock.patch('video_chroma_jobs.render_preview', side_effect=render):
                thread = threading.Thread(target=preview)
                thread.start()
                try:
                    self.assertTrue(started.wait(3))
                    self.assertEqual(jobs.active_count(), 1)
                    with self.assertRaises(StoreError): jobs.replace_store(mock.Mock())
                    jobs.close()
                    runner.cancel.assert_called()
                    with self.assertRaises(StoreError): jobs.preview(payload)
                finally:
                    release.set()
                    thread.join(3)
                self.assertFalse(errors)
                self.assertEqual(jobs.active_count(), 0)
