import hashlib
from pathlib import Path
import tempfile
import unittest

import trimesh

from native3d_engine import run


class ReplayEngineTests(unittest.TestCase):
    def test_blocked_geometry_delivers_honest_stage_comparison(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'candidate.glb'
            high = root / 'reference.glb'
            # Three faces sharing an edge must not become an accepted LOD chain.
            trimesh.Trimesh([[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1]],
                            [[0, 1, 2], [1, 0, 3], [0, 1, 4]], process=False).export(source)
            trimesh.creation.box().export(high)
            hashes = [hashlib.sha256(p.read_bytes()).hexdigest() for p in (source, high)]
            result = run({'operation': 'repair_lod', 'sourcePath': str(source),
                          'highSourcePath': str(high), 'parameters': {}}, root / 'result')
            self.assertEqual(result['metadata']['geometry']['status'], 'blocked')
            self.assertEqual([s['stage'] for s in result['metadata']['geometry']['stages']], ['raw_ai', 'repair'])
            self.assertIn('comparison.png', [a['name'] for a in result['files']])
            comparison = result['metadata']['comparison']
            self.assertFalse(comparison['materialValidation'])
            self.assertFalse(comparison['uvValidation'])
            self.assertEqual(comparison['columns'][2]['status'], 'blocked')
            self.assertIn('nonmanifold_edges', comparison['columns'][2]['metrics']['未通过'])
            self.assertTrue(all(not c['rendered'] for c in comparison['columns'][3:]))
            self.assertEqual(hashes, [hashlib.sha256(p.read_bytes()).hexdigest() for p in (source, high)])


if __name__ == '__main__':
    unittest.main()
