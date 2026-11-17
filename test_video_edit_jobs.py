"""Mocked export/API integration: no server, FFmpeg process, GPU or user media."""
from io import BytesIO
from fractions import Fraction
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest import TestCase, mock

from project_store import StoreError
from video_edit_api import VideoEditAPI
from video_edit_document import normalize_document
from video_edit_jobs import VideoEditJobs
from video_edit_ffmpeg import FFmpegError, Runner, probe, public_probe
from video_workbench_launcher import WorkbenchHandler, validate_update_ready, validate_settings_change
from workbench_settings import SettingsError
from workbench_update import UpdateError


class ExportTests(TestCase):
    def test_root_replacement_invalidates_completed_job_identity(self):
        with TemporaryDirectory() as temporary:
            old_store, new_store = mock.Mock(), mock.Mock()
            jobs = VideoEditJobs(Path(temporary), old_store)
            job_id = 'ved_' + 'a' * 32
            jobs.jobs[job_id] = {'id': job_id, 'projectId': 'prj_same', 'nodeId': 'edit', 'status': 'completed'}
            jobs.replace_store(new_store)
            with self.assertRaises(StoreError):
                jobs.commit(job_id, {'projectId': 'prj_same', 'revision': 1})
            new_store.put_asset.assert_not_called()
            jobs.close()

    def test_audio_only_probe_uses_optional_video_map(self):
        runner = mock.Mock()
        runner.run.return_value = b'#tb 0: 1/48000\n#media_type 0: audio\n#sample_rate 0: 48000\n0, 0, 0, 48000, 192000, 0x00000000\n'
        info = probe(runner, Path('synthetic.wav'))
        self.assertEqual(info['audioDuration'], Fraction(1))
        self.assertEqual(info['audioOffset'], Fraction(0))
        self.assertEqual(info['frameTimes'], [])
        self.assertTrue(public_probe(info)['hasAudio'])
        self.assertIn('0:v:0?', runner.run.call_args.args[0])

    def test_missing_ffmpeg_fails_job_and_cancel_during_spawn_kills_child(self):
        with TemporaryDirectory() as temporary:
            store = mock.Mock()
            jobs = VideoEditJobs(Path(temporary), store, runner_factory=mock.Mock(side_effect=FFmpegError('找不到 FFmpeg。')))
            try:
                with mock.patch('video_edit_jobs.shutil.disk_usage', return_value=SimpleNamespace(free=2**40)):
                    started = jobs.submit({'projectId': 'prj_test', 'nodeId': 'edit', 'inputs': {'v1': f"assets/{'a'*64}.mp4"}, 'document': {'schemaVersion': 1, 'clips': [{'id': 'clip', 'inputSlot': 'v1', 'sourceInPts': 0, 'sourceOutPts': 24}]}})
                    failed = jobs.wait(started['id'], 2)
                    self.assertEqual(failed['status'], 'failed')
                    self.assertEqual(failed['error'], '找不到 FFmpeg。')
                    self.assertEqual(jobs.active_count(), 0)
            finally:
                jobs.close()
        runner = Runner(ffmpeg='synthetic-ffmpeg')
        process = mock.Mock()
        def spawn(*_args, **_kwargs):
            runner.cancel()
            return process
        with mock.patch('video_edit_ffmpeg.subprocess.Popen', side_effect=spawn):
            runner.popen(['-version'])
        process.kill.assert_called_once()

    def test_mocked_job_commits_only_via_current_revision_and_closes(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'source.mp4'
            source.write_bytes(b'synthetic source')
            store = mock.Mock()
            store.asset_file.return_value = source
            store.put_asset.return_value = {'revision': 8, 'asset': {'path': 'assets/synthetic.mp4'}}
            runner = mock.Mock()
            jobs = VideoEditJobs(root / 'jobs', store, runner_factory=lambda: runner)
            document = normalize_document({'schemaVersion': 1, 'outputProfile': {'fps': {'num': 24, 'den': 1}}, 'clips': [{'id': 'clip', 'inputSlot': 'v1', 'sourceInPts': 0, 'sourceOutPts': 24, 'timebase': {'num': 1, 'den': 24}}]})
            info = {'width': 128, 'height': 72, 'frameCount': 24, 'frameTimes': [Fraction(n, 24) for n in range(24)], 'timebase': Fraction(1, 24), 'duration': Fraction(1), 'audioOffset': Fraction(0), 'audioDuration': Fraction(1)}
            def render(_runner, _document, _plan, _files, _probes, target, _workdir, progress):
                target.write_bytes(b'mocked encoded video')
                progress(1, 'mocked')
                return {'frames': 24, 'width': 128, 'height': 72, 'audio': 'clips'}
            try:
                with mock.patch('video_edit_jobs.probe', return_value=info), mock.patch('video_edit_jobs.render', side_effect=render), mock.patch('video_edit_jobs.shutil.disk_usage', return_value=SimpleNamespace(free=2**40)):
                    started = jobs.submit({'projectId': 'prj_test', 'nodeId': 'edit', 'inputs': {'v1': f"assets/{'a'*64}.mp4"}, 'document': document})
                    self.assertEqual(jobs.wait(started['id'], 2)['status'], 'completed')
                    with self.assertRaises(StoreError): jobs.commit(started['id'], {'projectId': 'prj_other', 'revision': 7})
                    with self.assertRaises(StoreError): jobs.commit(started['id'], {'projectId': 'prj_test', 'revision': True})
                    jobs.commit(started['id'], {'projectId': 'prj_test', 'revision': 7})
                    self.assertEqual(store.put_asset.call_args.kwargs['expected_revision'], 7)
                    self.assertFalse(any(key.startswith('_') for key in jobs.get(started['id'])))
                    self.assertEqual(jobs.active_count(), 0)
            finally:
                jobs.close()
            self.assertFalse(jobs.worker and jobs.worker.is_alive())

    def test_api_strict_body_and_launcher_guard_precede_dispatch(self):
        api = VideoEditAPI(mock.Mock())
        handler = SimpleNamespace(headers={'Content-Length': '9'}, rfile=BytesIO(b'{"x":NaN}'))
        with self.assertRaises(StoreError): api._json(handler)
        with self.assertRaises(StoreError): api._json(SimpleNamespace(headers={'Content-Length': '999999'}))
        for method in ('do_GET', 'do_POST'):
            instance = object.__new__(WorkbenchHandler)
            instance.guard_request = mock.Mock(return_value=False)
            instance.server = SimpleNamespace(video_edit_api=api)
            instance.path = '/api/video-edit/jobs'
            getattr(instance, method)()
            self.assertFalse(api.jobs.method_calls)

    def test_active_export_blocks_update_and_project_root_change(self):
        server = SimpleNamespace(video_edit_api=SimpleNamespace(jobs=SimpleNamespace(active_count=lambda: 1)), project_store=SimpleNamespace(root=Path('old-project-root').resolve()))
        with self.assertRaises(UpdateError): validate_update_ready(server)
        with self.assertRaises(SettingsError): validate_settings_change(server, {'projectsRoot': 'new-project-root'})
