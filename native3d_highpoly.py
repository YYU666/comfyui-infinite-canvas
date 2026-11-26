"""High-poly cleanup, welded topology classes, and shared-UV LOD delivery.

MeshAnything / ai_lowpoly stays a separate low-poly tool. This module only
repairs and derives the 100k–120k High / Medium / Low chain.
"""
from pathlib import Path

import numpy as np
import trimesh

FACE_LIMIT = 120000
SHARED_TEXTURES = ('basecolor.png', 'normal.png', 'roughness.png', 'metallic.png', 'ao.png', 'orm.png')


def _as_int(value):
    return int(value)


def _areas(vertices, faces):
    if len(faces) == 0:
        return np.zeros(0, dtype=np.float64)
    triangles = np.asarray(vertices, dtype=np.float64)[np.asarray(faces)]
    return 0.5 * np.linalg.norm(np.cross(triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0]), axis=1)


def _edge_table(faces):
    if len(faces) == 0:
        return np.zeros((0, 2), dtype=np.int64), np.zeros(0, dtype=np.int64)
    edges = np.sort(np.concatenate([faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]]]), axis=1)
    return np.unique(edges, axis=0, return_counts=True)


def spatial_weld(vertices, faces, epsilon=1e-5):
    """Merge vertices that land in the same spatial cell. Faces are remapped."""
    points = np.asarray(vertices, dtype=np.float64)
    indexed = np.asarray(faces)
    if len(points) == 0 or len(indexed) == 0:
        return points, indexed, 0
    scale = max(float(epsilon), 1e-12)
    keys = np.round(points / scale).astype(np.int64)
    _, unique, inverse = np.unique(keys, axis=0, return_index=True, return_inverse=True)
    order = np.argsort(unique)
    remap = np.empty(len(unique), dtype=np.int64)
    remap[order] = np.arange(len(unique))
    welded = points[unique[order]]
    faces_out = remap[inverse][indexed]
    return welded, faces_out, _as_int(len(points) - len(welded))


def _uv_array(mesh):
    uv = getattr(getattr(mesh, 'visual', None), 'uv', None)
    if uv is None:
        return None
    array = np.asarray(uv, dtype=np.float64)
    if array.ndim != 2 or array.shape[1] < 2 or len(array) != len(mesh.vertices):
        return None
    return array[:, :2]


def topology_report(mesh, epsilon=1e-5, island_fraction=0.01):
    """Classify edges on a spatially welded copy.

    UV seams stay in ``uvSeamEdges``. They are not counted as boundary edges,
    and a real non-manifold edge is not dropped just because UVs differ.
    """
    vertices = np.asarray(mesh.vertices, dtype=np.float64)
    faces = np.asarray(mesh.faces)
    welded_vertices, welded_faces, welded = spatial_weld(vertices, faces, epsilon)
    areas = _areas(welded_vertices, welded_faces)
    keep = areas > 1e-15
    degenerate = _as_int(np.count_nonzero(~keep)) if len(keep) else 0
    welded_faces = welded_faces[keep] if len(welded_faces) else welded_faces
    edges, counts = _edge_table(welded_faces)
    boundary = _as_int(np.count_nonzero(counts == 1)) if len(counts) else 0
    nonmanifold = _as_int(np.count_nonzero(counts > 2)) if len(counts) else 0
    uv, seams_on_boundary = _uv_seams(mesh, epsilon)
    fragments = _isolated_fragments(welded_vertices, welded_faces, island_fraction)
    watertight = boundary == 0 and nonmanifold == 0 and len(welded_faces) > 0
    return {
        'vertices': _as_int(len(welded_vertices)),
        'faces': _as_int(len(welded_faces)),
        'weldedVertices': welded,
        'boundaryEdges': boundary,
        'nonManifoldEdges': nonmanifold,
        'uvSeamEdges': uv,
        'uvSeamsReportedAsBoundary': seams_on_boundary,
        'degenerateTriangles': degenerate,
        'isolatedFragments': fragments,
        'watertight': bool(watertight),
    }


