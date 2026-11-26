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


def _quantize_uv(array):
    """Match the historical 5-decimal seam key, including +0 and -0."""
    quantized = np.round(np.asarray(array, dtype=np.float64), 5)
    quantized[quantized == 0] = 0.0
    return quantized


def _uv_seams(mesh, epsilon):
    """Count welded edges that carry more than one quantized UV signature.

    Half-edges are packed as arrays and reduced with one sort. A 300k-face
    mesh must not walk faces in Python.
    """
    uv = _uv_array(mesh)
    if uv is None:
        return 0, 0
    faces = np.asarray(mesh.faces, dtype=np.int64)
    if len(faces) == 0:
        return 0, 0
    vertices = np.asarray(mesh.vertices, dtype=np.float64)
    keys = np.round(vertices / max(float(epsilon), 1e-12)).astype(np.int64)
    _, inverse = np.unique(keys, axis=0, return_inverse=True)
    welded = inverse[faces]
    quantized = _quantize_uv(uv)
    starts = np.stack([welded[:, 0], welded[:, 1], welded[:, 2]], axis=0).reshape(-1)
    ends = np.stack([welded[:, 1], welded[:, 2], welded[:, 0]], axis=0).reshape(-1)
    uv_starts = np.stack([quantized[faces[:, 0]], quantized[faces[:, 1]], quantized[faces[:, 2]]], axis=0).reshape(-1, 2)
    uv_ends = np.stack([quantized[faces[:, 1]], quantized[faces[:, 2]], quantized[faces[:, 0]]], axis=0).reshape(-1, 2)
    swap = starts > ends
    left = np.where(swap, ends, starts)
    right = np.where(swap, starts, ends)
    uv_left = np.where(swap[:, None], uv_ends, uv_starts)
    uv_right = np.where(swap[:, None], uv_starts, uv_ends)
    valid = left != right
    if not np.any(valid):
        return 0, 0
    left, right, uv_left, uv_right = left[valid], right[valid], uv_left[valid], uv_right[valid]
    edge_dtype = [('a', np.int64), ('b', np.int64)]
    edges = np.empty(len(left), dtype=edge_dtype)
    edges['a'] = left
    edges['b'] = right
    unique_edges, user_counts = np.unique(edges, return_counts=True)
    packed = np.empty(len(left), dtype=[
        ('a', np.int64), ('b', np.int64),
        ('u0', np.float64), ('v0', np.float64), ('u1', np.float64), ('v1', np.float64),
    ])
    packed['a'] = left
    packed['b'] = right
    packed['u0'] = uv_left[:, 0]
    packed['v0'] = uv_left[:, 1]
    packed['u1'] = uv_right[:, 0]
    packed['v1'] = uv_right[:, 1]
    unique_sig = np.unique(packed)
    signature_edges = np.empty(len(unique_sig), dtype=edge_dtype)
    signature_edges['a'] = unique_sig['a']
    signature_edges['b'] = unique_sig['b']
    ordered_edges, signature_counts = np.unique(signature_edges, return_counts=True)
    seam = signature_counts > 1
    if not np.any(seam):
        return 0, 0
    positions = np.searchsorted(unique_edges, ordered_edges[seam])
    return int(np.count_nonzero(seam)), int(np.count_nonzero(user_counts[positions] < 2))


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
    """Drop the smallest face on each non-manifold edge without rebuilding the mesh.

    The full edge table is built once. Only faces that touch a count>2 edge are
    candidates, and each deletion decrements those edge counts in place.
    """
    faces = np.asarray(faces, dtype=np.int64)
    if len(faces) == 0:
        return faces, 0
    stacked = np.stack((faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]]), axis=0)
    edges = np.sort(stacked, axis=2).reshape(-1, 2)
    _unique, inverse, counts = np.unique(edges, axis=0, return_inverse=True, return_counts=True)
    inverse = inverse.reshape(3, len(faces)).T
    counts = counts.astype(np.int64, copy=True)
    bad_ids = np.flatnonzero(counts > 2)
    if len(bad_ids) == 0:
        return faces, 0
    bad = set(int(item) for item in bad_ids)
    candidate = np.flatnonzero(np.isin(inverse, bad_ids).any(axis=1))
    incident = {edge: [] for edge in bad}
    for index in candidate.tolist():
        for edge in inverse[index]:
            edge = int(edge)
            if edge in incident:
                incident[edge].append(index)
    areas = _areas(vertices, faces)
    alive = np.ones(len(faces), dtype=bool)
    removed = 0
    while bad:
        victim = None
        victim_key = None
        seen = set()
        for edge in bad:
            for index in incident[edge]:
                if index in seen or not alive[index]:
                    continue
                seen.add(index)
                key = (float(areas[index]), index)
                if victim_key is None or key < victim_key:
                    victim_key = key
                    victim = index
        if victim is None:
            break
        alive[victim] = False
        removed += 1
        for edge in inverse[victim]:
            edge = int(edge)
            counts[edge] -= 1
            if edge in bad and counts[edge] <= 2:
                bad.discard(edge)
    if removed == 0:
        return faces, 0
    kept = faces[alive]
    if len(kept) == 0:
        return np.zeros((0, 3), dtype=np.int64), removed
    return kept, removed


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


