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


def _simple_boundary_loops(faces):
    """Closed boundary cycles whose vertices all have boundary degree 2."""
    edges, counts = _edge_table(faces)
    boundary = [tuple(int(v) for v in edge) for edge, count in zip(edges, counts) if int(count) == 1]
    adjacency = {}
    degree = {}
    for left, right in boundary:
        adjacency.setdefault(left, []).append(right)
        adjacency.setdefault(right, []).append(left)
        degree[left] = degree.get(left, 0) + 1
        degree[right] = degree.get(right, 0) + 1
    unused = {tuple(sorted(edge)) for edge in boundary}
    loops = []
    for seed in list(unused):
        if seed not in unused or degree.get(seed[0]) != 2 or degree.get(seed[1]) != 2:
            continue
        start = seed[0]
        loop = [start]
        previous = None
        current = start
        closed = False
        simple = True
        while len(loop) <= len(boundary) + 1:
            choices = [
                item for item in adjacency.get(current, [])
                if item != previous and degree.get(item) == 2 and tuple(sorted((current, item))) in unused
            ]
            # The first vertex still has both cycle edges unused. Later vertices have one.
            if previous is None:
                if not choices:
                    simple = False
                    break
            elif len(choices) != 1:
                simple = False
                break
            nxt = choices[0]
            unused.discard(tuple(sorted((current, nxt))))
            if nxt == start:
                closed = True
                break
            loop.append(nxt)
            previous, current = current, nxt
        if closed and simple and len(loop) >= 3 and len(set(loop)) == len(loop):
            loops.append(loop)
    return loops


def _occupancy(faces):
    counts = {}
    keys = set()
    for face in np.asarray(faces, dtype=np.int64):
        verts = (int(face[0]), int(face[1]), int(face[2]))
        keys.add(tuple(sorted(verts)))
        for start, end in ((verts[0], verts[1]), (verts[1], verts[2]), (verts[2], verts[0])):
            edge = (start, end) if start < end else (end, start)
            counts[edge] = counts.get(edge, 0) + 1
    return counts, keys


def _triangle_is_safe(vertices, a, b, c, counts, keys):
    if len({a, b, c}) < 3:
        return False
    key = tuple(sorted((a, b, c)))
    if key in keys:
        return False
    triangle = np.asarray(vertices, dtype=np.float64)[[a, b, c]]
    area = 0.5 * float(np.linalg.norm(np.cross(triangle[1] - triangle[0], triangle[2] - triangle[0])))
    if area <= 1e-15:
        return False
    for start, end in ((a, b), (b, c), (c, a)):
        edge = (start, end) if start < end else (end, start)
        if counts.get(edge, 0) >= 2:
            return False
    return True


def _commit_triangle(a, b, c, counts, keys):
    keys.add(tuple(sorted((a, b, c))))
    for start, end in ((a, b), (b, c), (c, a)):
        edge = (start, end) if start < end else (end, start)
        counts[edge] = counts.get(edge, 0) + 1


def _newell_normal(vertices, loop):
    points = np.asarray(vertices, dtype=np.float64)[list(loop)]
    normal = np.cross(points, np.roll(points, -1, axis=0)).sum(axis=0)
    length = float(np.linalg.norm(normal))
    if length < 1e-15:
        return None
    return normal / length


def _project_loop(vertices, loop, normal):
    axis = np.array([1.0, 0.0, 0.0]) if abs(float(normal[0])) < 0.9 else np.array([0.0, 1.0, 0.0])
    tangent = np.cross(normal, axis)
    tangent = tangent / np.linalg.norm(tangent)
    bitangent = np.cross(normal, tangent)
    points = np.asarray(vertices, dtype=np.float64)[list(loop)]
    offset = points - points[0]
    return np.column_stack((offset @ tangent, offset @ bitangent))


def _strictly_inside(point, a, b, c):
    def side(origin, left, right):
        return (left[0] - origin[0]) * (right[1] - origin[1]) - (left[1] - origin[1]) * (right[0] - origin[0])
    first, second, third = side(a, b, point), side(b, c, point), side(c, a, point)
    return (first > 1e-12 and second > 1e-12 and third > 1e-12) or (first < -1e-12 and second < -1e-12 and third < -1e-12)


def _triangulate_loop(vertices, loop, counts, keys):
    """Ear-clip one simple loop. A chord is used only when the new triangle stays manifold."""
    loop = [int(v) for v in loop]
    if len(loop) < 3:
        return []
    normal = _newell_normal(vertices, loop)
    if normal is None:
        return []
    flat = _project_loop(vertices, loop, normal)
    area = 0.5 * float(np.dot(flat[:, 0], np.roll(flat[:, 1], -1)) - np.dot(flat[:, 1], np.roll(flat[:, 0], -1)))
    if area < 0:
        loop.reverse()
        flat = flat[::-1].copy()
    remaining = list(range(len(loop)))
    added = []
    guard = len(loop) * len(loop)
    while len(remaining) > 3 and guard > 0:
        guard -= 1
        best = None
        for index, current in enumerate(remaining):
            previous = remaining[index - 1]
            nxt = remaining[(index + 1) % len(remaining)]
            pa, pb, pc = flat[previous], flat[current], flat[nxt]
            cross = (pb[0] - pa[0]) * (pc[1] - pa[1]) - (pb[1] - pa[1]) * (pc[0] - pa[0])
            if cross <= 1e-12:
                continue
            if any(_strictly_inside(flat[other], pa, pb, pc) for other in remaining if other not in (previous, current, nxt)):
                continue
            a, b, c = loop[previous], loop[current], loop[nxt]
            if not _triangle_is_safe(vertices, a, b, c, counts, keys):
                continue
            if best is None or cross < best[0]:
                best = (cross, index, a, b, c)
        if best is None:
            break
        _cross, index, a, b, c = best
        _commit_triangle(a, b, c, counts, keys)
        added.append((a, b, c))
        del remaining[index]
    if len(remaining) == 3:
        a, b, c = (loop[index] for index in remaining)
        if _triangle_is_safe(vertices, a, b, c, counts, keys):
            _commit_triangle(a, b, c, counts, keys)
            added.append((a, b, c))
    return added