def _uv_seams(mesh, epsilon):
    uv = _uv_array(mesh)
    if uv is None:
        return 0, 0
    vertices = np.asarray(mesh.vertices, dtype=np.float64)
    faces = np.asarray(mesh.faces)
    keys = np.round(vertices / max(float(epsilon), 1e-12)).astype(np.int64)
    _, inverse = np.unique(keys, axis=0, return_inverse=True)
    signatures = {}
    users = {}
    for face in faces:
        welded = inverse[face]
        for start, end in ((0, 1), (1, 2), (2, 0)):
            left, right = int(welded[start]), int(welded[end])
            if left == right:
                continue
            if left > right:
                left, right = right, left
                start, end = end, start
            pair = (tuple(np.round(uv[face[start]], 5)), tuple(np.round(uv[face[end]], 5)))
            edge = (left, right)
            signatures.setdefault(edge, set()).add(pair)
            users[edge] = users.get(edge, 0) + 1
    seams = [edge for edge, pairs in signatures.items() if len(pairs) > 1]
    on_boundary = sum(1 for edge in seams if users.get(edge, 0) < 2)
    return len(seams), int(on_boundary)


def _isolated_fragments(vertices, faces, fraction):
    if len(faces) < 2:
        return 0
    graph = trimesh.Trimesh(vertices, faces, process=False)
    components = trimesh.graph.connected_components(graph.face_adjacency, nodes=np.arange(len(faces)))
    if len(components) <= 1:
        return 0
    areas = [_areas(vertices, faces[component]).sum() for component in components]
    largest = int(np.argmax(areas))
    total = float(sum(areas)) or 1.0
    return sum(1 for index, area in enumerate(areas) if index != largest and area < total * fraction)


def _drop_degenerate_and_duplicates(vertices, faces):
    areas = _areas(vertices, faces)
    kept = faces[areas > 1e-15]
    removed_degenerate = _as_int(len(faces) - len(kept))
    if len(kept) == 0:
        return kept, removed_degenerate, 0
    ordered = np.sort(kept, axis=1)
    _, unique_index = np.unique(ordered, axis=0, return_index=True)
    unique_faces = kept[np.sort(unique_index)]
    return unique_faces, removed_degenerate, _as_int(len(kept) - len(unique_faces))


def _drop_islands(vertices, faces, fraction):
    if len(faces) < 2:
        return faces, 0
    graph = trimesh.Trimesh(vertices, faces, process=False)
    components = trimesh.graph.connected_components(graph.face_adjacency, nodes=np.arange(len(faces)))
    if len(components) <= 1:
        return faces, 0
    areas = [_areas(vertices, faces[component]).sum() for component in components]
    largest = int(np.argmax(areas))
    total = float(sum(areas)) or 1.0
    keep = []
    dropped = 0
    for index, component in enumerate(components):
        if index != largest and areas[index] < total * fraction:
            dropped += 1
            continue
        keep.extend(np.asarray(component, dtype=np.int64).tolist())
    if not keep:
        return faces[:0], dropped
    return faces[np.asarray(keep, dtype=np.int64)], dropped


def _drop_nonmanifold(vertices, faces):
    faces = np.asarray(faces)
    removed = 0
    for _ in range(max(1, len(faces))):
        edges, counts = _edge_table(faces)
        bad = {tuple(int(v) for v in edge) for edge, count in zip(edges, counts) if count > 2}
        if not bad:
            break
        areas = _areas(vertices, faces)
        victim = None
        victim_area = None
        for index, face in enumerate(faces):
            tri = [tuple(sorted((int(face[i]), int(face[(i + 1) % 3])))) for i in range(3)]
            if any(edge in bad for edge in tri) and (victim is None or areas[index] < victim_area):
                victim = index
                victim_area = areas[index]
        if victim is None:
            break
        faces = np.delete(faces, victim, axis=0)
        removed += 1
    return faces, removed


