"""Preserve four annular surface regions with one axial opening cut each."""
import hashlib
import json

import numpy as np
import trimesh
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import dijkstra
from native3d_uv_slim import _boundary, _fans


def build_annular_plan(mesh, encoded, source_sha256):
    plan = json.loads(encoded)
    if not isinstance(plan, dict) or set(plan) != {'sourceSha256', 'axis', 'rimCuts', 'slitDirection'} or plan['sourceSha256'] != source_sha256:
        raise ValueError('Annular seam source mismatch or invalid plan')
    axis = np.asarray(plan['axis'], dtype=float)
    rim_cuts = np.asarray(plan['rimCuts'], dtype=float)
    slit = np.asarray(plan['slitDirection'], dtype=float)
    if (axis.shape != (3,) or slit.shape != (3,) or rim_cuts.shape != (2,)
            or not np.isfinite(np.r_[axis, slit, rim_cuts]).all() or rim_cuts[0] >= rim_cuts[1]
            or not np.isclose(np.linalg.norm(axis), 1)):
        raise ValueError('Annular seam plan requires a unit axis and two ordered axial cut levels')
    slit = slit - np.dot(slit, axis) * axis
    if np.linalg.norm(slit) < 1e-6:
        raise ValueError('Annular seam opening direction must have a radial component')
    slit /= np.linalg.norm(slit)
    if not mesh.is_watertight or not mesh.is_winding_consistent or mesh.euler_number != 0:
        raise ValueError('Annular seam plan requires a closed, consistently wound annular shell')

    adjacency = mesh.face_adjacency
    bands = np.digitize(mesh.triangles_center @ axis, rim_cuts)
    band_groups = []
    for band, expected in enumerate((1, 2, 1)):
        parts = trimesh.graph.connected_components(
            adjacency[(bands[adjacency] == band).all(axis=1)],
            nodes=np.flatnonzero(bands == band), min_len=1)
        if len(parts) != expected:
            raise ValueError(f'Expected {expected} connected surfaces in annular band {band}, found {len(parts)}')
        band_groups.append([np.sort(part) for part in parts])
    # Ordered radial surface normals distinguish the outward wall from the inside.
    def radial_alignment(ids):
        centers = mesh.triangles_center[ids]
        radial = centers - np.outer(centers @ axis, axis)
        return np.average(np.einsum('ij,ij->i', radial, mesh.face_normals[ids]), weights=mesh.area_faces[ids])
    walls = sorted(band_groups[1], key=radial_alignment, reverse=True)
    if radial_alignment(walls[0]) <= 0 or radial_alignment(walls[1]) >= 0:
        raise ValueError('Could not distinguish annular interior and exterior')
    groups = [*walls, band_groups[2][0], band_groups[0][0]]
    names = ('outer_wall', 'inner_wall', 'upper_rim', 'lower_rim')
    owners = np.empty(len(mesh.faces), dtype=int)
    for index, ids in enumerate(groups):
        owners[ids] = index
    reasons = {}
    surface_stats = []
    for pair, edge in zip(adjacency, mesh.face_adjacency_edges):
        a, b = sorted(owners[pair])
        if a != b:
            reasons[tuple(sorted(map(int, edge)))] = names[b] + '_boundary'

    for name, ids in zip(names, groups):
        source, inverse = np.unique(mesh.faces[ids], return_inverse=True)
        f = inverse.reshape(-1, 3)
        v = mesh.vertices[source]
        edges, counts, loops = _boundary(f)
        if len(loops) != 2 or len(v) - len(edges) + len(f) != 0 or len(_fans(v, f, source)[0]) != len(v):
            raise ValueError(f'{name} does not form a single annulus')
        length = np.linalg.norm(v[edges[:, 1]] - v[edges[:, 0]], axis=1)
        midpoint = v[edges].mean(axis=1)
        radial = midpoint - np.outer(midpoint @ axis, axis)
        theta = np.arctan2(radial @ np.cross(axis, slit), radial @ slit)
        cost = length * (1 + 12 * np.square(theta))
        start, end = loops
        a, b = edges.T
        graph = coo_matrix((np.r_[cost, cost], (np.r_[a, b], np.r_[b, a])), shape=(len(v), len(v))).tocsr()
        dist, pred, _ = dijkstra(graph, directed=False, indices=start, min_only=True, return_predecessors=True)
        current = int(end[np.argmin(dist[end])])
        start_set = set(map(int, start))
        end_set = set(map(int, end))
        opening = []
        while current not in start_set:
            previous = int(pred[current])
            if previous < 0 or previous in end_set or len(opening) >= len(v):
                raise ValueError(f'{name} has no simple radial opening cut')
            opening.append(tuple(sorted((int(source[current]), int(source[previous])))))
            current = previous
        reasons.update(dict.fromkeys(opening, name + '_opening'))
        surface_stats.append({'surface': name, 'faces': len(ids), 'areaFraction': float(mesh.area_faces[ids].sum() / mesh.area),
                              'boundaryLoops': [len(loop) for loop in loops], 'openingEdges': len(opening)})

    receipt = {**plan, 'surfaces': surface_stats, 'seamEdges': len(reasons),
               'planSha256': hashlib.sha256(encoded.encode('utf-8')).hexdigest()}
    return {'reasons': reasons, 'groups': groups, 'planSha256': receipt['planSha256'],
            'parameterizationBackend': 'annular_main_seams'}, receipt
