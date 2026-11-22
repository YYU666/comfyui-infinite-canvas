"""Bounded, complete-or-blocked CPU geometry audit for source-derived LOD.

Topology is indexed; triangle spheres enumerate conservative candidates in
bounded chunks. No exhausted search is reported as intersection-free.
"""
import time
import hashlib
import numpy as np
from native3d_geometry import validate_arrays, mesh_hash, triangle_intersection_3d


class AuditBudgetExceeded(ValueError):
    pass


def _cut_interval(tri, distances, direction, anchor, epsilon):
    projection = np.einsum('nki,ni->nk', tri-anchor[:, None, :], direction)
    minimum = np.min(np.where(np.abs(distances) <= epsilon, projection, np.inf), axis=1)
    maximum = np.max(np.where(np.abs(distances) <= epsilon, projection, -np.inf), axis=1)
    for i, j in ((0, 1), (1, 2), (2, 0)):
        crossing = distances[:, i]*distances[:, j] < 0
        fraction = np.divide(distances[:, i], distances[:, i]-distances[:, j],
                             out=np.zeros(len(tri)), where=crossing)
        value = projection[:, i]+fraction*(projection[:, j]-projection[:, i])
        minimum = np.minimum(minimum, np.where(crossing, value, np.inf))
        maximum = np.maximum(maximum, np.where(crossing, value, -np.inf))
    return minimum, maximum


def _intersection_flags(triangles, faces, unit_normals, first, second, epsilon, check_budget,
                        contact_ids=None):
    """Vectorized plane segments, with the existing float64 coplanar clip.

    This has the same segment/positive-area semantics as the small exact audit:
    isolated point contact is ignored; a shared topological edge is permitted.
    """
    a, b = triangles[first], triangles[second]
    na, nb = unit_normals[first], unit_normals[second]
    da = np.einsum('nki,ni->nk', b-a[:, :1], na)
    db = np.einsum('nki,ni->nk', a-b[:, :1], nb)
    separated = ((da.min(1) > epsilon) | (da.max(1) < -epsilon) |
                 (db.min(1) > epsilon) | (db.max(1) < -epsilon))
    direction = np.cross(na, nb)
    lengths = np.linalg.norm(direction, axis=1)
    parallel = lengths <= 1e-8
    common = np.sum(np.any(faces[first, :, None] == faces[second, None, :], axis=2), axis=1)
    contact = np.zeros(len(first), dtype=bool)
    if contact_ids is not None:
        contact = np.any((contact_ids[first, :, None] == contact_ids[second, None, :]) &
                         (contact_ids[first, :, None] >= 0), axis=(1, 2))
    hit = np.zeros(len(first), dtype=bool)
    # A narrowly nominated source contact edge is present in BOTH triangles
    # with exact endpoint coordinates. Nonparallel planes meet only along that
    # boundary edge. This cannot exempt an interior crossing or shared point.
    ids = np.flatnonzero(~separated & ~parallel & (common < 2) & ~contact)
    if len(ids):
        d = direction[ids]/lengths[ids, None]
        amin, amax = _cut_interval(a[ids], db[ids], d, a[ids, 0], epsilon)
        bmin, bmax = _cut_interval(b[ids], da[ids], d, a[ids, 0], epsilon)
        hit[ids] = np.minimum(amax, bmax)-np.maximum(amin, bmin) > epsilon
    ids = np.flatnonzero(~separated & parallel & (np.max(np.abs(da), axis=1) <= epsilon))
    # Correctly oriented adjacent coplanar triangles occupy opposite sides of
    # their common edge. Topology/winding was checked before this search.
    ids = ids[~((common[ids] >= 2) & (np.sum(na[ids]*nb[ids], axis=1) > 0))]
    for offset, index in enumerate(ids):
        if offset % 256 == 0:
            check_budget()
        # A cheap 2D separating-axis test avoids clipping an entire planar
        # triangulation; only strict separation is pruned here.
        drop = int(np.argmax(np.abs(na[index])))
        keep = [axis for axis in range(3) if axis != drop]
        aa, bb = a[index][:, keep], b[index][:, keep]
        edges = np.concatenate((np.roll(aa, -1, axis=0)-aa,
                                np.roll(bb, -1, axis=0)-bb))
        axes = np.column_stack((-edges[:, 1], edges[:, 0]))
        pa, pb = aa@axes.T, bb@axes.T
        if np.any((pa.max(0) < pb.min(0)) | (pb.max(0) < pa.min(0))):
            continue
        intersection = triangle_intersection_3d(a[index], b[index], epsilon)
        hit[index] = bool(intersection and not (intersection[0] == 'segment' and
                                                (common[index] >= 2 or contact[index])))
    return hit


