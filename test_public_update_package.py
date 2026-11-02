import unittest

from scripts.build_update_package import assert_public_path


class PublicPackageTests(unittest.TestCase):
    def test_reject_private_tools_even_if_force_tracked(self):
        for path in ['.local-node-tools/presets.json', '.LOCAL-NODE-TOOLS/private.json',
                     'tools/custom.h3pack', '.cache/render.png', 'dist/assets/local.js',
                     'node_modules/dependency/index.js']:
            with self.subTest(path=path), self.assertRaises(RuntimeError):
                assert_public_path(path)

    def test_allow_public_sources_and_docs(self):
        for path in ['src/local-node-tools.js', 'scripts/local-node-tools-config.mjs',
                     'docs/local-node-tools.md', 'test_public_update_package.py']:
            assert_public_path(path)
