import io
import json
import tempfile
import unittest
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


if __name__ == '__main__':
    unittest.main()