def _contact_edge_ids(vertices, faces, edges):
    """Match only entire exact-coordinate source-ledger edges, never proximity."""
    if edges is None or len(edges) == 0:
        return None, []
    edges = np.asarray(edges, dtype=float)
    if edges.ndim != 3 or edges.shape[1:] != (2,3) or len(edges) > 256 or not np.isfinite(edges).all():
        raise ValueError('At most256 finite source contact edges required')
    if np.any(np.all(edges[:,0] == edges[:,1],axis=1)):
        raise ValueError('Source contact edge endpoints must be distinct')
    points, inverse = np.unique(edges.reshape(-1,3),axis=0,return_inverse=True)
    point_ids = np.full(len(vertices), -1, np.int32)
    for index, point in enumerate(points):
        point_ids[np.all(vertices == point,axis=1)] = index
    edge_ids = np.sort(inverse.reshape(-1,2),axis=1)
    edge_keys = edge_ids[:,0]*len(points)+edge_ids[:,1]
    sort = np.argsort(edge_keys)
    edge_keys = edge_keys[sort]
    ids = np.full((len(faces),3), -1, np.int32)
    codes = point_ids[faces]
    for i,j in ((0,1),(1,2),(2,0)):
        a,b = codes[:,i], codes[:,j]
        keys = np.minimum(a,b)*len(points)+np.maximum(a,b)
        where = np.searchsorted(edge_keys,keys)
        safe = np.minimum(where,len(edge_keys)-1)
        valid = (a>=0)&(b>=0)&(where<len(edge_keys))&(edge_keys[safe]==keys)
        ids[valid,i] = sort[safe[valid]]
    return ids, edges.tolist()


