import unittest
from model_sources import locked_sources, validate_source, model_license


class PinnedSourceTests(unittest.TestCase):
    def test_all_official_sources_are_content_pinned(self):
        sources = locked_sources()
        self.assertGreaterEqual(len(sources), 14)
        for source in sources.values():
            self.assertIn('/resolve/' + source['revision'] + '/', source['url'])
            self.assertEqual(validate_source(source)['verification'], 'sha256')

    def test_unpinned_missing_hash_and_url_substitution_fail_closed(self):
        source = next(iter(locked_sources().values()))
        for changes in ({'revision': 'main'}, {'revision': 'v1'}, {'sha256': ''},
                        {'sha256': 'a' * 63}, {'filename': '../model'},
                        {'url': 'https://hf-mirror.com/model'}, {'bytes': True}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                validate_source({**source, **changes})

    def test_auxiliary_files_and_unsafe_target_paths_never_enter_downloads(self):
        sources = locked_sources()
        self.assertEqual(len(sources), 19)
        self.assertTrue(all(row['path'].endswith(('.safetensors', '.gguf')) for row in sources.values()))
        source = next(iter(sources.values()))
        for changes in ({'path': '../escape.safetensors'}, {'path': '/absolute.safetensors'},
                        {'path': 'annotators/model.onnx'}, {'filename': 'model.onnx'},
                        {'path': 'loras/file:stream.safetensors'}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                validate_source({**source, **changes})

    def test_exact_model_licenses_and_h3_territories(self):
        for path in ('diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors', 'vae/minimax_h3_image_vae_fp16.safetensors'):
            info = model_license(path)
            self.assertEqual(info['excludedTerritories'], ['欧盟', '英国', '韩国', '美国'])
            self.assertNotIn('/main/', info['licenseUrl'])
        self.assertEqual(model_license('diffusion_models/Moss_image/moss_image_sft_int8_convrot.safetensors')['license'], 'Apache-2.0')
        self.assertEqual(model_license('unregistered-file')['license'], '许可待核实')


if __name__ == '__main__':
    unittest.main()
