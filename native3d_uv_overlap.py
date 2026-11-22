"""Bounded positive-area UV conflict detection and deterministic face cover."""
import numpy as np
import trimesh


def _aabb_candidates(low, high):
    """Complete box pairs through a conservative, size-bucketed spatial index.

    A box lies in the L-infinity ball of its center and maximum half extent.
    Querying radius r_i + max(bucket radii) therefore cannot omit an overlapping
    box. The original inclusive AABB predicate removes the extra candidates.
    Only the broad phase changes; there is no pair/search cap or approximation.
    """
    if not len(low):
        return
    centers=low*.5+high*.5
    radii=np.max(high*.5-low*.5,axis=1)
    # Preserve the old behavior on nonfinite/extreme inputs rather than asking
    # a spatial tree to interpret them. Normalized atlas coordinates use index.
    if (not np.isfinite(centers).all() or not np.isfinite(radii).all() or
            np.max(np.abs(centers))>1e100 or np.max(radii)>1e100):
        for i in range(len(low)):
            yield i,np.flatnonzero(np.all(low[:i]<=high[i],axis=1)&np.all(high[:i]>=low[i],axis=1))
        return
    from scipy.spatial import cKDTree
    exponents=np.frexp(radii)[1]
    for exponent in np.unique(exponents):
        ids=np.flatnonzero(exponents==exponent)
        tree=cKDTree(centers[ids])
        maximum_radius=float(radii[ids].max())
        bucket_scale=float(np.max(np.abs(centers[ids])))
        for start in range(0,len(low),1024):
            stop=min(start+1024,len(low))
            radius=radii[start:stop]+maximum_radius
            # Round conservatively outward. This can only add broad-phase
            # candidates; the original exact box/polygon predicates still rule.
            margin=8*np.finfo(float).eps*(np.max(np.abs(centers[start:stop]),axis=1)+bucket_scale+radius)
            radius=np.nextafter(radius+margin,np.inf)
            neighbors=tree.query_ball_point(centers[start:stop],radius,p=np.inf,return_sorted=False)
            for offset,local in enumerate(neighbors):
                i=start+offset
                candidates=ids[local]
                candidates=candidates[candidates<i]
                candidates=candidates[np.all(low[candidates]<=high[i],axis=1)&
                                      np.all(high[candidates]>=low[i],axis=1)]
                if len(candidates):
                    yield i,np.sort(candidates)


def overlap_pairs(mesh, uv):
    tri = np.asarray(uv, dtype=np.float64)[mesh.faces].copy()
    cross = lambda a, b: a[..., 0]*b[..., 1]-a[..., 1]*b[..., 0]
    signed = cross(tri[:, 1]-tri[:, 0], tri[:, 2]-tri[:, 0])
    tri[signed < 0] = tri[signed < 0, ::-1]
    low, high = tri.min(1), tri.max(1)
    owner = np.zeros(len(tri), dtype=int)
    for label, faces in enumerate(trimesh.graph.connected_components(mesh.face_adjacency, nodes=np.arange(len(tri)), min_len=1)):
        owner[faces] = label
    pairs = []
    for i,candidates in _aabb_candidates(low,high):
        for j in candidates:
            poly = list(tri[i])
            for k in range(3):
                start = tri[j, k]; edge = tri[j, (k+1) % 3]-start; output = []
                if not poly:
                    break
                previous = poly[-1]; dp = float(cross(edge, previous-start))
                for point in poly:
                    dc = float(cross(edge, point-start))
                    if (dc >= 0) != (dp >= 0):
                        output.append(previous+(point-previous)*(dp/(dp-dc)))
                    if dc >= 0:
                        output.append(point)
                    previous, dp = point, dc
                poly = output
            if len(poly) < 3:
                continue
            poly = np.asarray(poly)
            area = float(abs(np.sum(cross(poly, np.roll(poly, -1, axis=0))))*.5)
            if area > 1e-12:
                if owner[i] != owner[j]:
                    raise ValueError('Initial xatlas has inter-chart overlap; bounded intra-chart repair refused')
                pairs.append((int(i), int(j)))
    # Buckets change enumeration order, not the exact pair set or public order.
    pairs.sort()
    return pairs


def conflict_cover(pairs):
    """Greedy maximum uncovered degree; deterministic, not a minimum-cover claim."""
    remaining = {tuple(sorted(map(int, pair))) for pair in pairs}
    selected = []
    while remaining:
        degree = {}
        for pair in remaining:
            for face in pair:
                degree[face] = degree.get(face, 0)+1
        face = min(degree, key=lambda key: (-degree[key], key))
        selected.append(face)
        remaining = {pair for pair in remaining if face not in pair}
    return selected