def _uv_islands(faces, uv):
    """Face groups connected by an edge whose quantized UVs agree.

    A seam is not a link, so each side of a split vertex stays in its own chart.
    """
    faces = np.asarray(faces, dtype=np.int64)
    count = len(faces)
    if count == 0:
        return []
    quantized = _quantize_uv(uv)
    parent = np.arange(count, dtype=np.int64)
    rank = np.zeros(count, dtype=np.int8)

    def find(index):
        while parent[index] != index:
            parent[index] = parent[parent[index]]
            index = int(parent[index])
        return index

    def union(left, right):
        left, right = find(left), find(right)
        if left == right:
            return
        if rank[left] < rank[right]:
            parent[left] = right
        elif rank[left] > rank[right]:
            parent[right] = left
        else:
            parent[right] = left
            rank[left] += 1

    records = []
    face_ids = np.arange(count, dtype=np.int64)
    for start, end in ((0, 1), (1, 2), (2, 0)):
        va = faces[:, start]
        vb = faces[:, end]
        ua = quantized[va]
        ub = quantized[vb]
        swap = va > vb
        rec = np.empty(count, dtype=[
            ('v0', np.int64), ('v1', np.int64),
            ('u0', np.float64), ('w0', np.float64), ('u1', np.float64), ('w1', np.float64),
            ('face', np.int64),
        ])
        rec['v0'] = np.where(swap, vb, va)
        rec['v1'] = np.where(swap, va, vb)
        rec['u0'] = np.where(swap, ub[:, 0], ua[:, 0])
        rec['w0'] = np.where(swap, ub[:, 1], ua[:, 1])
        rec['u1'] = np.where(swap, ua[:, 0], ub[:, 0])
        rec['w1'] = np.where(swap, ua[:, 1], ub[:, 1])
        rec['face'] = face_ids
        records.append(rec)
    records = np.concatenate(records)
    records = records[records['v0'] != records['v1']]
    if len(records) == 0:
        return [np.arange(count, dtype=np.int64)]
    records = records[np.argsort(records, order=('v0', 'v1', 'u0', 'w0', 'u1', 'w1'))]
    same = (
        (records['v0'][1:] == records['v0'][:-1]) & (records['v1'][1:] == records['v1'][:-1]) &
        (records['u0'][1:] == records['u0'][:-1]) & (records['w0'][1:] == records['w0'][:-1]) &
        (records['u1'][1:] == records['u1'][:-1]) & (records['w1'][1:] == records['w1'][:-1])
    )
    for left, right in zip(records['face'][:-1][same].tolist(), records['face'][1:][same].tolist()):
        union(int(left), int(right))
    roots = np.fromiter((find(index) for index in range(count)), dtype=np.int64, count=count)
    order = np.argsort(roots)
    splits = np.flatnonzero(np.diff(roots[order])) + 1
    return np.split(order, splits)


def _take_faces(vertices, faces, uv, face_ids):
    subset = np.asarray(faces, dtype=np.int64)[np.asarray(face_ids, dtype=np.int64)]
    used = np.unique(subset)
    remap = np.full(len(vertices), -1, dtype=np.int64)
    remap[used] = np.arange(len(used))
    return np.asarray(vertices, dtype=np.float64)[used], remap[subset], np.asarray(uv, dtype=np.float64)[used]