def _fill_holes(vertices, faces, protected=None):
    """Close simple boundary loops without a new non-manifold edge or a duplicate face.

    ``protected`` loops are the input's own open boundary and are left untouched.
    """
    faces = np.asarray(faces, dtype=np.int64)
    if len(faces) == 0:
        return faces, 0, 0
    counts, keys = _occupancy(faces)
    added = []
    filled = 0
    longest = 0
    for _ in range(max(1, len(faces))):
        current = np.vstack([faces, np.asarray(added, dtype=np.int64)]) if added else faces
        loops = _simple_boundary_loops(current)
        if not loops:
            break
        loops.sort(key=len)
        progressed = False
        for loop in loops:
            ring = [tuple(sorted((int(loop[index]), int(loop[(index + 1) % len(loop)])))) for index in range(len(loop))]
            if protected and all(edge in protected for edge in ring):
                continue
            triangles = _triangulate_loop(vertices, loop, counts, keys)
            if not triangles:
                continue
            added.extend(triangles)
            filled += 1
            longest = max(longest, len(loop))
            progressed = True
            break
        if not progressed:
            break
    if not added:
        return faces, 0, 0
    return np.vstack([faces, np.asarray(added, dtype=np.int64)]), filled, longest


def _protected_boundary(faces):
    """Boundary edges of faces that are not themselves touching a non-manifold edge.

    Those edges are the input sheet outline. Boundary edges of a non-manifold
    fin are defects and stay eligible for peeling and hole fill.
    """
    edges, counts = _edge_table(faces)
    count = {tuple(int(v) for v in edge): int(value) for edge, value in zip(edges, counts)}
    protected = set()
    for face in np.asarray(faces, dtype=np.int64):
        verts = [int(value) for value in face]
        face_edges = []
        dirty = False
        for index in range(3):
            left, right = verts[index], verts[(index + 1) % 3]
            edge = (left, right) if left < right else (right, left)
            face_edges.append(edge)
            if count.get(edge, 0) > 2:
                dirty = True
        if dirty:
            continue
        for edge in face_edges:
            if count.get(edge, 0) == 1:
                protected.add(edge)
    return protected


def _remap_edges(edges, remap):
    remapped = set()
    for left, right in edges:
        first, second = int(remap[left]), int(remap[right])
        if first < 0 or second < 0 or first == second:
            continue
        remapped.add((first, second) if first < second else (second, first))
    return remapped


def _peel_boundary_spikes(faces, protected=None):
    """Drop faces left hanging by one edge after a non-manifold face is removed.

    A face is a spike when two of its edges are boundary and at least one of
    those edges is not part of the input sheet outline. Sheet corners stay.
    """
    faces = np.asarray(faces, dtype=np.int64)
    removed = 0
    while len(faces):
        edges, counts = _edge_table(faces)
        count = {tuple(int(v) for v in edge): int(value) for edge, value in zip(edges, counts)}
        drop = np.zeros(len(faces), dtype=bool)
        for index, face in enumerate(faces):
            boundary = []
            for offset in range(3):
                left, right = int(face[offset]), int(face[(offset + 1) % 3])
                edge = (left, right) if left < right else (right, left)
                if count.get(edge, 0) == 1:
                    boundary.append(edge)
            if len(boundary) >= 2 and (not protected or any(edge not in protected for edge in boundary)):
                drop[index] = True
        if not np.any(drop):
            break
        removed += int(np.count_nonzero(drop))
        faces = faces[~drop]
    return faces, removed


def _incident_fans(faces):
    """Group faces around each vertex into edge-connected fans."""
    faces = np.asarray(faces, dtype=np.int64)
    edge_users = {}
    incident = {}
    for index, face in enumerate(faces):
        verts = (int(face[0]), int(face[1]), int(face[2]))
        for vertex in verts:
            incident.setdefault(vertex, []).append(index)
        for start, end in ((verts[0], verts[1]), (verts[1], verts[2]), (verts[2], verts[0])):
            edge = (start, end) if start < end else (end, start)
            edge_users.setdefault(edge, []).append(index)
    groups = {}
    for vertex, face_ids in incident.items():
        unique = list(dict.fromkeys(face_ids))
        if len(unique) < 2:
            continue
        member = set(unique)
        neighbors = {face_id: [] for face_id in unique}
        for face_id in unique:
            triangle = faces[face_id]
            for corner in range(3):
                other = int(triangle[corner])
                if other == vertex:
                    continue
                edge = (vertex, other) if vertex < other else (other, vertex)
                for linked in edge_users.get(edge, ()):
                    if linked != face_id and linked in member:
                        neighbors[face_id].append(linked)
        seen = set()
        components = []
        for face_id in unique:
            if face_id in seen:
                continue
            stack = [face_id]
            seen.add(face_id)
            component = []
            while stack:
                current = stack.pop()
                component.append(current)
                for nxt in neighbors[current]:
                    if nxt not in seen:
                        seen.add(nxt)
                        stack.append(nxt)
            components.append(component)
        if len(components) > 1:
            groups[vertex] = components
    return groups


def _split_nonmanifold_vertices(vertices, faces):
    """Duplicate a pinched vertex once per extra face fan. Coordinates stay put."""
    faces = np.array(faces, dtype=np.int64, copy=True)
    vertices = np.array(vertices, dtype=np.float64, copy=True)
    groups = _incident_fans(faces)
    if not groups:
        return vertices, faces, 0
    extra = []
    split = 0
    for vertex, components in groups.items():
        ordered = sorted(components, key=len, reverse=True)
        for component in ordered[1:]:
            new_index = len(vertices) + len(extra)
            extra.append(vertices[vertex])
            split += 1
            for face_id in component:
                face = faces[face_id]
                face[face == vertex] = new_index
                faces[face_id] = face
    if extra:
        vertices = np.vstack([vertices, np.asarray(extra, dtype=np.float64)])
    return vertices, faces, split


