import io
import json
import tempfile
import unittest
import stat
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch, Mock

from project_api import ProjectAPI, reveal_asset_in_windows
from project_store import ProjectStore, StoreError


class Handler:
    def __init__(self, asset_path):
        body = json.dumps({'assetPath': asset_path}).encode()
        self.headers = {'Content-Length': str(len(body))}
        self.rfile = io.BytesIO(body)

    def send_json(self, status, body):
        self.status, self.body = status, body


class ProjectFileLocationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = ProjectStore(self.temp.name)
        self.addCleanup(self.store.close)
        self.project = self.store.create('synthetic project')['id']
        self.asset = self.store.put_asset(self.project, 'clip.mp4', io.BytesIO(b'fixture'))['asset']['path']
        self.api = ProjectAPI(self.store)

    def request(self, value, project=None):
        handler = Handler(value)
        self.api.handle_post(handler, f'/api/projects/{project or self.project}/assets/reveal')
        return handler

    def test_native_selection_hresult_and_cleanup(self):
        import ctypes
        for initialized, parsed, selected in [(0, 0, 0), (1, 0, 0), (-2147417850, 0, 0), (0, -1, 0), (0, 0, -1), (-1, 0, 0)]:
            with self.subTest(initialized=initialized, parsed=parsed, selected=selected):
                ole, shell = Mock(), Mock()
                ole.CoInitializeEx.return_value = initialized
                def parse(path, context, target, flags, attributes):
                    self.assertEqual(path, 'C:/test folder/中文 · project/assets/clip.mp4')
                    ctypes.cast(target, ctypes.POINTER(ctypes.c_void_p))[0] = 1234
                    return parsed
                shell.SHParseDisplayName.side_effect = parse
                shell.SHOpenFolderAndSelectItems.return_value = selected
                with patch('ctypes.WinDLL', side_effect=[ole, shell], create=True):
                    if initialized == -1 or parsed < 0 or selected < 0:
                        with self.assertRaises(StoreError):
                            reveal_asset_in_windows('C:/test folder/中文 · project/assets/clip.mp4')
                    else:
                        reveal_asset_in_windows('C:/test folder/中文 · project/assets/clip.mp4')
                self.assertEqual(ole.CoUninitialize.call_count, int(initialized >= 0))
                self.assertEqual(ole.CoTaskMemFree.call_count, int(initialized != -1))
                self.assertEqual(shell.SHOpenFolderAndSelectItems.call_count, int(initialized != -1 and parsed >= 0))
                if shell.SHOpenFolderAndSelectItems.called:
                    args = shell.SHOpenFolderAndSelectItems.call_args.args
                    self.assertEqual(args[0].value, 1234)
                    self.assertEqual(args[1:], (0, None, 0))

    def test_project_asset_reveal_and_rejections(self):
        with tempfile.TemporaryDirectory() as root:
            store = ProjectStore(root)
            try:
                current = store.create('current project with spaces')['id']
                other = store.create('other')['id']
                asset = store.put_asset(current, 'clip.mp4', io.BytesIO(b'fixture'))['asset']['path']
                api = ProjectAPI(store)
                with patch('project_api.reveal_asset_in_windows') as launch:
                    handler = Handler(asset)
                    self.assertTrue(api.handle_post(handler, f'/api/projects/{current}/assets/reveal'))
                    self.assertEqual(handler.status, 200)
                    launch.assert_called_once_with(store.asset_file(current, asset))
                    launch.reset_mock()
                    for project, path in [(current, '../other/' + asset), (current, '/tmp/file'), (current, 'C:/private/file.mp4'), (current, 'assets/missing.mp4'), (other, asset), (current, None), (current, {})]:
                        with self.subTest(project=project, path=path):
                            handler = Handler(path)
                            api.handle_post(handler, f'/api/projects/{project}/assets/reveal')
                            self.assertIn(handler.status, (400, 404))
                            launch.assert_not_called()
            finally:
                store.close()

    def test_links_and_reparse_components_never_reach_shell(self):
        project = self.store._project_path(self.project)
        candidate = project.parent / self.asset
        original = Path.lstat
        for target, mode, attributes in [(candidate, stat.S_IFLNK, 0), (candidate.parent, stat.S_IFDIR, 0x400),
                                         (project, stat.S_IFLNK, 0), (project.parent, stat.S_IFDIR, 0x400)]:
            def lstat(path, *args, **kwargs):
                return SimpleNamespace(st_mode=mode, st_file_attributes=attributes) if path == target else original(path, *args, **kwargs)
            with self.subTest(target=target.name), patch.object(Path, 'lstat', lstat), patch('project_api.reveal_asset_in_windows') as shell:
                handler = self.request(self.asset)
                self.assertEqual(handler.status, 400)
                shell.assert_not_called()

    def test_stale_project_and_filesystem_failure_are_redacted(self):
        self.store._opened_paths['prj_stale'] = self.store._project_path(self.project)
        with patch('project_api.reveal_asset_in_windows') as shell:
            handler = self.request(self.asset, 'prj_stale')
            self.assertEqual(handler.status, 404)
            shell.assert_not_called()
        with patch('project_api.reveal_asset_in_windows', side_effect=OSError('sensitive-local-path')):
            handler = self.request(self.asset)
        self.assertEqual(handler.status, 400)
        self.assertNotIn('sensitive-local-path', json.dumps(handler.body))
        self.assertNotIn(self.temp.name, json.dumps(handler.body))

    def test_extra_fields_and_invalid_paths_are_not_echoed(self):
        for value in ('../private', '/private/file.png', 'C:/private/file.png', r'\\server\private', {}, None):
            with self.subTest(value=value), patch('project_api.reveal_asset_in_windows') as shell:
                handler = self.request(value)
                self.assertEqual(handler.status, 400)
                self.assertEqual(handler.body['details'], {})
                self.assertNotIn('private', json.dumps(handler.body))
                shell.assert_not_called()
        handler = Handler(self.asset)
        body = json.dumps({'assetPath': self.asset, 'path': 'private'}).encode()
        handler.rfile = io.BytesIO(body)
        handler.headers['Content-Length'] = str(len(body))
        with patch('project_api.reveal_asset_in_windows') as shell:
            self.api.handle_post(handler, f'/api/projects/{self.project}/assets/reveal')
            self.assertEqual(handler.status, 400)
            shell.assert_not_called()

    def test_existing_project_reveal_and_request_auth_are_preserved(self):
        from video_workbench_launcher import WorkbenchHandler
        handler = Handler(self.asset)
        with patch('project_api.subprocess.Popen') as explorer:
            self.api.handle_post(handler, f'/api/projects/{self.project}/reveal')
            self.assertEqual(handler.status, 200)
            self.assertEqual(explorer.call_args.args[0][0], 'explorer.exe')
        probe = SimpleNamespace(path=f'/api/projects/{self.project}/assets/reveal', command='POST',
            server=SimpleNamespace(server_port=8799, token='synthetic-token'),
            headers={'Host':'127.0.0.1:8799','Origin':'http://127.0.0.1:8799','Content-Type':'application/json','Content-Length':'20'},
            send_json=Mock())
        self.assertFalse(WorkbenchHandler.guard_request(probe, write=True))
        self.assertEqual(probe.send_json.call_args.args[0], 401)
        probe.headers['X-H3-Token'] = 'synthetic-token'
        self.assertTrue(WorkbenchHandler.guard_request(probe, write=True))
        probe.headers['Origin'] = 'https://example.invalid'
        self.assertFalse(WorkbenchHandler.guard_request(probe, write=True))
        self.assertEqual(probe.send_json.call_args.args[0], 403)


if __name__ == '__main__':
    unittest.main()