def _compact_indexed(vertices, faces, uv):
    if len(faces) == 0:
        return vertices[:0], faces, uv[:0]
    used = np.unique(faces)
    if len(used) == len(vertices):
        return vertices, faces, uv
    remap = np.full(len(vertices), -1, dtype=np.int64)
    remap[used] = np.arange(len(used))
    return vertices[used], remap[faces], uv[used]


def _max_uv_edge(uv, faces):
    if len(faces) == 0:
        return 0.0
    triangles = np.asarray(uv, dtype=np.float64)[np.asarray(faces, dtype=np.int64)]
    lengths = np.linalg.norm(np.stack((
        triangles[:, 0] - triangles[:, 1],
        triangles[:, 1] - triangles[:, 2],
        triangles[:, 2] - triangles[:, 0],
    )), axis=2)
    return float(lengths.max()) if lengths.size else 0.0


def _project_uv_onto_island(points, vertices, faces, uv):
    """Closest-face barycentric UV restricted to one source island.

    The candidate triangles are the ones that can beat the nearest source
    vertex. That search uses a centroid tree, so it does not need rtree.
    """
    from scipy.spatial import cKDTree

    points = np.asarray(points, dtype=np.float64)
    vertices = np.asarray(vertices, dtype=np.float64)
    faces = np.asarray(faces, dtype=np.int64)
    uv = np.asarray(uv, dtype=np.float64)
    if len(points) == 0:
        return np.zeros((0, 2), dtype=np.float64)
    triangles = vertices[faces]
    centers = triangles.mean(axis=1)
    radii = np.linalg.norm(triangles - centers[:, None, :], axis=2).max(axis=1)
    upper, _index = cKDTree(vertices).query(points, k=1)
    upper = np.maximum(np.asarray(upper, dtype=np.float64), 0.0)
    reach = upper + (float(radii.max()) if len(radii) else 0.0) + 1e-8
    candidates = cKDTree(centers).query_ball_point(points, r=reach)
    chosen = np.empty(len(points), dtype=np.int64)
    closest = np.empty_like(points)
    for index, hits in enumerate(candidates):
        cand = np.asarray(hits, dtype=np.int64)
        if len(cand):
            near = np.linalg.norm(centers[cand] - points[index], axis=1) <= upper[index] + radii[cand] + 1e-8
            cand = cand[near]
        if len(cand) == 0:
            cand = np.arange(len(faces))
        hit = trimesh.triangles.closest_point(triangles[cand], np.repeat(points[index:index + 1], len(cand), axis=0))
        pick = int(np.argmin(np.linalg.norm(hit - points[index], axis=1)))
        chosen[index] = int(cand[pick])
        closest[index] = hit[pick]
    bary = np.clip(trimesh.triangles.points_to_barycentric(triangles[chosen], closest), 0, None)
    totals = bary.sum(axis=1, keepdims=True)
    totals[totals < 1e-12] = 1.0
    return np.einsum('ij,ijk->ik', bary / totals, uv[faces[chosen]])