def _topology_defects(vertices, faces, count_vertices=True):
    faces = np.asarray(faces, dtype=np.int64)
    empty = {'nonManifoldEdges': 0, 'boundaryEdges': 0, 'nonManifoldVertices': 0, 'inconsistentWindingEdges': 0}
    if len(faces) == 0:
        return empty
    _edges, counts = _edge_table(faces)
    directed = np.stack((faces, np.roll(faces, -1, axis=1)), axis=2).reshape(-1, 2)
    undirected = np.sort(directed, axis=1)
    order = np.lexsort((undirected[:, 1], undirected[:, 0]))
    sorted_edges = undirected[order]
    begin = np.r_[0, np.flatnonzero(np.any(sorted_edges[1:] != sorted_edges[:-1], axis=1)) + 1]
    count = np.diff(np.r_[begin, len(order)])
    paired = begin[count == 2]
    winding = 0
    if len(paired):
        left, right = order[paired], order[paired + 1]
        winding = int(np.count_nonzero(np.all(directed[left] == directed[right], axis=1)))
    return {
        'nonManifoldEdges': int(np.count_nonzero(counts > 2)),
        'boundaryEdges': int(np.count_nonzero(counts == 1)),
        'nonManifoldVertices': len(_incident_fans(faces)) if count_vertices else 0,
        'inconsistentWindingEdges': winding,
    }


def _surface_error(source, repaired):
    import open3d as o3d
    scene = o3d.t.geometry.RaycastingScene()
    scene.add_triangles(
        o3d.core.Tensor(np.asarray(repaired.vertices, dtype=np.float32)),
        o3d.core.Tensor(np.asarray(repaired.faces, dtype=np.uint32)))
    query = np.asarray(source.vertices, dtype=np.float64)
    if len(query) == 0 or len(repaired.faces) == 0:
        return None
    closest = scene.compute_closest_points(o3d.core.Tensor(query.astype(np.float32)))['points'].numpy()
    distance = np.linalg.norm(closest - query, axis=1)
    if not np.isfinite(distance).all():
        return None
    return {'max': float(distance.max()), 'mean': float(distance.mean())}


def _reconstruction_face_target(source_faces, reconstructed_faces):
    """Keep a Poisson surface inside 160k faces.

    A source above that band is reduced to 140k so a 300k white mesh cannot
    come back heavier than it went in. Smaller sources keep a lighter isosurface.
    """
    if reconstructed_faces <= 160_000:
        return None
    if source_faces > 160_000:
        return 140_000
    return 160_000


def _simplify_to_face_target(mesh, target):
    """Decimate a watertight surface with Open3D QEM while preserving winding."""
    import open3d as o3d
    legacy = o3d.geometry.TriangleMesh(
        o3d.utility.Vector3dVector(np.asarray(mesh.vertices, dtype=np.float64)),
        o3d.utility.Vector3iVector(np.asarray(mesh.faces, dtype=np.int64)))
    simplified = legacy.simplify_quadric_decimation(target_number_of_triangles=max(4, int(target)))
    simplified.remove_duplicated_vertices()
    simplified.remove_duplicated_triangles()
    simplified.remove_degenerate_triangles()
    simplified.remove_unreferenced_vertices()
    points = np.asarray(simplified.vertices, dtype=np.float64)
    indexed = np.asarray(simplified.triangles, dtype=np.int64)
    if len(indexed) < 4 or len(points) < 4:
        raise RuntimeError('Reconstruction decimation produced no surface')
    indexed, _removed, _duplicates = _drop_degenerate_and_duplicates(points, indexed)
    points, indexed, _remap = _compact(points, indexed)
    if len(indexed) < 4:
        raise RuntimeError('Reconstruction decimation removed every face')
    result = trimesh.Trimesh(points, indexed, process=False)
    result.fix_normals()
    return result


def _audit_reconstructed_surface(vertices, faces):
    """Real intersection check. Exact diagnose stays within its own triangle limit.

    Larger surfaces use the production auditor, which stops when it finds a
    defect and never reports an unfinished search as clean.
    """
    if len(faces) <= 10000:
        from native3d_geometry import diagnose
        report = diagnose(vertices, faces)
        pairs = len(report['intersection_pairs'])
        nonmanifold = len(report['nonmanifold_edges'])
        pinched = len(report['nonmanifold_vertices'])
        degenerate = len(report['degenerate_faces'])
        clean = (
            pairs == 0 and nonmanifold == 0 and pinched == 0 and degenerate == 0
            and report['boundary_edges'] == 0 and report['inconsistent_winding_edges'] == 0)
        return {
            'method': 'diagnose',
            'intersectionComplete': True,
            'intersection_pairs_count': pairs,
            'nonManifoldEdges': nonmanifold,
            'nonManifoldVertices': pinched,
            'degenerateTriangles': degenerate,
            'boundaryEdges': report['boundary_edges'],
            'inconsistentWindingEdges': report['inconsistent_winding_edges'],
            'intersection_pairs': report['intersection_pairs'][:64],
            'status': 'accepted' if clean else 'blocked',
        }
    from native3d_geometry_audit import audit_geometry
    report = audit_geometry(vertices, faces, max_seconds=60, allow_boundaries=False)
    return {
        'method': 'audit_geometry',
        'intersectionComplete': bool(report.get('intersectionComplete')),
        'intersection_pairs_count': report.get('intersection_pairs_count'),
        'nonManifoldEdges': report.get('nonmanifold_edges_count'),
        'nonManifoldVertices': report.get('nonmanifold_vertices_count'),
        'degenerateTriangles': report.get('degenerate_faces_count'),
        'boundaryEdges': report.get('boundary_edges'),
        'inconsistentWindingEdges': report.get('inconsistent_winding_edges'),
        'intersection_pairs': report.get('intersection_pairs') or [],
        'status': report.get('status'),
        'blocker': report.get('blocker'),
    }


def _taubin_smooth(mesh, iterations):
    import open3d as o3d
    legacy = o3d.geometry.TriangleMesh(
        o3d.utility.Vector3dVector(np.asarray(mesh.vertices, dtype=np.float64)),
        o3d.utility.Vector3iVector(np.asarray(mesh.faces, dtype=np.int64)))
    if len(legacy.triangles) < 4:
        return mesh
    legacy.compute_vertex_normals()
    legacy.filter_smooth_taubin(number_of_iterations=int(iterations))
    legacy.remove_degenerate_triangles()
    legacy.remove_unreferenced_vertices()
    if len(legacy.triangles) < 4:
        return mesh
    return trimesh.Trimesh(np.asarray(legacy.vertices), np.asarray(legacy.triangles), process=False)


