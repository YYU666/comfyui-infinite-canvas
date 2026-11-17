"""Launcher contracts with subprocess/decoder mocked; no service or browser."""
import io
import json
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import video_workbench_launcher as launcher


class BrowserVideoImportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.file = self.root / 'fixture.mp4'
        self.url = 'https://www.douyin.com/video/123'

    def test_ffmpeg_is_passed_to_fresh_browser_without_profile_arguments(self):
        def run(command, **options):
            self.assertEqual(command[-2:], ['--ffmpeg', 'synthetic-ffmpeg'])
            self.assertIn('--url', command)
            self.assertNotIn('--user-data-dir', command)
            self.assertNotIn('--storage-state', command)
            self.assertEqual(options['timeout'], 180)
            self.file.write_bytes(b'synthetic')
            return SimpleNamespace(returncode=0, stdout=json.dumps({'title':'public clip','size':9,'duration':2,'awemeId':'123'}), stderr='')
        with patch.object(launcher.shutil, 'which', return_value='synthetic-node'), \
             patch.object(launcher.imageio_ffmpeg, 'get_ffmpeg_exe', return_value='synthetic-ffmpeg'), \
             patch.object(launcher.subprocess, 'run', side_effect=run):
            result = launcher.import_douyin_with_browser(self.url, self.root, 'fixture')
        self.assertEqual(result['size'], 9)
        self.assertEqual(result['name'], 'fixture.mp4')

    def test_subprocess_error_or_timeout_deletes_partial_and_redacts_details(self):
        for value in [SimpleNamespace(returncode=1,stdout='',stderr='https://cdn.invalid/video?token=synthetic-secret C:/private/file.mp4'),
                      subprocess.TimeoutExpired(['synthetic'], 180)]:
            self.file.write_bytes(b'partial')
            with self.subTest(value=type(value).__name__), patch.object(launcher.shutil, 'which', return_value='synthetic-node'), \
                 patch.object(launcher.imageio_ffmpeg, 'get_ffmpeg_exe', return_value='synthetic-ffmpeg'), \
                 patch.object(launcher.subprocess, 'run', side_effect=value if isinstance(value, Exception) else None, return_value=value):
                with self.assertRaises(RuntimeError) as caught:
                    launcher.import_douyin_with_browser(self.url, self.root, 'fixture')
                self.assertNotIn('synthetic-secret', str(caught.exception))
                self.assertNotIn('C:/private', str(caught.exception))
                self.assertFalse(self.file.exists())

    def test_invalid_metadata_and_incomplete_size_never_succeed(self):
        for output in ['not-json', json.dumps({'size':100})]:
            self.file.write_bytes(b'partial')
            with patch.object(launcher.shutil, 'which', return_value='synthetic-node'), \
                 patch.object(launcher.imageio_ffmpeg, 'get_ffmpeg_exe', return_value='synthetic-ffmpeg'), \
                 patch.object(launcher.subprocess, 'run', return_value=SimpleNamespace(returncode=0,stdout=output,stderr='')):
                with self.assertRaises(RuntimeError):
                    launcher.import_douyin_with_browser(self.url, self.root, 'fixture')
                self.assertFalse(self.file.exists())


if __name__ == '__main__':
    unittest.main()
