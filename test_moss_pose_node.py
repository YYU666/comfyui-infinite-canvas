import hashlib
import importlib.util
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('moss_pose_offline_test', Path(__file__).parent / 'comfy-nodes/h3_workbench_refine/moss_pose.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class OfflinePoseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.weights = {name: (len(body), hashlib.sha256(body).hexdigest()) for name, body in [('yolox_l.onnx', b'detector'), ('dw-ll_ucoco_384.onnx', b'pose')]}
        self.directory = self.root / 'yzd-v/DWPose'
        self.directory.mkdir(parents=True)
        for name, data in [('yolox_l.onnx', b'detector'), ('dw-ll_ucoco_384.onnx', b'pose')]:
            (self.directory / name).write_bytes(data)
        self.guard = patch.object(module, 'WEIGHTS', self.weights)
        self.guard.start()
        self.addCleanup(self.guard.stop)

    def test_missing_and_wrong_hash_stop(self):
        paths = module.verify_weights(self.directory)
        self.assertTrue(all(Path(path).is_absolute() for path in paths.values()))
        (self.directory / 'yolox_l.onnx').write_bytes(b'changed!')
        with self.assertRaisesRegex(ValueError, 'SHA-256'):
            module.verify_weights(self.directory)
        (self.directory / 'yolox_l.onnx').unlink()
        with self.assertRaisesRegex(ValueError, '不会自动下载'):
            module.verify_weights(self.directory)

    def test_executes_verified_local_paths_without_downloader(self):
        calls = []
        def downloader(*args, ckpts_dir=str(self.root), **kwargs):
            raise AssertionError('Network download must never be called')
        class FakeDetector:
            __module__ = 'synthetic_detector'
            def __init__(self, wholebody):
                calls.append(wholebody)
            @classmethod
            def from_pretrained(cls, *args, **kwargs):
                raise AssertionError('from_pretrained must never be called')
            def __call__(self, image, **kwargs):
                return ('skeleton', {})
        package = SimpleNamespace(DwposeDetector=FakeDetector, model_management=SimpleNamespace(get_torch_device=lambda: 'cpu'), common_annotator_call=lambda callback, image, **kwargs: callback(image, **kwargs))
        detector_module = SimpleNamespace(custom_hf_download=downloader, Wholebody=lambda detector, pose, **kwargs: (detector, pose))
        wrapper = SimpleNamespace(__module__='synthetic_wrapper')
        def importer(name):
            return {'synthetic_wrapper': package, 'synthetic_detector': detector_module}[name]
        with patch.dict(sys.modules, {'nodes': SimpleNamespace(NODE_CLASS_MAPPINGS={'DWPreprocessor': wrapper})}), patch.object(module.importlib, 'import_module', side_effect=importer):
            self.assertEqual(module.H3CheckedDWPose.INPUT_TYPES()['required']['verified_local_weights'][0], ['verified'])
            self.assertEqual(module.H3CheckedDWPose().estimate('fixture'), ('skeleton',))
            self.assertEqual(len(calls), 1)
            self.assertTrue(all(Path(path).is_absolute() for path in calls[0]))
            (self.directory / 'dw-ll_ucoco_384.onnx').unlink()
            self.assertEqual(module.H3CheckedDWPose.INPUT_TYPES()['required']['verified_local_weights'][0], ['blocked'])
            with self.assertRaisesRegex(ValueError, '不会自动下载'):
                module.H3CheckedDWPose().estimate('fixture')
            self.assertEqual(len(calls), 1)


if __name__ == '__main__':
    unittest.main()