def _drop_intersection_faces(mesh, pairs, limit=64):
    """Remove the faces named by one intersection audit, at most ``limit`` of them."""
    chosen = []
    for pair in pairs or []:
        for face_id in pair:
            face_id = int(face_id)
            if face_id not in chosen:
                chosen.append(face_id)
            if len(chosen) >= limit:
                break
        if len(chosen) >= limit:
            break
    if not chosen or len(mesh.faces) - len(chosen) < 4:
        return mesh, 0
    keep = np.ones(len(mesh.faces), dtype=bool)
    keep[np.asarray(chosen, dtype=np.int64)] = False
    return trimesh.Trimesh(np.asarray(mesh.vertices), np.asarray(mesh.faces)[keep], process=False), len(chosen)


def _surface_is_clean(audit):
    if not audit.get('intersectionComplete'):
        return False
    if audit.get('intersection_pairs_count') not in (0,):
        return False
    if audit.get('nonManifoldEdges') not in (0,):
        return False
    if audit.get('nonManifoldVertices') not in (0, None):
        return False
    if audit.get('degenerateTriangles') not in (0,):
        return False
    if audit.get('inconsistentWindingEdges') not in (0, None):
        return False
    if audit.get('boundaryEdges') not in (0, None):
        return False
    return audit.get('status') == 'accepted'


def _reconstruct_sdf_marching_cubes(source):
    """Rebuild an orientable zero-intersection watertight mesh via clamped SDF Marching Cubes."""
    import open3d as o3d
    from scipy.ndimage import gaussian_filter
    from skimage.measure import marching_cubes

    src_vertices = np.asarray(source.vertices, dtype=np.float32)
    src_faces = np.asarray(source.faces, dtype=np.uint32)
    scene = o3d.t.geometry.RaycastingScene()
    scene.add_triangles(o3d.core.Tensor(src_vertices), o3d.core.Tensor(src_faces))
    bounds = np.asarray(source.bounds, dtype=np.float64)
    extent = np.maximum(bounds[1] - bounds[0], 1e-4)
    pad = float(np.max(extent)) * 0.05
    lo = bounds[0] - pad
    hi = bounds[1] + pad
    schedule = (
        [(144, 0.5, (100_000, 80_000)), (128, 0.5, (80_000, 60_000))]
        if len(src_faces) > 2000
        else [(48, 0.5, (None, 4_000)), (64, 0.5, (8_000, 4_000))]
    )
    attempts = []
    for res, sigma, qem_targets in schedule:
        xs = np.linspace(lo[0], hi[0], res, dtype=np.float32)
        ys = np.linspace(lo[1], hi[1], res, dtype=np.float32)
        zs = np.linspace(lo[2], hi[2], res, dtype=np.float32)
        gx, gy, gz = np.meshgrid(xs, ys, zs, indexing='ij')
        pts = np.stack([gx.ravel(), gy.ravel(), gz.ravel()], axis=1)
        sdf = scene.compute_signed_distance(o3d.core.Tensor(pts)).numpy().reshape((res, res, res)).astype(np.float64)
        if sigma and sigma > 0:
            sdf = gaussian_filter(sdf, sigma=float(sigma))
        spacing = (hi - lo) / (res - 1)
        floor = max(1e-7, 0.05 * float(np.max(spacing)))
        sdf = np.where(np.abs(sdf) < floor, np.where(sdf >= 0, floor, -floor), sdf)
        verts, faces, _, _ = marching_cubes(sdf, level=0.0, spacing=tuple(spacing), method='lewiner')
        verts = np.asarray(verts, dtype=np.float64) + lo
        base_mesh = trimesh.Trimesh(verts, np.asarray(faces, dtype=np.int64), process=False)
        parts = base_mesh.split(only_watertight=False)
        if len(parts) > 1:
            base_mesh = max(parts, key=lambda part: len(part.faces))
        base_mesh.fix_normals()
        for qem_target in qem_targets:
            candidate = (
                _simplify_to_face_target(base_mesh, qem_target)
                if qem_target is not None and len(base_mesh.faces) > qem_target
                else base_mesh.copy()
            )
            candidate.fix_normals()
            audit = _audit_reconstructed_surface(candidate.vertices, candidate.faces)
            attempts.append({
                'sdfResolution': int(res),
                'sdfSigma': float(sigma),
                'targetFaces': qem_target,
                'faces': _as_int(len(candidate.faces)),
                'intersectionCheck': audit['method'],
                'intersectionComplete': audit['intersectionComplete'],
                'intersection_pairs_count': audit['intersection_pairs_count'],
                'nonManifoldEdges': audit['nonManifoldEdges'],
                'nonManifoldVertices': audit.get('nonManifoldVertices'),
                'inconsistentWindingEdges': audit.get('inconsistentWindingEdges'),
                'degenerateTriangles': audit['degenerateTriangles'],
                'status': audit['status'],
            })
            if _surface_is_clean(audit):
                error = _surface_error(source, candidate)
                return candidate, {
                    'triggered': True,
                    'method': 'open3d sdf raycasting + clamped marching cubes + open3d qem',
                    'linearFit': False,
                    'sdfResolution': int(res),
                    'sdfSigma': float(sigma),
                    'simplified': qem_target is not None and len(base_mesh.faces) > qem_target,
                    'targetFaces': qem_target,
                    'attempts': attempts,
                    'faces': _as_int(len(candidate.faces)),
                    'intersectionCheck': audit['method'],
                    'intersectionComplete': audit['intersectionComplete'],
                    'intersection_pairs_count': audit['intersection_pairs_count'],
                    'nonManifoldEdges': audit['nonManifoldEdges'],
                    'nonManifoldVertices': audit.get('nonManifoldVertices'),
                    'inconsistentWindingEdges': audit.get('inconsistentWindingEdges'),
                    'degenerateTriangles': audit['degenerateTriangles'],
                    'surfaceErrorMax': None if error is None else error['max'],
                    'surfaceErrorMean': None if error is None else error['mean'],
                    'manifoldAfterReconstruction': True,
                }
    return None, {'triggered': True, 'method': 'open3d sdf raycasting + clamped marching cubes + open3d qem', 'attempts': attempts}


