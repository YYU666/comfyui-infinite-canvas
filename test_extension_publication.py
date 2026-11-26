import io
import hashlib
import base64
import json
import unittest
import urllib.error
import zipfile
from unittest.mock import Mock, patch

from extension_api import ExtensionAPI
from extension_publication import MAX_RESPONSE, publication_status
from test_extension_api import Handler
from workflow_extensions import ExtensionError


class PublicationTests(unittest.TestCase):
    def setUp(self):
        self.package_id = 'artist/four-view'
        self.payload = {'packageId': self.package_id, 'version': '0.2.0', 'mode': 'update'}
        self.store = Mock()
        self.manifest = {'packageId': self.package_id, 'version': '0.2.0', 'nodes': [{'definition': 'nodes/workflow.json', 'workflow': 'workflows/workflow.json'}]}
        self.definition = {'name': 'public workflow'}
        self.workflow = {'load': {'class_type': 'LoadImage', 'inputs': {'image': 'input.png'}}, 'save': {'class_type': 'SaveImage', 'inputs': {'images': ['load', 0], 'filename_prefix': 'H3/extensions/shared'}}}
        self.files = {'manifest.json': self.manifest, 'nodes/workflow.json': self.definition, 'workflows/workflow.json': self.workflow, 'README.md': 'Public workflow.', 'LICENSE': 'Apache-2.0'}
        self.archive()

    def archive(self):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, 'w') as package:
            for name, value in self.files.items():
                package.writestr(name, value if isinstance(value, (str, bytes)) else json.dumps(value))
        content = buffer.getvalue()
        self.digest = hashlib.sha256(content).hexdigest()
        self.store.download.return_value = content
        self.store.get.return_value = {'digest': self.digest, 'manifest': self.manifest, 'nodes': [{'definition': self.definition, 'workflow': self.workflow}]}

    def row(self, version='0.1.0', digest=None):
        return {'packageId': self.package_id, 'version': version, 'digest': 'sha256:' + (digest or 'b' * 64), 'status': 'published', 'manifest': {'private': 'do not return'}, 'preview': 'do not return'}

    def check(self, listing, exact=None, payload=None):
        with patch('extension_publication._public_json', side_effect=[listing, exact]) as fetch:
            result = publication_status(self.store, self.digest, payload or self.payload)
        self.assertEqual(fetch.call_count, 2)
        self.assertNotIn('manifest', result)
        self.assertNotIn('preview', result)
        return result

    def test_newer_update_ready_and_exact_publication_idempotent(self):
        self.assertEqual(self.check({'items': [self.row()]})['status'], 'ready')
        exact = self.row('0.2.0', self.digest)
        result = self.check({'items': [self.row(), exact]}, exact)
        self.assertEqual(result['status'], 'published')
        self.assertEqual(result['digest'], self.digest)
        # Recover an upload whose response was lost, even if listing lags.
        self.assertEqual(self.check({'items': [self.row()]}, exact)['status'], 'published')

    def test_missing_package_needs_explicit_first_publish(self):
        for listing in (None, {'items': []}):
            with self.assertRaisesRegex(ExtensionError, '没有可更新'):
                self.check(listing)
            self.assertEqual(self.check(listing, payload={**self.payload, 'mode': 'publish'})['status'], 'ready')
        with self.assertRaisesRegex(ExtensionError, '更新模式'):
            self.check({'items': [self.row()]}, payload={**self.payload, 'mode': 'publish'})

    def test_downgrade_equal_precedence_and_conflicting_digest_rejected(self):
        for version in ('0.3.0', '0.2.0+other-build'):
            with self.assertRaises(ExtensionError) as error:
                self.check({'items': [self.row(version)]})
            self.assertEqual(error.exception.code, 'PUBLICATION_VERSION_NOT_NEWER')
        with self.assertRaises(ExtensionError) as error:
            self.check({'items': [self.row()]}, self.row('0.2.0'))
        self.assertEqual(error.exception.code, 'PUBLICATION_DIGEST_CONFLICT')
        self.assertEqual(self.check({'items': [self.row('0.2.0-rc.1')]})['status'], 'ready')

    def test_identity_bad_input_and_missing_local_digest_never_network(self):
        with patch('extension_publication._public_json') as fetch:
            for payload in ({**self.payload, 'packageId': 'someone/else'}, {**self.payload, 'version': 'garbage'},
                            {**self.payload, 'mode': 'anything'}, {**self.payload, 'url': 'https://evil'},
                            {**self.payload, 'packageId': '../secret'}):
                with self.assertRaises(ExtensionError):
                    publication_status(self.store, self.digest, payload)
            self.store.get.side_effect = ExtensionError('not installed', 'NOT_FOUND', 404)
            with self.assertRaises(ExtensionError):
                publication_status(self.store, self.digest, self.payload)
            fetch.assert_not_called()

    def test_unknown_malformed_inconsistent_paginated_is_unavailable(self):
        cases = [({}, None), ({'items': None}, None), ({'items': [self.row()], 'hasMore': True}, None),
                 ({'items': [{**self.row(), 'packageId': 'other/item'}]}, None),
                 ({'items': [{**self.row(), 'digest': 'garbage'}]}, None),
                 ({'items': [self.row(), self.row()]}, None),
                 ({'items': [self.row('0.2.0', self.digest)]}, None),
                 ({'items': []}, self.row('0.3.0', self.digest))]
        for listing, exact in cases:
            with self.subTest(listing=listing), patch('extension_publication._public_json', side_effect=[listing, exact]):
                with self.assertRaises(ExtensionError) as error:
                    publication_status(self.store, self.digest, self.payload)
                self.assertEqual(error.exception.code, 'PUBLICATION_UNAVAILABLE')

    def test_network_is_fixed_get_bounded_timeout_no_auth_or_redirects(self):
        class Response(io.BytesIO):
            status = 200
        responses = [Response(json.dumps({'items': [self.row()]}).encode()),
                     urllib.error.HTTPError('fixed', 404, 'missing', {}, io.BytesIO())]
        requests = []
        def open_request(request, timeout):
            requests.append(request)
            self.assertEqual(timeout, 10)
            self.assertEqual(request.get_method(), 'GET')
            self.assertTrue(request.full_url.startswith('https://refmuse.cn/api/open/items/artist/four-view/versions'))
            self.assertFalse(any(key.lower() in ('authorization', 'cookie') for key in request.headers))
            self.assertIsNone(request.data)
            value = responses.pop(0)
            if isinstance(value, Exception):
                raise value
            return value
        opener = Mock(open=open_request)
        with patch('extension_publication.urllib.request.build_opener', return_value=opener) as build:
            self.assertEqual(publication_status(self.store, self.digest, self.payload)['status'], 'ready')
            redirect = build.call_args.args[0]
            self.assertIsNone(redirect.redirect_request(None, None, 302, '', {}, 'https://evil'))
        self.assertEqual(len(requests), 2)
        for failure in (TimeoutError(), urllib.error.URLError('offline'), urllib.error.HTTPError('fixed', 500, 'failed', {}, io.BytesIO()),
                        urllib.error.HTTPError('fixed', 302, 'redirect', {}, io.BytesIO()), Response(b'not-json'), Response(b'[]'), Response(b'x' * (MAX_RESPONSE + 1))):
            opener = Mock()
            if isinstance(failure, Exception):
                opener.open.side_effect = failure
            else:
                opener.open.return_value = failure
            with patch('extension_publication.urllib.request.build_opener', return_value=opener), self.assertRaises(ExtensionError) as error:
                publication_status(self.store, self.digest, self.payload)
            self.assertEqual(error.exception.code, 'PUBLICATION_UNAVAILABLE')

    def test_api_route_is_read_only_and_returns_compact_status(self):
        api = ExtensionAPI(self.store, object_info=Mock(side_effect=AssertionError('no Comfy access')))
        handler = Handler(json.dumps(self.payload).encode())
        with patch('extension_publication._public_json', side_effect=[{'items': [self.row()]}, None]):
            self.assertTrue(api.handle_post(handler, f'/api/extensions/{self.digest}/publication'))
        self.assertEqual(handler.status, 200)
        self.assertEqual(handler.payload['status'], 'ready')
        self.store.import_bytes.assert_not_called()
        self.store.prepare.assert_not_called()
        self.store.download.assert_called_once_with(self.digest)

    def test_imported_archive_privacy_checked_before_any_network(self):
        mutations = [
            lambda: self.files.update({'assets/private.png': b'private pixels'}),
            lambda: self.files.update({'extra.json': {'token': 'private'}}),
            lambda: self.files.update({'README.md': 'Source C:\\Users\\alice\\private.png'}),
            lambda: self.files.update({'LICENSE': 'Authorization: Bearer ' + 'x' * 32}),
            lambda: self.manifest.update(description='https://example.com/asset?access_token=private'),
            lambda: self.definition.update(parameters={'properties': {'api_key': {'default': 'private'}}}),
            lambda: self.workflow['load']['inputs'].update(image='my-private-source.png'),
            lambda: self.workflow['save']['inputs'].update(filename_prefix='/home/alice/private'),
            lambda: self.workflow.update(prompt={'class_type': 'Text', 'inputs': {'text': 'sk-' + 'x' * 30}}),
        ]
        for index, mutate in enumerate(mutations):
            self.setUp()
            mutate()
            self.archive()
            with self.subTest(case=index), patch('extension_publication._public_json') as fetch, self.assertRaises(ExtensionError) as error:
                publication_status(self.store, self.digest, self.payload)
            self.assertEqual(error.exception.code, 'PUBLICATION_PRIVACY_REVIEW_REQUIRED')
            fetch.assert_not_called()

    def test_only_bounded_metadata_free_preview_is_allowed(self):
        from PIL import Image
        from extension_sharing import _thumbnail
        image = Image.new('RGB', (16, 16), 'white')
        original = io.BytesIO()
        image.save(original, 'JPEG')
        prefix = 'data:image/jpeg;base64,'
        self.manifest['preview'] = _thumbnail(prefix + base64.b64encode(original.getvalue()).decode())
        self.archive()
        self.assertEqual(self.check({'items': [self.row()]})['status'], 'ready')
        private = io.BytesIO()
        exif = Image.Exif()
        exif[0x010E] = 'Private camera metadata'
        image.save(private, 'JPEG', exif=exif)
        for content in (private.getvalue(), original.getvalue() + b'private trailing bytes'):
            self.manifest['preview'] = prefix + base64.b64encode(content).decode()
            self.archive()
            with patch('extension_publication._public_json') as fetch, self.assertRaises(ExtensionError) as error:
                publication_status(self.store, self.digest, self.payload)
            self.assertEqual(error.exception.code, 'PUBLICATION_PRIVACY_REVIEW_REQUIRED')
            fetch.assert_not_called()


if __name__ == '__main__':
    unittest.main()
