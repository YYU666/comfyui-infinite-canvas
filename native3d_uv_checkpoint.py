"""Private, content-bound checkpoint of a fully validated frozen-plan UV stage.

No legacy diagnostic file is accepted. A hit resumes export only, never changes
an earlier job's state, and retains needs_review rather than granting acceptance.
"""
from pathlib import Path
import hashlib
import importlib.metadata
import json
import shutil
import tempfile
import zipfile

import numpy as np
import trimesh

MAX_PAYLOAD = 64 * 1024**2
MAX_REPORT = 3 * 1024**2  # Leave room in the worker's 4 MiB delivery envelope.
ARTIFACTS = ('uv-layout.png', 'uv-checker.png', 'seams-3d.npz')


def packed_json(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False,
                      separators=(',', ':'), allow_nan=False)


def sha(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def identity(mesh, plan):
    root = Path(__file__).parent
    # Conservative invalidation includes planning, evidence, algorithms and gates.
    names = sorted(set(p.name for p in root.glob('native3d_uv*.py')) |
                   {'native3d_engine.py', 'native3d_partfield.py', 'native3d_high_analysis.py'})
    versions = {}
    for name in ('numpy', 'scipy', 'trimesh', 'libigl', 'xatlas', 'Pillow'):
        try:
            versions[name] = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            versions[name] = 'unavailable'
    geometry = hashlib.sha256(np.asarray(mesh.vertices, dtype='<f8').tobytes() +
                              np.asarray(mesh.faces, dtype='<i8').tobytes()).hexdigest()
    value = {'schema': 1, 'plan': plan['planSha256'], 'source': plan['source'],
             'settings': plan['settings'], 'geometry': geometry,
             'implementation': {name: sha(root / name) for name in names},
             'dependencies': versions}
    return hashlib.sha256(packed_json(value).encode('utf-8')).hexdigest()


def verify_report(report, plan):
    if not isinstance(report,dict):
        raise ValueError('Invalid UV checkpoint report')
    flags = report.get('qualityFlags', {})
    required = ('exactGeometry', 'rasterOverlapFree', 'nondegenerateUV',
                'noMixedFlip', 'paddingPixelCenters', 'geometricOverlapFree',
                'geometricPadding', 'geometricBounds')
    if not isinstance(flags,dict) or any(flags.get(name) is not True for name in required):
        raise ValueError('UV checkpoint requires every existing quality gate')
    reviewed = report.get('reviewedPlan', {})
    if (not isinstance(reviewed,dict) or reviewed.get('planSha256') != plan['planSha256'] or
            reviewed.get('missingConstraintEdges') != 0):
        raise ValueError('UV checkpoint reviewed seams do not match')
    payload = packed_json(report).encode('utf-8')
    if len(payload) > MAX_REPORT:
        raise ValueError('UV stage report exceeds delivery budget before export')
    return payload


def load(root, key, source, plan, output=None):
    """Corrupt/incompatible checkpoints are misses, never accepted results."""
    root = Path(root)
    folder = root / key
    if root.is_symlink() or folder.is_symlink():
        return None
    try:
        manifest_path = folder / 'manifest.json'
        if manifest_path.is_symlink() or manifest_path.stat().st_size > MAX_REPORT + 65536:
            return None
        manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
        if not isinstance(manifest,dict) or manifest.get('key') != key or manifest.get('schema') != 1:
            return None
        checksum = manifest.pop('contentSha256', None)
        if checksum != hashlib.sha256(packed_json(manifest).encode('utf-8')).hexdigest():
            return None
        report = manifest['report']
        verify_report(report, plan)
        entries = manifest['files']
        if not isinstance(entries,dict) or set(entries) - {'mesh.npz', *ARTIFACTS} or 'mesh.npz' not in entries:
            return None
        for name, record in entries.items():
            if not isinstance(record,dict):
                return None
            path = folder / name
            if (path.is_symlink() or not path.is_file() or
                    not 0 < path.stat().st_size <= MAX_PAYLOAD or
                    path.stat().st_size != record['bytes'] or sha(path) != record['sha256']):
                return None
        payload = folder / 'mesh.npz'
        with zipfile.ZipFile(payload) as archive:
            if sum(info.file_size for info in archive.infolist()) > MAX_PAYLOAD:
                return None
        with np.load(payload, allow_pickle=False) as data:
            if set(data.files) != {'vertices', 'faces', 'uv', 'sourceVertex', 'sourceFace'}:
                return None
            arrays = {name: data[name].copy() for name in data.files}
        vertices, faces, uv, vertex, face = (arrays[k] for k in
            ('vertices', 'faces', 'uv', 'sourceVertex', 'sourceFace'))
        n = len(source.faces)
        if (vertices.ndim != 2 or vertices.shape[1] != 3 or not 0 < len(vertices) <= 3*n or
                faces.shape != (n, 3) or uv.shape != (len(vertices), 2) or
                vertex.shape != (len(vertices),) or face.shape != (n,)):
            return None
        if any(not np.issubdtype(a.dtype, np.integer) for a in (faces, vertex, face)):
            return None
        if (not np.isfinite(vertices).all() or not np.isfinite(uv).all() or
                faces.min() < 0 or faces.max() >= len(vertices) or
                vertex.min() < 0 or vertex.max() >= len(source.vertices) or
                not np.array_equal(np.sort(face), np.arange(n)) or
                not np.array_equal(vertices, np.asarray(source.vertices)[vertex]) or
                not np.array_equal(vertex[faces], np.asarray(source.faces)[face])):
            return None
        result = trimesh.Trimesh(vertices=vertices, faces=faces, process=False)
        result.visual = trimesh.visual.TextureVisuals(uv=uv)
        if hasattr(source.visual, 'material'):
            result.visual.material = source.visual.material.copy()
        if getattr(source.visual, 'face_materials', None) is not None:
            result.visual.face_materials = np.asarray(source.visual.face_materials)[face]
        result.vertex_normals = np.asarray(source.vertex_normals)[vertex]
        result.vertex_attributes = {k: np.asarray(v)[vertex].copy() for k,v in source.vertex_attributes.items()}
        result.face_attributes = {k: np.asarray(v)[face].copy() for k,v in source.face_attributes.items()}
        result.metadata = dict(source.metadata)
        result.metadata.update(nativeSourceUV=True, uvSourceVertex=vertex.tolist(), uvSourceFace=face.tolist())
        if output is not None:
            out = Path(output)
            if out.is_symlink():
                return None
            for name in ARTIFACTS:
                if name in entries:
                    target = out / name
                    if target.is_symlink():
                        return None
                    shutil.copyfile(folder / name, target)
        return result, report
    except (OSError, ValueError, KeyError, TypeError, IndexError, EOFError, zipfile.BadZipFile):
        return None


def save(root, key, mesh, report, plan, output=None):
    """Called only after source/seam assertions and all UV checks have passed."""
    verify_report(report, plan)  # Fail at the stage boundary, not after export.
    root = Path(root)
    if root.is_symlink():
        raise ValueError('Unsafe UV checkpoint directory')
    root.mkdir(parents=True, exist_ok=True)
    destination = root / key
    if destination.exists():
        return False  # Never overwrite an existing checkpoint or corrupt history.
    temporary = Path(tempfile.mkdtemp(prefix='.pending-', dir=root))
    try:
        np.savez_compressed(temporary / 'mesh.npz', vertices=mesh.vertices, faces=mesh.faces,
            uv=mesh.visual.uv, sourceVertex=np.asarray(mesh.metadata['uvSourceVertex']),
            sourceFace=np.asarray(mesh.metadata['uvSourceFace']))
        if output is not None:
            for name in ARTIFACTS:
                path = Path(output) / name
                if path.is_file() and not path.is_symlink():
                    shutil.copyfile(path, temporary / name)
        entries = {}
        for path in temporary.iterdir():
            if not 0 < path.stat().st_size <= MAX_PAYLOAD:
                raise ValueError('UV checkpoint payload exceeds bound')
            entries[path.name] = {'bytes': path.stat().st_size, 'sha256': sha(path)}
        manifest = {'schema': 1, 'key': key, 'report': report, 'files': entries}
        manifest['contentSha256'] = hashlib.sha256(packed_json(manifest).encode('utf-8')).hexdigest()
        (temporary / 'manifest.json').write_text(packed_json(manifest), encoding='utf-8')
        temporary.rename(destination)  # Complete checkpoint becomes visible atomically.
        return True
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)