def _reconstruct_watertight(source, epsilon=1e-5, island_fraction=0.01):
    """Poisson isosurface used only after bounded topology repair is still dirty.

    ``linear_fit`` stays off so creases do not grow sliver faces. A heavy
    isosurface is decimated into the 120k–160k band, then the same conservative
    cleanup removes non-manifold and degenerate faces. If Poisson decimation
    still leaves topology/winding/intersection defects, clamped SDF Marching Cubes
    with Open3D QEM produces an orientable zero-intersection surface.
    """
    import open3d as o3d
    legacy = o3d.geometry.TriangleMesh(
        o3d.utility.Vector3dVector(np.asarray(source.vertices, dtype=np.float64)),
        o3d.utility.Vector3iVector(np.asarray(source.faces, dtype=np.int64)))
    legacy.remove_duplicated_vertices()
    legacy.remove_degenerate_triangles()
    legacy.compute_vertex_normals()
    count = int(min(max(len(source.faces) * 2, 2000), 80000))
    random_state = np.random.get_state()
    np.random.seed(0x3D11)
    try:
        try:
            cloud = legacy.sample_points_poisson_disk(number_of_points=count, use_triangle_normal=True)
        except RuntimeError:
            cloud = legacy.sample_points_uniformly(number_of_points=count)
            cloud.estimate_normals()
    finally:
        np.random.set_state(random_state)
    depth = 8 if len(source.faces) > 2000 else 6
    reconstructed, _densities = o3d.geometry.TriangleMesh.create_from_point_cloud_poisson(
        cloud, depth=depth, linear_fit=False)
    reconstructed.remove_duplicated_vertices()
    reconstructed.remove_degenerate_triangles()
    reconstructed.remove_unreferenced_vertices()
    vertices = np.asarray(reconstructed.vertices, dtype=np.float64)
    faces = np.asarray(reconstructed.triangles, dtype=np.int64)
    if len(faces) < 4:
        raise RuntimeError('Poisson reconstruction produced no surface')
    mesh = trimesh.Trimesh(vertices, faces, process=False)
    target = _reconstruction_face_target(len(source.faces), len(mesh.faces))
    simplified = False
    if target is not None and len(mesh.faces) > target:
        mesh = _simplify_to_face_target(mesh, target)
        simplified = True
    removed_intersections = 0
    rounds = []

    def record(round_index, loop, audit, removed=0, extra_passes=0):
        rounds.append({
            'round': round_index,
            'faces': _as_int(len(mesh.faces)),
            'repairPasses': loop['repairPasses'] + extra_passes,
            'stalled': loop['stalled'],
            'removedIntersectingFaces': removed,
            'intersectionCheck': audit['method'],
            'intersectionComplete': audit['intersectionComplete'],
            'intersection_pairs_count': audit['intersection_pairs_count'],
            'nonManifoldEdges': audit['nonManifoldEdges'],
            'degenerateTriangles': audit['degenerateTriangles'],
        })

    mesh, first_loop = _bounded_topology_repair(mesh, epsilon, island_fraction)
    mesh = _taubin_smooth(mesh, 2)
    mesh, loop = _bounded_topology_repair(mesh, epsilon, island_fraction)
    audit = _audit_reconstructed_surface(mesh.vertices, mesh.faces)
    record(1, loop, audit, extra_passes=first_loop['repairPasses'])
    if not _surface_is_clean(audit) and len(mesh.faces) >= 4:
        mesh, removed_intersections = _drop_intersection_faces(mesh, audit.get('intersection_pairs'))
        if removed_intersections:
            mesh, loop = _bounded_topology_repair(mesh, epsilon, island_fraction)
            if len(mesh.faces) > 160_000:
                mesh = _simplify_to_face_target(mesh, 140_000)
                simplified = True
            audit = _audit_reconstructed_surface(mesh.vertices, mesh.faces)
            record(2, loop, audit, removed_intersections)
    clean = _surface_is_clean(audit)
    if not clean:
        try:
            sdf_mesh, sdf_meta = _reconstruct_sdf_marching_cubes(source)
            if sdf_mesh is not None and sdf_meta.get('manifoldAfterReconstruction'):
                sdf_meta['poissonFallbackReason'] = {
                    'faces': _as_int(len(mesh.faces)),
                    'cleanupRounds': rounds,
                    'status': audit.get('status'),
                    'blocker': audit.get('blocker'),
                    'intersection_pairs_count': audit.get('intersection_pairs_count'),
                    'nonManifoldVertices': audit.get('nonManifoldVertices'),
                    'inconsistentWindingEdges': audit.get('inconsistentWindingEdges'),
                }
                return sdf_mesh, sdf_meta
        except (RuntimeError, ValueError, ImportError):
            pass
    error = _surface_error(source, mesh)
    return mesh, {
        'triggered': True,
        'method': 'open3d poisson watertight isosurface, linear_fit off, taubin, face cap, conservative cleanup',
        'linearFit': False,
        'poissonDepth': depth,
        'sampleCount': count,
        'taubinIterations': 2,
        'simplified': simplified,
        'targetFaces': target,
        'cleanupRounds': rounds,
        'faces': _as_int(len(mesh.faces)),
        'intersectionCheck': None if audit is None else audit['method'],
        'intersectionComplete': False if audit is None else audit['intersectionComplete'],
        'intersection_pairs_count': None if audit is None else audit['intersection_pairs_count'],
        'nonManifoldEdges': None if audit is None else audit['nonManifoldEdges'],
        'nonManifoldVertices': None if audit is None else audit.get('nonManifoldVertices'),
        'inconsistentWindingEdges': None if audit is None else audit.get('inconsistentWindingEdges'),
        'degenerateTriangles': None if audit is None else audit['degenerateTriangles'],
        'surfaceErrorMax': None if error is None else error['max'],
        'surfaceErrorMean': None if error is None else error['mean'],
        'manifoldAfterReconstruction': clean,
    }


