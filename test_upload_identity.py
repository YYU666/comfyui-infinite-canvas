import io
import json
import unittest
from email.parser import BytesParser
from email.policy import default
from unittest.mock import patch

from workbench_queue import ComfyQueueAdapter


class UploadIdentityTests(unittest.TestCase):
    def test_same_basename_preserves_prior_bytes_and_uses_server_name(self):
        files = {}

        def upload(request, timeout):
            self.assertEqual(request.full_url, 'http://fixture/upload/image')
            message = BytesParser(policy=default).parsebytes(
                ('Content-Type: ' + request.get_header('Content-type') + '\r\n\r\n').encode() + request.data)
            fields = {part.get_param('name', header='content-disposition'): part for part in message.iter_parts()}
            self.assertEqual(fields['overwrite'].get_payload(decode=True), b'false')
            self.assertEqual(fields['type'].get_payload(decode=True), b'input')
            self.assertEqual(fields['subfolder'].get_payload(decode=True), b'workbench')
            name = original = fields['image'].get_filename()
            content = fields['image'].get_payload(decode=True)
            index = 1
            while name in files and files[name] != content:
                stem, extension = original.rsplit('.', 1)
                name = f'{stem} ({index}).{extension}'
                index += 1
            files[name] = content
            return io.BytesIO(json.dumps({'name': name, 'subfolder': 'workbench'}).encode())

        adapter = ComfyQueueAdapter('http://fixture')
        with patch('workbench_queue.urllib.request.urlopen', side_effect=upload):
            first = adapter.upload_image('save_00001_.png', b'first result')
            second = adapter.upload_image('save_00001_.png', b'second result')
            duplicate = adapter.upload_image('save_00001_.png', b'first result')
        self.assertEqual(first, 'workbench/save_00001_.png')
        self.assertEqual(second, 'workbench/save_00001_ (1).png')
        self.assertEqual(duplicate, first)
        self.assertEqual(files, {'save_00001_.png': b'first result', 'save_00001_ (1).png': b'second result'})


if __name__ == '__main__':
    unittest.main()