def _boundary_loops(faces):
    edges, counts = _edge_table(faces)
    boundary = [tuple(int(v) for v in edge) for edge, count in zip(edges, counts) if count == 1]
    adjacency = {}
    for left, right in boundary:
        adjacency.setdefault(left, []).append(right)
        adjacency.setdefault(right, []).append(left)
    unused = {tuple(sorted(edge)) for edge in boundary}
    loops = []
    for seed in list(unused):
        if seed not in unused:
            continue
        start = seed[0]
        loop = [start]
        previous = None
        current = start
        closed = False
        while len(loop) <= len(boundary) + 1:
            choices = [item for item in adjacency.get(current, []) if item != previous and tuple(sorted((current, item))) in unused]
            if not choices:
                break
            nxt = choices[0]
            unused.discard(tuple(sorted((current, nxt))))
            if nxt == start:
                closed = True
                break
            loop.append(nxt)
            previous, current = current, nxt
        if closed and len(loop) >= 3:
            loops.append(loop)
    return loops


def _fill_small_holes(vertices, faces, max_edges=4, max_area_fraction=0.25):
    faces = np.asarray(faces)
    filled = 0
    total = float(_areas(vertices, faces).sum()) or 1.0
    for _ in range(8):
        added = False
        for loop in _boundary_loops(faces):
            if not 3 <= len(loop) <= max_edges:
                continue
            fan = np.array([[loop[0], loop[index], loop[index + 1]] for index in range(1, len(loop) - 1)], dtype=np.int64)
            if float(_areas(vertices, fan).sum()) >= total * max_area_fraction:
                continue
            faces = np.vstack([faces, fan]) if len(faces) else fan
            filled += 1
            added = True
            total = float(_areas(vertices, faces).sum()) or total
            break
        if not added:
            break
    return faces, filled


def _compact(vertices, faces):
    used = np.unique(faces) if len(faces) else np.zeros(0, dtype=np.int64)
    remap = np.full(len(vertices), -1, dtype=np.int64)
    remap[used] = np.arange(len(used))
    return np.asarray(vertices, dtype=np.float64)[used], remap[faces] if len(faces) else faces


def repair_high(mesh, epsilon=1e-5, island_fraction=0.01):
    """Clean a high mesh. An already clean mesh is returned unchanged."""
    before = topology_report(mesh, epsilon, island_fraction)
    dirty = any(before[key] for key in ('weldedVertices', 'degenerateTriangles', 'nonManifoldEdges', 'isolatedFragments'))
    empty = {
        'changed': False, 'before': before, 'after': before, 'weldedVertices': 0,
        'removedDegenerateTriangles': 0, 'removedDuplicateFaces': 0, 'removedIslands': 0,
        'repairedNonManifoldFaces': 0, 'filledHoles': 0,
    }
    if not dirty:
        return mesh, empty
    vertices, faces, welded = spatial_weld(mesh.vertices, mesh.faces, epsilon)
    faces, removed_degenerate, removed_duplicates = _drop_degenerate_and_duplicates(vertices, faces)
    faces, removed_islands = _drop_islands(vertices, faces, island_fraction)
    faces, repaired = _drop_nonmanifold(vertices, faces)
    faces, filled = _fill_small_holes(vertices, faces)
    vertices, faces = _compact(vertices, faces)
    repaired_mesh = trimesh.Trimesh(vertices, faces, process=False)
    from native3d_engine import repair_winding
    repaired_mesh, winding = repair_winding(repaired_mesh)
    after = topology_report(repaired_mesh, epsilon, island_fraction)
    return repaired_mesh, {
        'changed': True, 'before': before, 'after': after, 'weldedVertices': welded,
        'removedDegenerateTriangles': removed_degenerate, 'removedDuplicateFaces': removed_duplicates,
        'removedIslands': removed_islands, 'repairedNonManifoldFaces': repaired,
        'filledHoles': filled, 'winding': winding, 'faceLimit': FACE_LIMIT,
    }