def _compact(vertices, faces):
    used = np.unique(faces) if len(faces) else np.zeros(0, dtype=np.int64)
    remap = np.full(len(vertices), -1, dtype=np.int64)
    remap[used] = np.arange(len(used))
    compacted = remap[faces] if len(faces) else faces
    return np.asarray(vertices, dtype=np.float64)[used], compacted, remap


def _clean_pass(vertices, faces, island_fraction, protected):
    faces, removed_degenerate, removed_duplicates = _drop_degenerate_and_duplicates(vertices, faces)
    faces, removed_islands = _drop_islands(vertices, faces, island_fraction)
    faces, repaired = _drop_nonmanifold(vertices, faces)
    vertices, faces, split = _split_nonmanifold_vertices(vertices, faces)
    edges, edge_counts = _edge_table(faces)
    boundary = {tuple(int(vertex) for vertex in edge) for edge, count in zip(edges, edge_counts) if int(count) == 1}
    opened = int(np.count_nonzero(edge_counts > 2)) > 0 or any(edge not in protected for edge in boundary)
    if opened:
        faces, peeled = _peel_boundary_spikes(faces, protected)
        faces, filled, longest = _fill_holes(vertices, faces, protected)
    else:
        peeled = filled = longest = 0
    vertices, faces, remap = _compact(vertices, faces)
    return vertices, faces, remap, {
        'removedDegenerateTriangles': removed_degenerate,
        'removedDuplicateFaces': removed_duplicates,
        'removedIslands': removed_islands,
        'repairedNonManifoldFaces': repaired,
        'splitNonManifoldVertices': split,
        'peeledBoundaryFaces': peeled,
        'filledHoles': filled,
        'maxFilledLoop': longest,
    }


def _defects_cleared(defects, started_closed):
    if defects['nonManifoldEdges'] or defects['nonManifoldVertices'] or defects['inconsistentWindingEdges']:
        return False
    if started_closed and defects['boundaryEdges']:
        return False
    return True


def _bounded_topology_repair(mesh, epsilon, island_fraction, before=None, initial=None):
    """Weld and clean until the defect counts stop falling, at most eight passes."""
    if before is None:
        before = topology_report(mesh, epsilon, island_fraction)
    if initial is None:
        initial = _topology_defects(mesh.vertices, mesh.faces, count_vertices=False)
    started_closed = before['boundaryEdges'] == 0 and initial['boundaryEdges'] == 0
    vertices, faces, welded = spatial_weld(mesh.vertices, mesh.faces, epsilon)
    protected = _protected_boundary(faces)
    totals = {key: 0 for key in (
        'removedDegenerateTriangles', 'removedDuplicateFaces', 'removedIslands',
        'repairedNonManifoldFaces', 'splitNonManifoldVertices', 'peeledBoundaryFaces',
        'filledHoles')}
    longest_loop = 0
    from native3d_engine import repair_winding
    winding = None
    passes = 0
    stalled = False
    defects = _topology_defects(vertices, faces, count_vertices=False)
    for _ in range(8):
        passes += 1
        snapshot = (
            len(faces), defects['nonManifoldEdges'],
            defects['boundaryEdges'], defects['inconsistentWindingEdges'])
        vertices, faces, remap, counts = _clean_pass(vertices, faces, island_fraction, protected)
        protected = _remap_edges(protected, remap)
        longest_loop = max(longest_loop, counts.pop('maxFilledLoop'))
        for key, value in counts.items():
            totals[key] += value
        if len(faces) == 0:
            defects = _topology_defects(vertices, faces, count_vertices=False)
            break
        current = trimesh.Trimesh(vertices, faces, process=False)
        current, winding = repair_winding(current)
        vertices = np.asarray(current.vertices, dtype=np.float64)
        faces = np.asarray(current.faces, dtype=np.int64)
        # Split already separated every pinch. Recount vertices only when peel
        # or hole fill added or removed faces afterwards.
        surface_changed = counts['peeledBoundaryFaces'] or counts['filledHoles']
        defects = _topology_defects(vertices, faces, count_vertices=bool(surface_changed))
        progressed = (
            len(faces), defects['nonManifoldEdges'],
            defects['boundaryEdges'], defects['inconsistentWindingEdges']) != snapshot or any(counts.values())
        if _defects_cleared(defects, started_closed) or not progressed:
            stalled = not progressed and not _defects_cleared(defects, started_closed)
            break
    repaired_mesh = trimesh.Trimesh(vertices, faces, process=False) if len(faces) else mesh
    return repaired_mesh, {
        'before': before, 'initial': initial, 'startedClosed': started_closed, 'weldedVertices': welded,
        **totals, 'maxFilledLoop': longest_loop, 'repairPasses': passes, 'stalled': stalled,
        'winding': winding, 'defects': defects,
    }