def _reduce_large_uv_islands(mesh, target_faces, distortion_limit):
    """Simplify each UV chart on its own and interpolate UV only inside that chart.

    Island borders stay locked, so a seam vertex is never welded to the chart
    on the other side and then given that chart's UV.
    """
    import fast_simplification

    vertices = np.asarray(mesh.vertices, dtype=np.float64)
    faces = np.asarray(mesh.faces, dtype=np.int64)
    uv = np.asarray(_uv_array(mesh), dtype=np.float64)
    groups = _uv_islands(faces, uv)
    sizes = np.array([len(group) for group in groups], dtype=np.int64)
    raw = np.maximum(2, np.rint(float(target_faces) * sizes / max(int(sizes.sum()), 1)).astype(np.int64))
    targets = np.minimum(sizes, raw)
    parts_v, parts_f, parts_uv = [], [], []
    measured = 0.0
    for group, target in zip(groups, targets):
        island_v, island_f, island_uv = _take_faces(vertices, faces, uv, group)
        target = int(target)
        if len(island_f) > max(target, 4):
            points, indexed = fast_simplification.simplify(
                np.ascontiguousarray(island_v, dtype=np.float64),
                np.ascontiguousarray(island_f),
                target_count=max(target, 4), preserve_border=True)
            points = np.asarray(points, dtype=np.float64)
            indexed = np.asarray(indexed, dtype=np.int64)
            if len(indexed) == 0 or len(points) == 0:
                points, indexed, chart_uv = island_v, island_f, island_uv
            else:
                points, indexed, _unused = _compact_indexed(points, indexed, np.zeros((len(points), 2)))
                chart_uv = _project_uv_onto_island(points, island_v, island_f, island_uv)
        else:
            points, indexed, chart_uv = island_v, island_f, island_uv
        measured = max(measured, _max_uv_edge(chart_uv, indexed))
        parts_v.append(points)
        parts_f.append(indexed)
        parts_uv.append(chart_uv)
    merged_v, merged_f, merged_uv = [], [], []
    offset = 0
    for points, indexed, chart_uv in zip(parts_v, parts_f, parts_uv):
        merged_v.append(points)
        merged_f.append(np.asarray(indexed, dtype=np.int64) + offset)
        merged_uv.append(chart_uv)
        offset += len(points)
    points = np.vstack(merged_v)
    indexed = np.vstack(merged_f)
    chart_uv = np.vstack(merged_uv)
    result = trimesh.Trimesh(points, indexed, process=False)
    result.visual = trimesh.visual.TextureVisuals(uv=chart_uv, material=getattr(mesh.visual, 'material', None))
    limit = float(distortion_limit)
    return result, {
        'targetFaces': _as_int(target_faces), 'faces': _as_int(len(indexed)), 'vertices': _as_int(len(points)),
        'uvDistortion': float(measured), 'uvDistortionLimit': limit,
        'uvDistortionExceeded': bool(measured > limit), 'resampled': True,
        'uvTransfer': 'per-UV-island border lock, then closest-face barycentric UV inside that island',
    }


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
        return _reduce_large_uv_islands(mesh, target_faces, distortion_limit)
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


def _vertex_tangents(mesh):
    """Area-weighted vertex tangents using the engine face basis formula.

    ``face_tangent_basis`` is the per-triangle form: UV determinant, tangent
    projected off the normal, and glTF handedness ``-sign(det)``.
    """
    from native3d_engine import face_tangent_basis

    vertices = np.asarray(mesh.vertices, dtype=np.float64)
    faces = np.asarray(mesh.faces, dtype=np.int64)
    uv = np.asarray(_uv_array(mesh), dtype=np.float64)
    vertex_normals = np.asarray(mesh.vertex_normals, dtype=np.float64)
    xyz = vertices[faces]
    tri_uv = uv[faces]
    delta = tri_uv[:, 1:] - tri_uv[:, :1]
    determinant = np.linalg.det(delta)
    geometric = np.cross(xyz[:, 1] - xyz[:, 0], xyz[:, 2] - xyz[:, 0])
    area = 0.5 * np.linalg.norm(geometric, axis=1)
    ok = (np.abs(determinant) >= 1e-12) & (area >= 1e-15)
    # Keep the exported frames on the same formula as face_tangent_basis.
    tangent = np.zeros((len(faces), 3), dtype=np.float64)
    if np.any(ok):
        tangent[ok] = (
            (xyz[ok, 1] - xyz[ok, 0]) * delta[ok, 1, 1:2]
            - (xyz[ok, 2] - xyz[ok, 0]) * delta[ok, 0, 1:2]
        ) / determinant[ok, None]
        face_n = geometric[ok] / np.maximum(np.linalg.norm(geometric[ok], axis=1, keepdims=True), 1e-20)
        tangent[ok] -= face_n * np.einsum('ij,ij->i', face_n, tangent[ok])[:, None]
        tangent[ok] /= np.maximum(np.linalg.norm(tangent[ok], axis=1, keepdims=True), 1e-20)
        sample = int(np.flatnonzero(ok)[0])
        normal = geometric[sample] / max(float(np.linalg.norm(geometric[sample])), 1e-20)
        expected, _bitangent, expected_hand = face_tangent_basis(xyz[sample], tri_uv[sample], normal)
        if not np.allclose(tangent[sample], expected, atol=1e-5) or not np.isclose(-np.sign(determinant[sample]), expected_hand):
            raise RuntimeError('vertex tangents diverged from face_tangent_basis')
    handed = np.where(ok, -np.sign(determinant), 0.0)
    weight = np.where(ok, area, 0.0)
    accum = np.zeros((len(vertices), 3), dtype=np.float64)
    hand = np.zeros(len(vertices), dtype=np.float64)
    total = np.zeros(len(vertices), dtype=np.float64)
    for corner in range(3):
        np.add.at(accum, faces[:, corner], tangent * weight[:, None])
        np.add.at(hand, faces[:, corner], handed * weight)
        np.add.at(total, faces[:, corner], weight)
    accum -= vertex_normals * np.einsum('ij,ij->i', vertex_normals, accum)[:, None]
    length = np.linalg.norm(accum, axis=1)
    missing = (total <= 0) | (length < 1e-12)
    axis_index = np.argmin(np.abs(vertex_normals), axis=1)
    axis = np.zeros_like(vertex_normals)
    axis[np.arange(len(vertices)), axis_index] = 1.0
    fallback = np.cross(vertex_normals, axis)
    fallback /= np.maximum(np.linalg.norm(fallback, axis=1, keepdims=True), 1e-20)
    use = np.where(missing[:, None], fallback, accum / np.maximum(length, 1e-20)[:, None])
    sign = np.where(missing, 1.0, np.where(hand >= 0, 1.0, -1.0))
    frames = np.concatenate((use.astype(np.float32), sign.astype(np.float32)[:, None]), axis=1)
    return vertex_normals.astype(np.float32), np.ascontiguousarray(frames, dtype=np.float32)


