"""Synthetic tests: no torch/ComfyUI runtime, model downloads or GPU jobs."""
import importlib.util
import io
import json
from pathlib import Path
import struct
import tempfile
import unittest
from contextlib import redirect_stdout

SPEC = importlib.util.spec_from_file_location('open_h3_preflight', Path(__file__).parent / 'scripts/check_open_h3_2k_compatibility.py')
CHECK = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECK)


def adapter():
    data = {'__metadata__': {'hyperflow': 'true', 'hyperflow_gate': '0.25',
                           'hyperflow_sigmas': '[1, 0.9, 0.8, 0.7, 0.5, 0.3, 0.2, 0.1, 0]'}}
    for time in ('time_embedder', 'endpoint_time_embedder'):
        for layer in ('linear_1', 'linear_2'):
            stem = f'transformer.{time}.{layer}'
            data[stem + '.lora_A.weight'] = {'shape': [2, 4], 'dtype': 'F32'}
            data[stem + '.lora_B.weight'] = {'shape': [4, 2], 'dtype': 'F32'}
    return data


def sharp():
    return {'diffusion_model.blocks.0.adaln_proj.linear.lora_A.weight': {'shape': [2, 8]},
            'diffusion_model.blocks.0.adaln_proj.linear.lora_B.weight': {'shape': [12, 2]}}


SOURCE = 'class MiniMaxH3Model:\n    def __init__(self):\n        self.time_embedder = None\n'


class CompatibilityTests(unittest.TestCase):
    def test_native_single_time_is_blocked_with_both_runtime_gaps(self):
        result = CHECK.inspect(adapter(), sharp(), {}, SOURCE)
        self.assertFalse(result['compatible'])
        self.assertFalse(result['nativeModel']['endpointMemberPresent'])
        self.assertEqual(result['hyperflow']['gate'], .25)
        self.assertEqual(len(result['sharp']['curvePairs']), 1)
        self.assertEqual(len(result['blockers']), 3)

    def test_member_name_and_local_table_do_not_certify_execution(self):
        source = SOURCE + '        self.endpoint_time_embedder = None\n'
        result = CHECK.inspect(adapter(), sharp(), {'adaln_t_table': {'shape': [1025, 8]}}, source)
        self.assertTrue(result['nativeModel']['endpointMemberPresent'])
        self.assertEqual(result['nativeModel']['baseCurveTableShape'], [1025, 8])
        self.assertFalse(result['compatible'])

    def test_missing_or_malformed_pair_rejected(self):
        for broken in ('missing', 'rank'):
            data = adapter()
            key = 'transformer.endpoint_time_embedder.linear_1.lora_B.weight'
            if broken == 'missing':
                data.pop(key)
            else:
                data[key]['shape'] = [4, 3]
            with self.assertRaisesRegex(ValueError, 'LoRA pair'):
                CHECK.inspect(data, sharp(), {}, SOURCE)

    def test_orphan_b_rejected(self):
        data = adapter()
        data['orphan.lora_B.weight'] = {'shape': [2, 2]}
        with self.assertRaisesRegex(ValueError, 'Orphan'):
            CHECK.inspect(data, sharp(), {}, SOURCE)

    def test_bad_schedule_and_gate_rejected(self):
        for key, value in [('hyperflow_gate', 'nan'), ('hyperflow_sigmas', '[1,0]')]:
            data = adapter()
            data['__metadata__'][key] = value
            with self.assertRaises(ValueError):
                CHECK.inspect(data, sharp(), {}, SOURCE)

    def test_header_is_bounded_and_truncation_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'file.safetensors'
            for raw in (b'', struct.pack('<Q', CHECK.MAX_HEADER + 1), struct.pack('<Q', 12) + b'{}'):
                path.write_bytes(raw)
                with self.assertRaises(ValueError):
                    CHECK.read_header(path)

    def test_cli_read_only_no_conversion_and_no_report_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            args = []
            for name, content in [('hyperflow', adapter()), ('sharp', sharp()), ('base', {})]:
                path = root / (name + '.safetensors')
                raw = json.dumps(content).encode()
                path.write_bytes(struct.pack('<Q', len(raw)) + raw)
                args.extend(['--' + name, str(path)])
            source = root / 'model.py'
            source.write_text(SOURCE)
            report = root / 'report.json'
            args += ['--model-source', str(source), '--report', str(report)]
            originals = {p: p.read_bytes() for p in root.iterdir()}
            with redirect_stdout(io.StringIO()):
                self.assertEqual(CHECK.main(args), 2)
            self.assertFalse(json.loads(report.read_text())['conversionWritten'])
            self.assertEqual(set(root.iterdir()), set(originals) | {report})
            for path, raw in originals.items():
                self.assertEqual(path.read_bytes(), raw)
            previous = report.read_bytes()
            with redirect_stdout(io.StringIO()):
                self.assertEqual(CHECK.main(args), 1)
            self.assertEqual(report.read_bytes(), previous)


if __name__ == '__main__':
    unittest.main()
