"""Owned CPython3.9 bridge to a configured, hash-verified mesh2sdf extension."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import time


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--request', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    import numpy as np
    config = json.loads(Path(args.request).read_text(encoding='utf-8-sig'))['adapterConfig']
    corepath = Path(config['mesh2sdfCorePath'])
    if not corepath.is_absolute() or not corepath.is_file():
        raise ValueError('Configured absolute mesh2sdfCorePath is required')
    digest = hashlib.sha256(corepath.read_bytes()).hexdigest()
    if digest != config['mesh2sdfCoreSha256'].lower():
        raise ValueError('mesh2sdf extension hash mismatch')
    spec = importlib.util.spec_from_file_location('core', corepath)
    core = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(core)
    out = Path(args.output)
    data = np.load(out / 'mc_input.npz', allow_pickle=False)
    vertices, faces = data['vertices'], data['faces']
    if not np.isfinite(vertices).all() or vertices.ndim != 2 or vertices.shape[1] != 3 or faces.min() < 0 or faces.max() >= len(vertices):
        raise ValueError('Invalid mesh2sdf input arrays')
    started = time.monotonic()
    sdf = core.compute(vertices, faces, size=256)
    if sdf.shape != (256, 256, 256) or not np.isfinite(sdf).all():
        raise ValueError('Invalid mesh2sdf output')
    np.save(out / 'mc_sdf.npy', sdf, allow_pickle=False)
    (out / 'mc_receipt.json').write_text(json.dumps({'backend': 'official mesh2sdf.core.compute',
        'coreSha256': digest, 'size': 256, 'seconds': time.monotonic() - started,
        'inputVertices': len(vertices), 'inputTriangles': len(faces),
        'sdfSha256': hashlib.sha256((out / 'mc_sdf.npy').read_bytes()).hexdigest()}), encoding='utf-8')


if __name__ == '__main__':
    main()