def repair_high(mesh, epsilon=1e-5, island_fraction=0.01):
    """Clean a high mesh. An already clean mesh is returned unchanged.

    Closed dirty input is welded, pruned, split at pinched vertices, capped,
    and reoriented until edges, vertices, and winding are manifold. A pass that
    does not change the geometry or the defect counts stops the loop. A still
    dirty result may be replaced by a recorded Poisson isosurface. ``before``
    stays the untouched input report.
    """
    before = topology_report(mesh, epsilon, island_fraction)
    initial = _topology_defects(mesh.vertices, mesh.faces, count_vertices=False)
    dirty = any(before[key] for key in ('weldedVertices', 'degenerateTriangles', 'nonManifoldEdges', 'isolatedFragments'))
    dirty = dirty or initial['nonManifoldEdges'] or initial['inconsistentWindingEdges']
    if not dirty:
        initial['nonManifoldVertices'] = len(_incident_fans(mesh.faces))
        dirty = initial['nonManifoldVertices'] > 0
    if not dirty and 0 < len(mesh.faces) <= 8000:
        from native3d_geometry import diagnose
        try:
            dirty = bool(diagnose(mesh.vertices, mesh.faces)['intersection_pairs'])
        except (ValueError, RuntimeError):
            dirty = False
    empty = {
        'changed': False, 'before': before, 'after': before, 'weldedVertices': 0,
        'removedDegenerateTriangles': 0, 'removedDuplicateFaces': 0, 'removedIslands': 0,
        'repairedNonManifoldFaces': 0, 'filledHoles': 0, 'splitNonManifoldVertices': 0,
        'repairPasses': 0, 'reconstruction': None,
    }
    if not dirty:
        return mesh, empty
    repaired_mesh, loop = _bounded_topology_repair(
        mesh, epsilon, island_fraction, before=before, initial=initial)
    totals = {key: loop[key] for key in (
        'removedDegenerateTriangles', 'removedDuplicateFaces', 'removedIslands',
        'repairedNonManifoldFaces', 'splitNonManifoldVertices', 'peeledBoundaryFaces',
        'filledHoles')}
    longest_loop = loop['maxFilledLoop']
    passes = loop['repairPasses']
    winding = loop['winding']
    welded = loop['weldedVertices']
    defects = loop['defects']
    started_closed = loop['startedClosed']
    reconstruction = None
    needs_rebuild = not _defects_cleared(defects, started_closed)
    if not needs_rebuild and 0 < len(repaired_mesh.faces) <= 8000:
        from native3d_geometry import diagnose
        try:
            needs_rebuild = bool(diagnose(repaired_mesh.vertices, repaired_mesh.faces)['intersection_pairs'])
        except (ValueError, RuntimeError):
            needs_rebuild = False
    if needs_rebuild:
        try:
            rebuilt, reconstruction = _reconstruct_watertight(mesh, epsilon, island_fraction)
            repaired_mesh = rebuilt
        except (RuntimeError, ValueError, ImportError) as error:
            reconstruction = {'triggered': True, 'method': 'open3d poisson watertight isosurface', 'error': str(error)}
    after = topology_report(repaired_mesh, epsilon, island_fraction)
    return repaired_mesh, {
        'changed': True, 'before': before, 'after': after, 'weldedVertices': welded,
        **totals, 'maxFilledLoop': longest_loop, 'repairPasses': passes, 'winding': winding,
        'faceLimit': FACE_LIMIT, 'reconstruction': reconstruction,
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


def _face_signed_areas(uv, faces):
    triangles = np.asarray(uv, dtype=np.float64)[np.asarray(faces, dtype=np.int64)]
    return 0.5 * (
        (triangles[:, 1, 0] - triangles[:, 0, 0]) * (triangles[:, 2, 1] - triangles[:, 0, 1])
        - (triangles[:, 1, 1] - triangles[:, 0, 1]) * (triangles[:, 2, 0] - triangles[:, 0, 0])
    )


def _uv_boundary_mask(faces):
    """Vertices on a chart border. Seam-split islands keep their own border."""
    edges, counts = _edge_table(np.asarray(faces, dtype=np.int64))
    mask = np.zeros(int(np.max(faces)) + 1 if len(faces) else 0, dtype=bool)
    for edge, count in zip(edges, counts):
        if int(count) == 1:
            mask[int(edge[0])] = True
            mask[int(edge[1])] = True
    if len(mask) == 0:
        return mask
    return mask


def _triangles_overlap_2d(left, right):
    def orient(a, b, c):
        return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])

    def crosses(a, b, c, d):
        return orient(a, b, c) * orient(a, b, d) < 0 and orient(c, d, a) * orient(c, d, b) < 0

    def inside(point, triangle):
        signs = [orient(triangle[i], triangle[(i + 1) % 3], point) for i in range(3)]
        return min(signs) > 1e-12 or max(signs) < -1e-12

    for index in range(3):
        if crosses(left[index], left[(index + 1) % 3], right[0], right[1]) or crosses(left[index], left[(index + 1) % 3], right[1], right[2]) or crosses(left[index], left[(index + 1) % 3], right[2], right[0]):
            return True
        if inside(left[index], right) or inside(right[index], left):
            return True
    return False


def _relax_uv(uv, faces, rounds=3, max_displacement=0.02):
    """Smooth interior UV only. Island borders stay put, and a bad step is undone.

    One to three Jacobi rounds blend each interior vertex toward its neighbors.
    The step cannot leave the displacement ball around the incoming UV. A move
    that flips a triangle against its original signed area, or that overlaps a
    triangle it does not touch, is reverted for that vertex.
    """
    uv = np.array(uv, dtype=np.float64, copy=True)
    original = uv.copy()
    faces = np.asarray(faces, dtype=np.int64)
    empty = {
        'rounds': 0, 'maxDisplacement': 0.0, 'maxDisplacementLimit': float(max_displacement),
        'boundaryDisplacement': 0.0, 'flippedReverts': 0, 'overlapReverts': 0,
        'edgeBefore': 0.0, 'edgeAfter': 0.0, 'minSignedArea': 0.0,
    }
    if len(faces) == 0 or len(uv) == 0:
        return uv, empty
    boundary = _uv_boundary_mask(faces)
    if len(boundary) < len(uv):
        boundary = np.pad(boundary, (0, len(uv) - len(boundary)))
    boundary = boundary[:len(uv)]
    interior = np.flatnonzero(~boundary)
    neighbors = [[] for _ in range(len(uv))]
    incident = [[] for _ in range(len(uv))]
    for face_index, face in enumerate(faces):
        for corner in range(3):
            start, end = int(face[corner]), int(face[(corner + 1) % 3])
            if end not in neighbors[start]:
                neighbors[start].append(end)
            if start not in neighbors[end]:
                neighbors[end].append(start)
            incident[int(face[corner])].append(face_index)
    original_areas = _face_signed_areas(original, faces)
    edge_before = _max_uv_edge(original, faces)
    flipped = 0
    overlapped = 0
    limit = float(max_displacement)
    used_rounds = min(3, max(1, int(rounds)))
    full_overlap = len(faces) <= 400
    for _round in range(used_rounds):
        proposed = uv.copy()
        for index in interior:
            ring = neighbors[int(index)]
            if len(ring) < 2:
                continue
            target = uv[ring].mean(axis=0)
            delta = target - uv[index]
            if float(np.linalg.norm(delta)) < 1e-8:
                continue
            step = uv[index] + 0.5 * delta
            offset = step - original[index]
            length = float(np.linalg.norm(offset))
            if length > limit:
                step = original[index] + offset * (limit / length)
            proposed[index] = step
        for index in interior:
            if np.allclose(proposed[index], uv[index], atol=1e-12):
                continue
            trial = uv[index].copy()
            uv[index] = proposed[index]
            areas = _face_signed_areas(uv, faces[incident[int(index)]])
            before = original_areas[incident[int(index)]]
            flipped_face = np.any((before > 1e-12) & (areas <= 1e-12)) or np.any((before < -1e-12) & (areas >= -1e-12))
            if flipped_face:
                uv[index] = trial
                flipped += 1
                continue
            if full_overlap and _moved_vertex_overlaps(int(index), uv, faces, incident):
                uv[index] = trial
                overlapped += 1
    uv[boundary] = original[boundary]
    offset = uv - original
    length = np.linalg.norm(offset, axis=1)
    too_far = length > limit
    if np.any(too_far):
        uv[too_far] = original[too_far] + offset[too_far] * ((limit * (1.0 - 1e-12)) / length[too_far])[:, None]
        uv[boundary] = original[boundary]
    displacement = np.linalg.norm(uv - original, axis=1)
    areas = _face_signed_areas(uv, faces)
    return uv, {
        'rounds': used_rounds,
        'maxDisplacement': float(displacement.max()) if len(displacement) else 0.0,
        'maxDisplacementLimit': limit,
        'boundaryDisplacement': float(displacement[boundary].max()) if np.any(boundary) else 0.0,
        'flippedReverts': int(flipped),
        'overlapReverts': int(overlapped),
        'edgeBefore': float(edge_before),
        'edgeAfter': float(_max_uv_edge(uv, faces)),
        'minSignedArea': float(areas.min()) if len(areas) else 0.0,
        'overlapCheck': 'incident triangles against non-adjacent faces' if full_overlap else 'flip and displacement clamp only',
    }


