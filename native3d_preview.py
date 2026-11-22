"""CPU poster from one immutable low-poly stage. No mesh or project edits."""
import argparse
import hashlib
import json
from pathlib import Path
from native3d_engine import read_mesh
from native3d_report import camera_for_bounds, rasterize


def render(source, target, *, max_faces=20000, diagnostic=None):
    mesh = read_mesh(Path(source))
    if type(max_faces) is not int or max_faces not in (20000,100000) or not 1 <= len(mesh.faces) <= max_faces:
        raise ValueError('LOD poster exceeds explicit bounded triangle budget')
    if diagnostic is None:
        image = rasterize(mesh, camera_for_bounds(mesh.bounds, 480, 360, 'front'),max_faces=max_faces)
    else:
        from native3d_lod_diagnostic import render_diagnostic
        evidence_path=Path(diagnostic)
        if evidence_path.stat().st_size>65536:raise ValueError('Diagnostic evidence exceeds bound')
        evidence=json.loads(evidence_path.read_text(encoding='utf8'))
        if evidence.get('meshSha256')!=hashlib.sha256(Path(source).read_bytes()).hexdigest():
            raise ValueError('Diagnostic mesh identity changed')
        from native3d_geometry import mesh_hash
        if evidence.get('geometryHash') != mesh_hash(mesh.vertices,mesh.faces):
            raise ValueError('Diagnostic triangle order/geometry changed')
        image=render_diagnostic(mesh,evidence)
    path = Path(target)
    temporary = path.with_suffix('.tmp')
    image.save(temporary, format='PNG')
    temporary.replace(path)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--max-faces',type=int,choices=[20000,100000],default=20000)
    parser.add_argument('--diagnostic')
    args = parser.parse_args()
    render(args.source, args.output,max_faces=args.max_faces,diagnostic=args.diagnostic)