def _ensure_tangents(mesh):
    existing = mesh.vertex_attributes.get('_TANGENT') if getattr(mesh, 'vertex_attributes', None) is not None else None
    if existing is not None:
        existing = np.asarray(existing)
        if existing.shape == (len(mesh.vertices), 4) and np.isfinite(existing).all():
            mesh.vertex_normals = np.asarray(mesh.vertex_normals, dtype=np.float32)
            return
    normals, frames = _vertex_tangents(mesh)
    mesh.vertex_normals = normals
    mesh.vertex_attributes['_TANGENT'] = frames


def _ensure_shared_orm(mesh):
    """Point occlusion and metallic-roughness at one image object."""
    from PIL import Image

    material = getattr(mesh.visual, 'material', None)
    if not hasattr(material, 'occlusionTexture'):
        material = trimesh.visual.material.PBRMaterial(
            roughnessFactor=float(getattr(material, 'roughnessFactor', 1.0) or 1.0),
            metallicFactor=float(getattr(material, 'metallicFactor', 0.0) or 0.0))
        mesh.visual.material = material
    occlusion = getattr(material, 'occlusionTexture', None)
    metallic = getattr(material, 'metallicRoughnessTexture', None)
    if occlusion is not None and occlusion is metallic:
        return
    image = metallic if metallic is not None else occlusion
    if image is None:
        image = Image.new('RGB', (4, 4), (255, 180, 16))
    material.occlusionTexture = image
    material.metallicRoughnessTexture = image


def deliver_shared_lods(mesh, output, **kwargs):
    derived = derive_shared_lods(mesh, **kwargs)
    from native3d_engine import export_glb
    folder = Path(output)
    folder.mkdir(parents=True, exist_ok=True)
    names = {'high': 'LOD0_high.glb', 'medium': 'LOD1_medium.glb', 'low': 'LOD2_low.glb'}
    for key, name in names.items():
        model = derived[key]
        _ensure_shared_orm(model)
        _ensure_tangents(model)
        export_glb(model, folder / name)
    return {
        'files': list(names.values()),
        'sharedTextures': derived['sharedTextures'],
        'medium': derived['reports']['medium'],
        'low': derived['reports']['low'],
        'optionalFbx': 'geometry-only FBX stays on the existing model.geometry-only.fbx delivery when a converter is available',
    }