def _moved_vertex_overlaps(index, uv, faces, incident):
    mine = incident[index]
    mine_ids = set(mine)
    touched = {int(vertex) for face_index in mine for vertex in faces[face_index]}
    for face_index in mine:
        triangle = uv[faces[face_index]]
        low, high = triangle.min(axis=0), triangle.max(axis=0)
        for other, face in enumerate(faces):
            if other in mine_ids or any(int(vertex) in touched for vertex in face):
                continue
            other_triangle = uv[face]
            other_low, other_high = other_triangle.min(axis=0), other_triangle.max(axis=0)
            if other_low[0] > high[0] or other_high[0] < low[0] or other_low[1] > high[1] or other_high[1] < low[1]:
                continue
            if _triangles_overlap_2d(triangle, other_triangle):
                return True
    return False


def _merge_uv_relax(parts):
    if not parts:
        return None
    return {
        'rounds': max(part['rounds'] for part in parts),
        'maxDisplacement': max(part['maxDisplacement'] for part in parts),
        'maxDisplacementLimit': max(part['maxDisplacementLimit'] for part in parts),
        'boundaryDisplacement': max(part['boundaryDisplacement'] for part in parts),
        'flippedReverts': int(sum(part['flippedReverts'] for part in parts)),
        'overlapReverts': int(sum(part['overlapReverts'] for part in parts)),
        'edgeBefore': max(part['edgeBefore'] for part in parts),
        'edgeAfter': max(part['edgeAfter'] for part in parts),
        'minSignedArea': min(part['minSignedArea'] for part in parts),
    }


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
    parts_v, parts_f, parts_uv, parts_relax = [], [], [], []
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
        chart_uv, relax = _relax_uv(chart_uv, indexed)
        measured = max(measured, _max_uv_edge(chart_uv, indexed))
        parts_v.append(points)
        parts_f.append(indexed)
        parts_uv.append(chart_uv)
        parts_relax.append(relax)
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
        'uvRelax': _merge_uv_relax(parts_relax),
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
    uv, relax = _relax_uv(uv, faces)
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
        'uvRelax': relax,
    }


def derive_shared_lods(mesh, medium_ratio=0.30, low_ratio=0.12, distortion_limit=0.2):
    """Derive Medium and Low from a UV'd High mesh. All three share one material."""
    if _uv_array(mesh) is None:
        raise ValueError('Shared LOD requires an unwrapped high mesh')
    high_faces = len(mesh.faces)
    medium_target = max(4, int(round(high_faces * medium_ratio)))
    low_target = max(4, int(round(high_faces * low_ratio)))
    medium, medium_report = _reduce_preserving_uv(mesh, medium_target, distortion_limit)
    # Stay on the island path for Low. The small-mesh collapse resamples across
    # every source face once an edge exceeds the limit, which would pull a seam
    # vertex onto the other chart.
    if str(medium_report.get('uvTransfer', '')).startswith('per-UV-island') and len(medium.faces) > low_target:
        low, low_report = _reduce_large_uv_islands(medium, low_target, distortion_limit)
    else:
        low, low_report = _reduce_preserving_uv(medium, low_target, distortion_limit)
    if low_report['uvDistortion'] > distortion_limit or low_report['uvDistortionExceeded']:
        low_report = {**low_report, 'uvDistortionExceeded': True}
        if not low_report['resampled']:
            resampled = np.array(low.visual.uv, copy=True)
            checked = _resample_uv(np.asarray(low.vertices), np.asarray(low.faces), mesh)
            error = float(np.linalg.norm(resampled - checked, axis=1).max()) if len(checked) else 0.0
            locked, relax = _relax_uv(checked, np.asarray(low.faces))
            low.visual.uv = locked
            low_report = {**low_report, 'resampled': True, 'uvRelax': relax,
                          'uvDistortion': max(float(low_report['uvDistortion']), error)}
    return {
        'high': mesh, 'medium': medium, 'low': low,
        'sharedTextures': list(SHARED_TEXTURES),
        'reports': {'medium': medium_report, 'low': low_report},
        'uvRelax': {'medium': medium_report.get('uvRelax'), 'low': low_report.get('uvRelax')},
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
        'uvRelax': derived['uvRelax'],
        'optionalFbx': 'geometry-only FBX stays on the existing model.geometry-only.fbx delivery when a converter is available',
    }
