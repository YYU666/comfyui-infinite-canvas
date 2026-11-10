import concurrent.futures
import contextlib
import os
import errno
import socket
import time
import json
import tempfile
import threading
import unittest
import sys
from pathlib import Path
from unittest.mock import Mock, patch
sys.path.insert(0, str(Path(__file__).resolve().parent))

from workbench_comfy_lifecycle import ComfyLifecycle, missing_assets_migration, sanitized_url, startup_obstacle, supports_disable_assets, prune_attempt_logs
from workbench_lifecycle import request_comfy_start
import test_workbench_security as security_fixture


ASSETS = "ASSETS_STARTUP_FAILED: other\nPath doesn't exist: C:/synthetic/ComfyUI/alembic_db."


class ComfyLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.children = []
        self.logs = []
        self.ready = False
        self.exit_code = None
        self.log_text = ""
        self.spawn = Mock(side_effect=self.make_child)
        self.probe = Mock(side_effect=lambda url: self.ready)
        self.obstacle = Mock(return_value="")
        self.manager = ComfyLifecycle(url='http://127.0.0.1:8188', root=self.root, log_dir=self.root,
            command=['python', 'main.py'], spawn=self.spawn, probe=self.probe,
            obstacle=self.obstacle, supports=lambda root: True, timeout=0.04, interval=0.001)

    def tearDown(self):
        self.manager.close()
        self.temp.cleanup()

    def make_child(self, command, root, log):
        process = Mock(pid=100 + len(self.children))
        process.poll.return_value = self.exit_code
        logger = Mock()
        log.write_text(self.log_text, encoding='utf-8')
        self.logs.append(log)
        self.children.append(process)
        return process, logger

    def finish(self):
        self.manager.request_start()
        self.manager._thread.join(3)
        self.assertFalse(self.manager._thread.is_alive())
        return self.manager.status()

    def test_alive_child_not_ready_and_timeout_never_restarts_or_kills(self):
        status = self.finish()
        self.assertEqual(status['state'], 'timeout')
        self.assertTrue(status['running'])
        self.assertFalse(status['ready'])
        self.assertEqual(status['pid'], 100)
        self.assertTrue(status['lastCheckedAt'])
        self.assertEqual(self.finish()['state'], 'unresponsive')
        self.assertEqual(self.spawn.call_count, 1)
        self.children[0].terminate.assert_not_called()
        self.children[0].kill.assert_not_called()
        self.ready = True
        self.manager.status(refresh=True)
        self.manager._refresh_thread.join(1)
        self.assertTrue(self.manager.status()['ready'])

    def test_single_flight_concurrent_requests(self):
        gate = threading.Event()
        self.manager.probe = lambda url: (gate.wait(0.15), False)[1]
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(lambda _: self.manager.request_start(), range(12)))
        gate.set()
        self.manager._thread.join(3)
        self.assertEqual(self.spawn.call_count, 1)

    def test_external_ready_is_reused_without_ownership(self):
        self.ready = True
        status = self.finish()
        self.assertEqual(status['state'], 'ready')
        self.assertFalse(status['owned'])
        self.spawn.assert_not_called()

    def test_unready_listener_or_existing_process_prevents_spawn(self):
        self.obstacle.return_value = '占用，请检查现有进程'
        self.assertEqual(self.finish()['state'], 'port_conflict')
        self.spawn.assert_not_called()

    def test_process_exit_is_public_safe_and_has_exit_code(self):
        self.exit_code = 7
        self.log_text = 'CUDA failure api_key=secret-value C:/private/path'
        status = self.finish()
        self.assertEqual((status['state'], status['exitCode']), ('exited', 7))
        self.assertNotIn('secret-value', json.dumps(status))
        self.assertNotIn('C:/private', json.dumps(status))
        self.assertEqual(self.spawn.call_count, 1)

    def test_recognized_assets_error_gets_only_one_supported_fallback(self):
        self.exit_code = 1
        self.log_text = ASSETS
        status = self.finish()
        self.assertEqual(self.spawn.call_count, 2)
        self.assertNotIn('--disable-assets', self.spawn.call_args_list[0].args[0])
        self.assertIn('--disable-assets', self.spawn.call_args_list[1].args[0])
        self.assertTrue(status['degraded'])
        self.assertIn('素材库', status['warning'])
        self.assertEqual(len(set(self.logs)), 2)

    def test_successful_degraded_start_clears_old_exit_code(self):
        self.exit_code = 1
        self.log_text = ASSETS
        def spawn(*args):
            if self.children:
                self.exit_code = None
                self.ready = True
            return self.make_child(*args)
        self.spawn.side_effect = spawn
        status = self.finish()
        self.assertEqual(status['state'], 'ready')
        self.assertIsNone(status['exitCode'])
        self.assertTrue(status['degraded'])

    def test_unsupported_or_unrecognized_error_never_falls_back(self):
        self.exit_code = 1
        self.log_text = ASSETS
        self.manager.supports = lambda root: False
        self.finish()
        self.assertEqual(self.spawn.call_count, 1)

    def test_stale_markers_in_prior_log_cannot_trigger_fallback(self):
        (self.root / 'comfyui.log').write_text(ASSETS, encoding='utf-8')
        self.exit_code = 1
        self.log_text = 'new attempt CUDA failed'
        self.finish()
        self.assertEqual(self.spawn.call_count, 1)

    def test_spawn_error_is_allowlisted(self):
        self.spawn.side_effect = RuntimeError('token=private-value C:/private/user')
        status = self.finish()
        self.assertEqual(status['state'], 'failed')
        self.assertNotIn('private-value', json.dumps(status))
        self.assertNotIn('C:/private', json.dumps(status))

    def test_disabled_manager_never_probes_or_starts(self):
        self.manager.enabled = False
        self.manager._state['state'] = 'disabled'
        self.assertEqual(self.manager.request_start()['state'], 'disabled')
        self.manager.status(refresh=True)
        self.probe.assert_not_called()
        self.spawn.assert_not_called()

    def test_shutdown_disables_pending_or_future_start(self):
        self.manager.close()
        self.manager.request_start()
        self.spawn.assert_not_called()

    def test_exited_owned_process_replaced_externally_drops_ownership(self):
        self.exit_code = 1
        self.log_text = ASSETS
        self.finish()
        self.ready = True
        self.manager.status(refresh=True)
        self.manager._refresh_thread.join(1)
        status = self.manager.status()
        self.assertEqual(status['state'], 'ready')
        self.assertFalse(status['owned'])
        self.assertIsNone(status['pid'])
        self.assertIsNone(status['exitCode'])
        self.assertFalse(status['degraded'])
        self.assertEqual(status['warning'], '')

    def test_main_shutdown_uses_latest_fallback_child_and_logger(self):
        import video_workbench_launcher as launcher
        self.exit_code = 1
        self.log_text = ASSETS
        self.finish()
        child = self.children[1]
        child.poll.return_value = None
        logger = self.manager.logger
        dist = self.root / 'dist'
        dist.mkdir()
        (dist / 'index.html').write_text('fixture')
        server = Mock(server_port=8799)
        server.serve_forever.side_effect = KeyboardInterrupt
        settings = Mock(data={'comfyRoot':str(self.root),'logLevel':'INFO','projectsRoot':str(self.root / 'projects'),
                              'defaults':{},'modelRoots':[],'queue':{'concurrency':1}})
        with contextlib.ExitStack() as stack:
            stack.enter_context(patch.dict(os.environ, {'H3_WORKBENCH_NO_BROWSER':'1','H3_WORKBENCH_DIST_DIR':str(dist)}))
            stack.enter_context(patch.object(launcher, 'ROOT', self.root))
            stack.enter_context(patch.object(launcher, 'INPUT_DIR', self.root / 'input'))
            stack.enter_context(patch.object(launcher, 'OUTPUT_DIR', self.root / 'output'))
            for name in ['cleanup_legacy_comfy_logs','atomic_write_json','remove_instance','ProjectStore','ProjectAPI','ArtDirectorAPI','ThumbnailCache','WorkbenchDoctor','QueueManager','QueueAPI','AgentAPI','ExtensionAPI','ExtensionStore','WorkbenchUpdateManager']:
                stack.enter_context(patch.object(launcher, name))
            stack.enter_context(patch.object(launcher, 'configure_logging', return_value=self.root))
            stack.enter_context(patch.object(launcher, 'runtime_dir', return_value=self.root))
            stack.enter_context(patch.object(launcher, 'instance_path', return_value=self.root / 'instance.json'))
            stack.enter_context(patch.object(launcher, 'startup_guard', return_value=contextlib.nullcontext()))
            stack.enter_context(patch.object(launcher, 'read_instance', return_value=None))
            stack.enter_context(patch.object(launcher, 'workbench_ports', return_value=[8799]))
            stack.enter_context(patch.object(launcher, 'WorkbenchServer', return_value=server))
            stack.enter_context(patch.object(launcher, 'WorkbenchSettings', return_value=settings))
            stack.enter_context(patch.object(launcher, 'ComfyLifecycle', return_value=self.manager))
            stack.enter_context(patch.object(self.manager, 'request_start', return_value=self.manager.status()))
            stop = stack.enter_context(patch.object(launcher, 'stop_owned_comfy', return_value='preserved-active'))
            stop_log = stack.enter_context(patch.object(launcher, 'stop_comfy_logger'))
            self.assertEqual(launcher.main(), 0)
            stop.assert_called_once_with(child)
            stop_log.assert_called_once_with(logger, 'preserved-active')
        self.assertIs(self.manager.process, child)

    def test_fallback_rechecks_port_and_never_overlaps_process(self):
        self.exit_code = 1
        self.log_text = ASSETS
        self.obstacle.side_effect = ['', '', '端口已有其他进程']
        self.assertEqual(self.finish()['state'], 'port_conflict')
        self.assertEqual(self.spawn.call_count, 1)
        self.assertEqual(self.children[0].poll(), 1)

    def test_attempt_log_retention_includes_rotated_segments(self):
        for index in range(9):
            for suffix in ['', '.1', '.2']:
                (self.root / f'comfyui-20261110-120000-{index:08x}.log{suffix}').write_text('fixture')
        unrelated = self.root / 'unrelated.log'
        unrelated.write_text('keep')
        prune_attempt_logs(self.root)
        self.assertEqual(len(list(self.root.glob('comfyui-*'))), 15)
        self.assertTrue(unrelated.exists())

    def test_flag_support_requires_declared_argument(self):
        path = self.root / 'ComfyUI/comfy/cli_args.py'
        path.parent.mkdir(parents=True)
        path.write_text('parser.add_argument("--disable-assets", action="store_true")')
        self.assertTrue(supports_disable_assets(self.root))
        path.write_text('# --disable-assets not supported')
        self.assertFalse(supports_disable_assets(self.root))

    def test_error_requires_both_markers(self):
        path = self.root / 'error.log'
        for text in ['ASSETS_STARTUP_FAILED: CUDA', 'alembic_db not found', 'ASSETS_STARTUP_FAILED: permission denied alembic_db']:
            path.write_text(text)
            self.assertFalse(missing_assets_migration(path))

    def test_url_drops_credentials_query_and_path(self):
        self.assertEqual(sanitized_url('http://user:secret@localhost:8188/private?token=abc'), 'http://localhost:8188')

    def test_port_and_existing_process_guard(self):
        reservation = Mock()
        reservation.__enter__ = Mock(return_value=reservation)
        reservation.__exit__ = Mock(return_value=False)
        reservation.bind.side_effect = OSError(errno.EADDRINUSE, 'occupied')
        with patch('workbench_comfy_lifecycle.socket.socket', return_value=reservation):
            self.assertIn('占用', startup_obstacle(self.manager.url, self.root))
        reservation.bind.side_effect = None
        process = Mock(info={'cmdline':['python', str(self.root / 'ComfyUI/main.py')], 'cwd':str(self.root)})
        with patch('workbench_comfy_lifecycle.socket.socket', return_value=reservation), patch('workbench_comfy_lifecycle.psutil.process_iter', return_value=[process]):
            self.assertIn('进程已存在', startup_obstacle(self.manager.url, self.root))

    def test_windows_empty_port_timeout_does_not_block_exclusive_bind(self):
        reservation = Mock()
        reservation.__enter__ = Mock(return_value=reservation)
        reservation.__exit__ = Mock(return_value=False)
        with patch('workbench_comfy_lifecycle.socket.create_connection', side_effect=TimeoutError) as connect, patch('workbench_comfy_lifecycle.socket.socket', return_value=reservation), patch('workbench_comfy_lifecycle.psutil.process_iter', return_value=[]):
            self.assertEqual(startup_obstacle(self.manager.url, self.root), '')
            connect.assert_not_called()
            reservation.bind.assert_called_once_with(('127.0.0.1',8188))
            if hasattr(socket, 'SO_EXCLUSIVEADDRUSE'):
                reservation.setsockopt.assert_called_once_with(socket.SOL_SOCKET,socket.SO_EXCLUSIVEADDRUSE,1)
            reservation.listen.assert_not_called()
            reservation.__exit__.assert_called_once()

    def test_unknown_bind_error_fails_closed(self):
        reservation = Mock()
        reservation.__enter__ = Mock(return_value=reservation)
        reservation.__exit__ = Mock(return_value=False)
        reservation.bind.side_effect = OSError(errno.EACCES, 'access denied')
        with patch('workbench_comfy_lifecycle.socket.socket', return_value=reservation):
            self.assertIn('无法确认', startup_obstacle(self.manager.url, self.root))

    def test_concurrent_health_is_immediate_single_flight(self):
        gate = threading.Event()
        entered = threading.Event()
        def probe(url):
            entered.set()
            gate.wait(2)
            return False
        self.manager.probe = Mock(side_effect=probe)
        started = time.monotonic()
        self.manager.status(refresh=True)
        self.assertTrue(entered.wait(1))
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda _: self.manager.status(refresh=True), range(16)))
        self.assertLess(time.monotonic()-started, 0.5)
        self.assertEqual(self.manager.probe.call_count,1)
        self.assertEqual(len(results),16)
        gate.set()
        self.manager._refresh_thread.join(1)

    def test_startup_network_probe_does_not_hold_health_lock(self):
        gate = threading.Event()
        entered = threading.Event()
        def probe(url):
            entered.set()
            gate.wait(2)
            return False
        self.manager.probe = probe
        self.manager.request_start()
        self.assertTrue(entered.wait(1))
        started = time.monotonic()
        self.assertEqual(self.manager.status(refresh=True)['state'],'starting')
        self.manager.request_start()
        self.assertLess(time.monotonic()-started,0.5)
        gate.set()
        self.manager._thread.join(2)
        self.assertEqual(self.spawn.call_count,1)

    def test_closed_manager_ignores_late_refresh(self):
        gate = threading.Event()
        entered = threading.Event()
        def probe(url):
            entered.set()
            gate.wait(2)
            return True
        self.manager.probe = probe
        self.manager.status(refresh=True)
        self.assertTrue(entered.wait(1))
        closer = threading.Thread(target=self.manager.close)
        closer.start()
        self.assertTrue(self.manager._stop.wait(1))
        gate.set()
        closer.join(1)
        self.assertEqual(self.manager.status()['state'],'stopped')

    def test_old_refresh_cannot_overwrite_new_start(self):
        gate = threading.Event()
        entered = threading.Event()
        def probe(url):
            if threading.current_thread().name == 'comfy-health':
                entered.set()
                gate.wait(2)
                return True
            return False
        self.manager.probe = probe
        self.manager.status(refresh=True)
        self.assertTrue(entered.wait(1))
        self.finish()
        gate.set()
        self.manager._refresh_thread.join(1)
        self.assertEqual(self.manager.status()['state'],'timeout')