def audit_geometry(vertices, faces, *, max_seconds=120., max_pairs=20_000_000,
                   max_sphere_pairs=80_000_000, chunk_size=1024, allow_boundaries=False,
                   permitted_contact_edges=None, collect_all_intersections=False,
                   max_intersections=4096):
    """Return accepted, blocked (known defect), or blocked/unknown (budget).

    max_pairs limits AABB candidates; max_sphere_pairs also bounds the broader
    index enumeration before allocating lists. A report never implies that a
    partial intersection search was complete.
    """
    from scipy.spatial import cKDTree
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components
    start = time.monotonic()
    if not np.isfinite(max_seconds) or max_seconds <= 0 or max_pairs < 1 or max_sphere_pairs < 1:
        raise ValueError('Positive finite audit resource budgets required')
    if not 1 <= int(chunk_size) <= 4096:
        raise ValueError('Audit chunk must be within1..4096')
    if type(max_intersections) is not int or not 1<=max_intersections<=4096:
        raise ValueError('Intersection census limit must be within1..4096')
    v, f = validate_arrays(vertices, faces)
    report = {'status': 'blocked', 'mesh_hash': mesh_hash(v, f), 'vertices': len(v),
              'triangles': len(f), 'finite': True, 'bounds': [v.min(0).tolist(), v.max(0).tolist()],
              'intersectionStatus': 'not_checked', 'intersection_pairs': [],
              'intersection_pairs_count': None, 'intersectionComplete': False,
              'candidatePairs': 0, 'spherePairsEnumerated': 0,
              'maxCandidatePairs': int(max_pairs), 'maxSpherePairs': int(max_sphere_pairs),
              'maxSpherePairsPerChunk': 1_000_000,
              'maxSeconds': float(max_seconds),
              'intersection_method': 'size-bucketed conservative triangle-sphere index / float64 plane segments and coplanar clipping; point contacts ignored',
              'allowBoundaries': bool(allow_boundaries)}

    def budget():
        if time.monotonic()-start > max_seconds:
            raise AuditBudgetExceeded('audit_time_budget_exhausted')

    try:
        if len(f) > 3_000_000:
            raise AuditBudgetExceeded('audit_face_budget_exhausted')
        tri = v[f]
        cross = np.cross(tri[:, 1]-tri[:, 0], tri[:, 2]-tri[:, 0])
        length = np.linalg.norm(cross, axis=1)
        epsilon = max(float(np.linalg.norm(np.ptp(v, axis=0)))*1e-8, 1e-12)
        report['epsilon'] = epsilon
        normals = cross/np.maximum(length[:, None], 1e-300)
        degenerate = np.flatnonzero(length*.5 <= epsilon**2)
        report['degenerate_faces_count'] = int(len(degenerate))
        report['degenerate_faces'] = degenerate[:64].tolist()
        report['duplicate_faces'] = int(len(f)-len(np.unique(np.sort(f, axis=1), axis=0)))
        report['area'] = float(length.sum()*.5)
        report['signedVolume'] = float(np.einsum('ni,ni->n', tri[:, 0], cross).sum()/6)
        budget()
        # Index all oriented edge occurrences without per-face Python objects.
        directed = np.stack((f, np.roll(f, -1, axis=1)), axis=2).reshape(-1, 2)
        undirected = np.sort(directed, axis=1)
        order = np.lexsort((undirected[:, 1], undirected[:, 0]))
        sorted_edges = undirected[order]
        begin = np.r_[0, np.flatnonzero(np.any(sorted_edges[1:] != sorted_edges[:-1], axis=1))+1]
        count = np.diff(np.r_[begin, len(order)])
        report['boundary_edges'] = int(np.count_nonzero(count == 1))
        boundary_coordinates = v[sorted_edges[begin[count == 1]]].astype('<f4').astype('<f8')
        if len(boundary_coordinates):
            x, y = boundary_coordinates[:, 0], boundary_coordinates[:, 1]
            swap = ((x[:,0] > y[:,0]) | ((x[:,0] == y[:,0]) & (x[:,1] > y[:,1])) |
                    ((x[:,0] == y[:,0]) & (x[:,1] == y[:,1]) & (x[:,2] > y[:,2])))
            boundary_coordinates[swap] = boundary_coordinates[swap, ::-1]
            flat_boundary = boundary_coordinates.reshape(-1,6)
            sorted_boundary = np.lexsort(tuple(flat_boundary[:, axis] for axis in range(5,-1,-1)))
            boundary_coordinates = boundary_coordinates[sorted_boundary]
        report['boundaryPositionHash'] = hashlib.sha256(boundary_coordinates.tobytes()).hexdigest()
        bad_edges = begin[count > 2]
        report['nonmanifold_edges_count'] = int(len(bad_edges))
        report['nonmanifold_edges'] = sorted_edges[bad_edges[:64]].tolist()
        paired = begin[count == 2]
        left, right = order[paired], order[paired+1]
        same_direction = np.all(directed[left] == directed[right], axis=1)
        report['inconsistent_winding_edges'] = int(same_direction.sum())
        # Corner connectivity precisely detects bow-tie vertices. Paired edges
        # connect the two corner occurrences of each of their two endpoints.
        def corner_end(edge):
            return (edge//3)*3+(edge % 3+1) % 3
        left_end, right_end = corner_end(left), corner_end(right)
        match = directed[left, 0] == directed[right, 0]
        row = np.concatenate((left, left_end))
        col = np.concatenate((np.where(match, right, right_end),
                              np.where(match, right_end, right)))
        graph = coo_matrix((np.ones(len(row), np.uint8), (row, col)), shape=(3*len(f),)*2).tocsr()
        _, labels = connected_components(graph, directed=False)
        minimum = np.full(len(v), 3*len(f), np.int64)
        maximum = np.full(len(v), -1, np.int64)
        np.minimum.at(minimum, f.ravel(), labels)
        np.maximum.at(maximum, f.ravel(), labels)
        bad_vertices = np.flatnonzero((maximum >= 0) & (minimum != maximum))
        report['nonmanifold_vertices_count'] = int(len(bad_vertices))
        report['nonmanifold_vertices'] = bad_vertices[:64].tolist()
        face_graph = coo_matrix((np.ones(len(left), np.uint8), (left//3, right//3)),
                                shape=(len(f),)*2).tocsr()
        report['componentCount'] = int(connected_components(face_graph, directed=False, return_labels=False))
        report['watertight'] = not report['boundary_edges'] and not report['nonmanifold_edges_count']
        budget()
        faults = [key for key in ('degenerate_faces_count', 'duplicate_faces',
                  'nonmanifold_edges_count', 'nonmanifold_vertices_count', 'inconsistent_winding_edges') if report[key]]
        if report['boundary_edges'] and not allow_boundaries:
            faults.append('boundary_intent_not_reviewed')
        if faults:
            report['blocker'] = 'geometry_topology: '+', '.join(faults)
            return report
        # Free sparse topology buffers before spatial indexing a million faces.
        del graph, face_graph, labels, directed, undirected, sorted_edges, order
        low, high = tri.min(1), tri.max(1)
        contact_ids, contact_edges = _contact_edge_ids(v, f, permitted_contact_edges)
        report['permittedSourceContactEdges'] = contact_edges
        report['contactPolicy'] = 'Only segment contact along a whole exact source-ledger edge in both triangles; positive-area overlap and other crossings still forbidden'
        centers = tri.mean(axis=1)
        radii = np.linalg.norm(tri-centers[:, None], axis=2).max(1)
        # Radius buckets prevent one large triangle from making all small-face
        # queries use that large radius. The sphere bound is conservative.
        exponent = np.frexp(np.maximum(radii, epsilon))[1]
        buckets = np.unique(exponent)
        if len(buckets) > 64:
            raise AuditBudgetExceeded('audit_radius_bucket_budget_exhausted')
        report['radiusBuckets'] = int(len(buckets))
        for bucket in buckets:
            ids = np.flatnonzero(exponent == bucket)
            tree = cKDTree(centers[ids])
            maximum_radius = float(radii[ids].max())
            for begin in range(0, len(f), int(chunk_size)):
                budget()
                query = np.arange(begin, min(begin+int(chunk_size), len(f)))
                radius = radii[query]+maximum_radius+epsilon*2
                sizes = tree.query_ball_point(centers[query], radius, return_length=True)
                potential = int(np.sum(sizes))
                if potential > report['maxSpherePairsPerChunk']:
                    raise AuditBudgetExceeded('audit_spatial_chunk_budget_exhausted')
                if report['spherePairsEnumerated']+potential > max_sphere_pairs:
                    raise AuditBudgetExceeded('audit_spatial_candidate_budget_exhausted')
                report['spherePairsEnumerated'] += potential
                neighbors = tree.query_ball_point(centers[query], radius)
                if not potential:
                    continue
                a = np.repeat(query, sizes)
                b = ids[np.concatenate(neighbors).astype(np.int64)]
                keep = (b > a) & np.all(low[a] <= high[b]+epsilon, axis=1) & np.all(high[a] >= low[b]-epsilon, axis=1)
                a, b = a[keep], b[keep]
                if report['candidatePairs']+len(a) > max_pairs:
                    raise AuditBudgetExceeded('audit_triangle_pair_budget_exhausted')
                report['candidatePairs'] += len(a)
                # Constrain vectorized narrow-phase temporary arrays even if
                # one spatial query has many legitimate neighboring triangles.
                for offset in range(0, len(a), 8192):
                    budget()
                    aa, bb = a[offset:offset+8192], b[offset:offset+8192]
                    flags = _intersection_flags(tri, f, normals, aa, bb, epsilon, budget, contact_ids)
                    if flags.any():
                        pairs = np.column_stack((aa[flags], bb[flags]))
                        if collect_all_intersections:
                            remaining=max_intersections-len(report['intersection_pairs'])
                            report['intersection_pairs'].extend(pairs[:remaining].tolist())
                            report['intersection_pairs_count']=len(report['intersection_pairs'])
                            report['blocker']='geometry_intersection'
                            if len(pairs)>remaining:
                                report['intersectionPairsTruncated']=True
                                raise AuditBudgetExceeded('audit_intersection_census_budget_exhausted')
                            continue
                        report['intersection_pairs'] = pairs[:64].tolist()
                        report['intersection_pairs_count'] = int(len(pairs))
                        report['intersectionStatus'] = 'defect_found_search_stopped'
                        report['blocker'] = 'geometry_intersection'
                        return report
        count=len(report['intersection_pairs'])
        report.update(status='blocked' if count else 'accepted', intersectionStatus='complete',
                      intersectionComplete=True, intersection_pairs_count=count)
    except AuditBudgetExceeded as error:
        report.update(status='blocked', blocker=str(error), intersectionStatus='unknown_budget_exhausted')
    finally:
        report['wallSeconds'] = time.monotonic()-start
    return report


def require_audited(report):
    if report.get('status') != 'accepted' or not report.get('intersectionComplete'):
        raise ValueError('Source LOD geometry blocked: '+report.get('blocker', 'incomplete audit'))
