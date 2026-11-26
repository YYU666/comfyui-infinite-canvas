import hashlib
import tempfile
import unittest
from pathlib import Path
import numpy as np
from PIL import Image
from native3d_uv_diagnostic import render_diagnostic


class DiagnosticTests(unittest.TestCase):
    def test_saved_uv_render_is_bounded_and_does_not_modify_input(self):
        with tempfile.TemporaryDirectory() as directory:
            folder=Path(directory);source=folder/'saved.npz'
            np.savez_compressed(source,vertices=np.array([[0.,0.,0.],[1.,0.,0.],[0.,1.,0.]]),
                                faces=np.array([[0,1,2]]),uv=np.array([[0.,0.],[1.,0.],[0.,1.]]))
            digest=hashlib.sha256(source.read_bytes()).hexdigest()
            report=render_diagnostic(source,folder,image_size=256)
            self.assertFalse(report['acceptedUV']);self.assertFalse(report['bakeAllowed'])
            self.assertFalse(report['finalPacking'])
            with Image.open(folder/'uv-rejected-checker.png') as image:
                self.assertEqual(image.size,(256,192))
            self.assertEqual(digest,hashlib.sha256(source.read_bytes()).hexdigest())
            with self.assertRaises(ValueError):render_diagnostic(source,folder,image_size=4096)
            with self.assertRaises(ValueError):render_diagnostic(source,folder,max_faces=100001)

    def test_nonfinite_uv_rejects(self):
        with tempfile.TemporaryDirectory() as directory:
            source=Path(directory)/'bad.npz'
            np.savez_compressed(source,vertices=np.zeros((3,3)),faces=np.array([[0,1,2]]),uv=np.full((3,2),np.nan))
            with self.assertRaises(ValueError):render_diagnostic(source,directory,image_size=256)


if __name__=='__main__':unittest.main()
