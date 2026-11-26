import importlib
import threading
from unittest import mock

from PIL import Image

import test_settings_api
import stop
from project_store import StoreError
from test_thumbnail_cache import png
from thumbnail_cache import ThumbnailCache
import video_workbench_launcher as launcher


class VideoLifecycleTests(test_settings_api.SettingsAPITests):
    def create_managers(self):
        managers = {}
        for name in launcher.VIDEO_JOB_KINDS:
            cls = f'Video{name.capitalize()}Jobs'
            job_type = getattr(importlib.import_module(f'video_{name}_jobs'), cls)
            api_type = getattr(importlib.import_module(f'video_{name}_api'), f'Video{name.capitalize()}API')
            manager = job_type(self.root / f'jobs-{name}', self.server.project_store)
            setattr(self.server, f'video_{name}_api', api_type(manager))
            managers[name] = manager
        return managers

    def assert_conflict(self, method, path, payload):
        status, response = self.request(method, path, payload)
        self.assertEqual((status, response.get('code')), (409, 'QUEUE_BUSY'))

    def test_video_jobs_block_maintenance_until_idle(self):
        managers = self.create_managers()
        self.server.update_manager = mock.Mock()
        self.server.update_manager.status.return_value = {'phase': 'idle'}
        def fake_upgrade(tag):
            launcher.validate_update_ready(self.server)
            return {'accepted': True, 'tag': tag}
        self.server.update_manager.apply.side_effect = fake_upgrade
        with mock.patch.object(launcher, 'runtime_dir', return_value=self.root):
            for name, jobs in managers.items():
                for state in ('queued', 'running'):
                    with self.subTest(kind=name, state=state):
                        jobs.jobs['job-test'] = {'status': state}
                        self.assert_conflict('POST', '/api/shutdown', {})
                        self.assert_conflict('POST', '/api/updates/apply', {'tag': 'v9.9.9'})
                        self.assert_conflict('PUT', '/api/settings', {'projectsRoot': str(self.new_projects)})
                        self.assertFalse(self.config_path.exists())
                jobs.jobs['job-test']['status'] = 'completed'
            launcher.validate_update_ready(self.server)
        status, _ = self.request('PUT', '/api/settings', {'projectsRoot': str(self.new_projects)})
        self.assertEqual(status, 200)
        for jobs in managers.values():
            self.assertIs(jobs.store, self.server.project_store)
            self.assertEqual(jobs.jobs, {})
        self.assertEqual(self.request('POST', '/api/shutdown', {})[0], 200)
        self.thread.join(timeout=3)
        self.assertFalse(self.thread.is_alive())

    def test_inflight_video_compute_blocks_maintenance(self):
        self.create_managers()
        entered = threading.Event()
        release = threading.Event()
        responses = []

        def hold_request(handler, path):
            if path != '/api/video-chroma/preview':
                return False
            entered.set()
            release.wait(3)
            handler.send_json(200, {'ok': True})
            return True

        with mock.patch.object(self.server.video_chroma_api, 'handle_post', side_effect=hold_request):
            request = threading.Thread(target=lambda: responses.append(self.request('POST', '/api/video-chroma/preview', {})))
            request.start()
            try:
                self.assertTrue(entered.wait(2))
                self.assert_conflict('POST', '/api/shutdown', {})
                self.assert_conflict('PUT', '/api/settings', {'projectsRoot': str(self.new_projects)})
                self.server.update_manager = mock.Mock()
                self.server.update_manager.status.return_value = {'phase': 'idle'}
                self.server.update_manager.apply.side_effect = lambda _: launcher.validate_update_ready(self.server)
                self.assert_conflict('POST', '/api/updates/apply', {'tag': 'v9.9.9'})
            finally:
                release.set()
                request.join(4)
        self.assertEqual(responses, [(200, {'ok': True})])
        self.assertEqual(self.request('POST', '/api/shutdown', {})[0], 200)

    def test_accepted_idle_shutdown_closes_video_admission(self):
        self.create_managers()
        shutdown = self.server.shutdown
        with mock.patch.object(self.server, 'shutdown') as pending:
            self.assertEqual(self.request('POST', '/api/shutdown', {})[0], 200)
            status, response = self.request('POST', '/api/video-edit/probe', {})
            self.assertEqual((status, response['code']), (409, 'WORKBENCH_STOPPING'))
            pending.assert_called_once_with()
        shutdown()

    def test_shutdown_does_not_wait_behind_lifecycle_operation(self):
        with self.server.video_lifecycle_lock:
            status, response = self.request('POST', '/api/shutdown', {})
        self.assertEqual((status, response['code']), (409, 'WORKBENCH_BUSY'))

    def test_desktop_stop_respects_real_refusal_and_unconfirmed_shutdown(self):
        jobs = self.create_managers()['edit']
        jobs.jobs['job-test'] = {'status': 'running'}
        instance = {'pid': 1, 'port': self.server.server_port, 'token': self.server.token}
        with mock.patch.object(stop, 'read_instance', return_value=instance), \
                mock.patch.object(stop, 'own_process') as own, \
                mock.patch.object(stop, 'remove_instance') as remove:
            self.assertEqual(stop.main(), 1)
            with mock.patch.object(stop.urllib.request, 'urlopen', side_effect=TimeoutError):
                self.assertEqual(stop.main(), 1)
            own.assert_not_called()
            remove.assert_not_called()
        self.assertTrue(self.thread.is_alive())

    def test_idle_update_can_begin_restart(self):
        self.create_managers()
        self.server.update_manager = mock.Mock()
        self.server.update_manager.status.return_value = {'phase': 'idle'}
        def apply(tag):
            launcher.validate_update_ready(self.server)
            return {'accepted': True, 'tag': tag}
        self.server.update_manager.apply.side_effect = apply
        restart = mock.patch.object(launcher, 'begin_update_restart') if hasattr(launcher, 'begin_update_restart') else mock.patch.object(self.server, 'shutdown')
        with mock.patch.object(launcher, 'runtime_dir', return_value=self.root), restart:
            status, response = self.request('POST', '/api/updates/apply', {'tag': 'v9.9.9'})
            self.assertEqual(status, 200)
            self.assertTrue(response['accepted'])
        self.assertTrue(self.server.video_stopping)

    def test_thumbnail_reads_two_project_roots(self):
        old = self.server.project_store
        cache = ThumbnailCache(self.root / 'thumbnails', old, 'http://127.0.0.1:1')
        self.server.thumbnail_cache = cache
        def create_query(store, name, color):
            row = store.create(name)
            (store.root / name / 'assets' / 'source.png').write_bytes(png(color, (64, 64)))
            return {'project': row['id'], 'asset': 'assets/source.png'}
        old_query = create_query(old, 'red-project', 'red')
        with Image.open(cache.get(old_query)) as image:
            self.assertGreater(image.getpixel((0, 0))[0], 200)
        self.assertEqual(self.request('PUT', '/api/settings', {'projectsRoot': str(self.new_projects)})[0], 200)
        self.assertIs(cache.store, self.server.project_store)
        new_query = create_query(self.server.project_store, 'blue-project', 'blue')
        with Image.open(cache.get(new_query)) as image:
            self.assertGreater(image.getpixel((0, 0))[2], 200)
        with self.assertRaises(StoreError):
            cache.get(old_query)
        self.assertTrue((old.root / 'red-project' / 'project.json').is_file())