class ComfyStartEndpointTests(unittest.TestCase):
    setUp = security_fixture.SecurityProbeTests.setUp
    tearDown = security_fixture.SecurityProbeTests.tearDown
    request = security_fixture.SecurityProbeTests.request
    json_headers = security_fixture.SecurityProbeTests.json_headers

    def test_start_endpoint_requires_auth_origin_and_content_type(self):
        self.server.comfy_lifecycle = Mock()
        self.server.comfy_lifecycle.request_start.return_value = {'state':'starting'}
        for headers, expected in [(self.json_headers(False),401), ({**self.json_headers(), 'Origin':'https://evil.example'},403), ({**self.json_headers(), 'Content-Type':'text/plain'},415)]:
            self.assertEqual(self.request('POST','/api/local-comfy/start',{},headers)[0],expected)
        self.server.comfy_lifecycle.request_start.assert_not_called()
        status, _, body = self.request('POST','/api/local-comfy/start',{},self.json_headers())
        self.assertEqual((status,body['state']),(202,'starting'))
        self.server.comfy_lifecycle.request_start.assert_called_once()

    def test_health_exposes_allowlisted_status_without_auth(self):
        self.server.started_at = 'fixture'
        self.server.comfy_owned = False
        self.server.comfy_process = None
        self.server.comfy_lifecycle = Mock()
        self.server.comfy_lifecycle.process = None
        self.server.comfy_lifecycle.status.return_value = {'owned':False,'state':'exited','exitCode':1,'error':'启动失败','pid':123,'url':'http://127.0.0.1:8188','lastCheckedAt':'fixture'}
        status,_,body = self.request('GET','/api/health')
        self.assertEqual(status,200)
        self.assertEqual(body['comfy']['exitCode'],1)

    def test_external_replacement_clears_instance_ownership(self):
        import os
        from video_workbench_launcher import sync_comfy_ownership
        self.server.comfy_lifecycle = Mock(process=None)
        self.server.comfy_process = Mock(pid=123)
        self.server.comfy_owned = True
        with patch('video_workbench_launcher.read_instance', return_value={'pid':os.getpid(),'comfyOwned':True,'comfyPid':123}), patch('video_workbench_launcher.atomic_write_json') as write:
            sync_comfy_ownership(self.server, {'owned':False})
        self.assertFalse(write.call_args.args[1]['comfyOwned'])
        self.assertIsNone(write.call_args.args[1]['comfyPid'])
        self.assertIsNone(self.server.comfy_process)

    def test_missing_external_service_can_request_managed_start(self):
        with patch('workbench_lifecycle.urllib.request.urlopen') as request:
            request_comfy_start({'port':8790,'token':'fixture'}, {'comfy':{'state':'unresponsive','owned':False,'running':False}})
            request.assert_called_once()

    def test_reused_backend_hint_is_authenticated_once_and_legacy_compatible(self):
        instance = {'port':8790,'token':'fixture-token'}
        response = Mock(status=202)
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        with patch('workbench_lifecycle.urllib.request.urlopen', return_value=response) as request:
            self.assertTrue(request_comfy_start(instance,{'comfy':{'state':'exited'}}))
            self.assertEqual(request.call_args.args[0].get_header('X-h3-token'),'fixture-token')
            for health in [{}, {'comfy':{'enabled':False,'state':'exited'}}, {'comfy':{'state':'starting'}}, {'comfy':{'state':'timeout','owned':True,'running':True}}]:
                self.assertFalse(request_comfy_start(instance,health))
            self.assertEqual(request.call_count,1)
            self.assertTrue(request_comfy_start(instance, {'comfy':{'state':'ready','owned':False,'running':True}}))
            self.assertEqual(request.call_count,2, 'explicit reuse also rechecks potentially stale ready cache')


class ComfyPackageTests(unittest.TestCase):
    def test_update_package_requires_registered_lifecycle_module(self):
        from scripts.build_update_package import tracked_files
        required = ['video_workbench_launcher.py','workbench_update.py','workbench_update_helper.py',
                    'workbench_lifecycle.py','package.json','package-lock.json','requirements.lock']
        result = Mock(returncode=0, stdout=('\0'.join(required)+'\0').encode('utf-8'))
        with patch('scripts.build_update_package.subprocess.run', return_value=result):
            with self.assertRaisesRegex(RuntimeError, '更新必需文件'):
                tracked_files()
            result.stdout = ('\0'.join(required+['workbench_comfy_lifecycle.py'])+'\0').encode('utf-8')
            self.assertIn('workbench_comfy_lifecycle.py',tracked_files())


if __name__ == '__main__':
    unittest.main()