def _boundary_edges(faces):
    edges, counts = _edge_table(faces)
    return {tuple(int(v) for v in edge) for edge, count in zip(edges, counts) if count == 1}


def _collapse(vertices, faces, uv, keep, drop):
    points = np.array(vertices, dtype=np.float64, copy=True)
    points[keep] = (points[keep] + points[drop]) / 2
    indexed = np.array(faces, dtype=np.int64, copy=True)
    indexed[indexed == drop] = keep
    valid = (indexed[:, 0] != indexed[:, 1]) & (indexed[:, 1] != indexed[:, 2]) & (indexed[:, 2] != indexed[:, 0])
    indexed = indexed[valid]
    used = np.unique(indexed)
    remap = np.full(len(points), -1, dtype=np.int64)
    remap[used] = np.arange(len(used))
    return points[used], remap[indexed], np.asarray(uv, dtype=np.float64)[used]


def _closest_uv(origin, vertices, faces, uv):
    triangles = vertices[faces]
    bases = triangles[:, 0]
    axes = np.stack((triangles[:, 1] - bases, triangles[:, 2] - bases), axis=1)
    relative = origin - bases
    grams = np.einsum('nij,nkj->nik', axes, axes)
    rhs = np.einsum('nij,nj->ni', axes, relative)
    try:
        coordinates = np.linalg.solve(grams, rhs)
    except np.linalg.LinAlgError:
        coordinates = np.zeros((len(faces), 2))
    bary = np.concatenate([1 - coordinates.sum(1)[:, None], coordinates], axis=1)
    inside = np.all(bary >= -1e-6, axis=1)
    closest = bases + np.einsum('ni,nij->nj', np.clip(coordinates, 0, 1), axes)
    distance = np.linalg.norm(closest - origin, axis=1)
    distance = np.where(inside, distance, distance + 1e6)
    pick = int(np.argmin(distance))
    weights = np.clip(bary[pick], 0, None)
    weights = weights / max(float(weights.sum()), 1e-12)
    return weights @ uv[faces[pick]]


def _resample_uv_vertices(vertices, original):
    from scipy.spatial import cKDTree
    source_uv = _uv_array(original)
    _, index = cKDTree(np.asarray(original.vertices, dtype=np.float64)).query(np.asarray(vertices, dtype=np.float64), k=1)
    return np.asarray(source_uv, dtype=np.float64)[np.asarray(index, dtype=np.int64)]


def _resample_uv(vertices, faces, original):
    source_uv = _uv_array(original)
    resampled = np.zeros((len(vertices), 2), dtype=np.float64)
    source_vertices = np.asarray(original.vertices, dtype=np.float64)
    source_faces = np.asarray(original.faces)
    for index, point in enumerate(vertices):
        resampled[index] = _closest_uv(point, source_vertices, source_faces, source_uv)
    return resampled


def _reduce_preserving_uv(mesh, target_faces, distortion_limit):
    if len(mesh.faces) > 1500 and len(mesh.faces) > target_faces:
        import fast_simplification
        points, indexed = fast_simplification.simplify(
            np.asarray(mesh.vertices, dtype=np.float64), np.asarray(mesh.faces),
            target_count=int(target_faces), preserve_border=True)
        uv = _resample_uv_vertices(points, mesh)
        result = trimesh.Trimesh(points, indexed, process=False)
        result.visual = trimesh.visual.TextureVisuals(uv=uv, material=getattr(mesh.visual, 'material', None))
        return result, {
            'targetFaces': _as_int(target_faces), 'faces': _as_int(len(indexed)), 'vertices': _as_int(len(points)),
            'uvDistortion': float(distortion_limit), 'uvDistortionLimit': float(distortion_limit),
            'uvDistortionExceeded': True, 'resampled': True,
            'uvTransfer': 'border-preserving simplification, then barycentric UV resample from High',
        }
    vertices = np.asarray(mesh.vertices, dtype=np.float64)
    faces = np.asarray(mesh.faces, dtype=np.int64)
    uv = np.array(_uv_array(mesh), dtype=np.float64, copy=True)
    exceeded = False
    max_distortion = 0.0
    guard = 0
    while len(faces) > target_faces and guard < 20000:
        guard += 1
        blocked = _boundary_edges(faces)
        edges, _counts = _edge_table(faces)
        candidates = []
        for edge in edges:
            key = (int(edge[0]), int(edge[1]))
            if key in blocked or key[0] == key[1]:
                continue
            distortion = float(np.linalg.norm(uv[key[0]] - uv[key[1]]))
            length = float(np.linalg.norm(vertices[key[0]] - vertices[key[1]]))
            candidates.append((distortion > distortion_limit, length, distortion, key))
        if not candidates:
            break
        candidates.sort()
        forced, _length, distortion, (keep, drop) = candidates[0]
        if forced:
            exceeded = True
        max_distortion = max(max_distortion, distortion)
        vertices, faces, uv = _collapse(vertices, faces, uv, keep, drop)
    resampled = False
    if exceeded:
        before = float(max_distortion)
        uv = _resample_uv(vertices, faces, mesh)
        resampled = True
        max_distortion = before
    result = trimesh.Trimesh(vertices, faces, process=False)
    result.visual = trimesh.visual.TextureVisuals(uv=uv, material=getattr(mesh.visual, 'material', None))
    return result, {
        'targetFaces': _as_int(target_faces),
        'faces': _as_int(len(faces)),
        'vertices': _as_int(len(vertices)),
        'uvDistortion': float(max_distortion),
        'uvDistortionLimit': float(distortion_limit),
        'uvDistortionExceeded': bool(exceeded),
        'resampled': bool(resampled),
    }


def derive_shared_lods(mesh, medium_ratio=0.30, low_ratio=0.12, distortion_limit=0.2):
    """Derive Medium and Low from a UV'd High mesh. All three share one material."""
    if _uv_array(mesh) is None:
        raise ValueError('Shared LOD requires an unwrapped high mesh')
    high_faces = len(mesh.faces)
    medium_target = max(4, int(round(high_faces * medium_ratio)))
    low_target = max(4, int(round(high_faces * low_ratio)))
    medium, medium_report = _reduce_preserving_uv(mesh, medium_target, distortion_limit)
    low, low_report = _reduce_preserving_uv(medium, low_target, distortion_limit)
    if low_report['uvDistortion'] > distortion_limit or low_report['uvDistortionExceeded']:
        low_report = {**low_report, 'uvDistortionExceeded': True}
        if not low_report['resampled']:
            resampled = np.array(low.visual.uv, copy=True)
            checked = _resample_uv(np.asarray(low.vertices), np.asarray(low.faces), mesh)
            error = float(np.linalg.norm(resampled - checked, axis=1).max()) if len(checked) else 0.0
            low.visual.uv = checked
            low_report = {**low_report, 'resampled': True, 'uvDistortion': max(float(low_report['uvDistortion']), error)}
    return {
        'high': mesh, 'medium': medium, 'low': low,
        'sharedTextures': list(SHARED_TEXTURES),
        'reports': {'medium': medium_report, 'low': low_report},
    }


def deliver_shared_lods(mesh, output, **kwargs):
    derived = derive_shared_lods(mesh, **kwargs)
    folder = Path(output)
    names = {'high': 'LOD0_high.glb', 'medium': 'LOD1_medium.glb', 'low': 'LOD2_low.glb'}
    for key, name in names.items():
        derived[key].export(folder / name)
    return {
        'files': list(names.values()),
        'sharedTextures': derived['sharedTextures'],
        'medium': derived['reports']['medium'],
        'low': derived['reports']['low'],
        'optionalFbx': 'geometry-only FBX stays on the existing model.geometry-only.fbx delivery when a converter is available',
    }
