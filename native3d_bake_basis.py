"""MikkTSpace glTF frames, matching Three's USE_TANGENT interpolation.

Only attribute/index duplication is permitted: approved triangle positions and UVs
are unchanged. Corner frames use the installed reference-derived MikkTSpace port.
"""
import json
from pathlib import Path
import shutil
import subprocess

import numpy as np


def unit(values):
    values = np.asarray(values, dtype=float)
    lengths = np.linalg.norm(values, axis=-1, keepdims=True)
    if np.any(lengths < 1e-12) or not np.isfinite(values).all():
        raise ValueError('Degenerate or nonfinite bake normal/tangent frame')
    return values / lengths


def _project_normal_cone(matrix, original, margin=.05):
    from scipy.optimize import minimize, LinearConstraint
    solved=minimize(lambda x:.5*np.sum((x-original)**2),original,jac=lambda x:x-original,
                    constraints=[LinearConstraint(matrix,np.full(len(matrix),margin),np.full(len(matrix),np.inf)),
                                 {'type':'ineq','fun':lambda x:1.-np.dot(x,x),'jac':lambda x:-2*x}],
                    method='SLSQP',options={'ftol':1e-12,'maxiter':100})
    # SLSQP may report a line-search failure at a valid constrained solution.
    # Acceptance is based on the actual unit-vector hemisphere proof.
    if np.isfinite(solved.x).all() and np.linalg.norm(solved.x)>=1e-8:
        repaired=unit(solved.x)
        if np.min(matrix@repaired)>=margin-1e-6:return repaired
    # Independent convex minimum-norm feasibility pass avoids introducing a
    # seam merely because the original-normal starting point stalled.
    feasible=minimize(lambda x:.5*np.dot(x,x),np.zeros(3),jac=lambda x:x,
                      constraints=[LinearConstraint(matrix,np.full(len(matrix),margin),np.full(len(matrix),np.inf))],
                      method='SLSQP',options={'ftol':1e-12,'maxiter':150})
    if np.isfinite(feasible.x).all() and np.linalg.norm(feasible.x)>=1e-8:
        repaired=unit(feasible.x)
        if np.min(matrix@repaired)>=margin-1e-6:return repaired
    return None


def repair_source_normal_cones(vertices, faces, normals, *, split_infeasible=False):
    """Keep valid source normals; minimally project invalid smooth groups.

    The homogeneous face halfspaces describe a geometry-derived normal cone.
    UV duplicates with the same source normal are one group, so the repair does
    not create a shading seam when one cone exists. Infeasible fans are
    rejected by default; the bake builder explicitly requests local attribute
    sector splitting and records the resulting new normal seams.
    """
    vertices=np.asarray(vertices,dtype=float);faces=np.asarray(faces,dtype=np.int64)
    source=unit(normals);result=source.copy();triangles=vertices[faces]
    corner_normals=source[faces].copy() if split_infeasible else None
    face_normals=unit(np.cross(triangles[:,1]-triangles[:,0],triangles[:,2]-triangles[:,0]))
    dots=np.einsum('fci,fi->fc',source[faces],face_normals)
    margin=.05
    invalid=np.argwhere(dots<margin)
    report={'method':'preserve valid source normals; constrained normal-cone projection for invalid groups; minimum-norm feasibility fallback when projection stalls',
            'minimumFaceDotMargin':margin,
            'invalidCornersBefore':int(np.count_nonzero(dots<=0)),'invalidFacesBefore':int(np.count_nonzero((dots<=0).any(axis=1))),
            'unstableCornersBefore':int(len(invalid)),
            'changedGroups':0,'changedVertices':0,'maxChangeDegrees':0.,'changedSourceVertexIds':[],
            'groups':[],'splitGroups':[],'newNormalSeams':False,
            'minimumIncidentFaceDotBefore':float(dots.min()),'minimumIncidentFaceDotAfter':float(dots.min()),'invalidCornersAfter':0}
    if not len(invalid):
        return result,report
    keys=[tuple(np.r_[p,n]) for p,n in zip(vertices,source)]
    affected={keys[faces[fi,ci]] for fi,ci in invalid}
    group_vertices={key:[] for key in affected};group_faces={key:set() for key in affected}
    for vi,key in enumerate(keys):
        if key in affected:group_vertices[key].append(vi)
    for fi,face in enumerate(faces):
        for vi in face:
            if keys[vi] in affected:group_faces[keys[vi]].add(fi)
    for key in sorted(affected):
        ids=group_vertices[key];matrix=face_normals[sorted(group_faces[key])];original=source[ids[0]]
        repaired=_project_normal_cone(matrix,original,margin)
        if repaired is None:
            if not split_infeasible:
                raise ValueError('Source shading-normal fan has no stable common face hemisphere; explicit mesh normal repair required')
            # Partition only this unrepresentable normal fan into locally
            # connected feasible smooth sectors. Positions, winding, UV and
            # faces remain exact; the resulting normal seam is explicit.
            remaining=set(group_faces[key]);sectors=[]
            position=vertices[ids[0]]
            neighbors={fi:set() for fi in remaining};edge_faces={}
            for fi in remaining:
                for vi in faces[fi]:
                    if not np.array_equal(vertices[vi],position):
                        edge_faces.setdefault(tuple(vertices[vi]),[]).append(fi)
            for shared in edge_faces.values():
                for fi in shared:neighbors[fi].update(set(shared)-{fi})
            while remaining:
                seed=min(remaining);remaining.remove(seed);sector=[seed]
                sector_normal=_project_normal_cone(face_normals[sector],original,margin)
                if sector_normal is None:raise ValueError('Single-face normal cone unexpectedly infeasible')
                while True:
                    frontier=sorted(set().union(*(neighbors[fi] for fi in sector)) & remaining)
                    choices=[]
                    for fi in frontier:
                        normal=_project_normal_cone(face_normals[sector+[fi]],original,margin)
                        if normal is not None:choices.append((float(np.dot(normal-original,normal-original)),fi,normal))
                    if not choices:break
                    _,fi,sector_normal=min(choices,key=lambda item:(item[0],item[1]));sector.append(fi);remaining.remove(fi)
                for fi in sector:
                    for ci,vi in enumerate(faces[fi]):
                        if keys[vi]==key:corner_normals[fi,ci]=sector_normal
                sectors.append({'faceIds':sorted(sector),'normal':sector_normal.tolist(),
                                'minimumFaceDotAfter':float(np.min(face_normals[sector]@sector_normal))})
            report['splitGroups'].append({'sourceVertexIds':ids,'sourceFaceIds':sorted(group_faces[key]),
                                          'sectors':sectors,'reason':'no verified common normal with required0.05 face margin'})
            report['newNormalSeams']=True
            report['splitPolicy']='only failed common cones: connected feasible normal sectors; explicit local shading seams, geometry/UV unchanged'
            report['changedGroups']+=1;report['changedVertices']+=len(ids);report['changedSourceVertexIds'].extend(ids)
            report['maxChangeDegrees']=max(report['maxChangeDegrees'],max(float(np.degrees(np.arccos(np.clip(original@np.asarray(row['normal']),-1,1)))) for row in sectors))
            continue
        if split_infeasible:
            for fi in group_faces[key]:
                for ci,vi in enumerate(faces[fi]):
                    if keys[vi]==key:corner_normals[fi,ci]=repaired
        result[ids]=repaired;report['changedGroups']+=1;report['changedVertices']+=len(ids)
        report['changedSourceVertexIds'].extend(ids)
        change=float(np.degrees(np.arccos(np.clip(original@repaired,-1,1))))
        report['maxChangeDegrees']=max(report['maxChangeDegrees'],change)
        report['groups'].append({'sourceVertexIds':ids,'changeDegrees':change,
                                 'minimumFaceDotBefore':float(np.min(matrix@original)),
                                 'minimumFaceDotAfter':float(np.min(matrix@repaired))})
    after=np.einsum('fci,fi->fc',corner_normals if split_infeasible else result[faces],face_normals)
    if np.any(after<margin-1e-6):
        raise ValueError('Source shading-normal cone repair left invalid corners')
    report['changedSourceVertexIds'].sort();report['minimumIncidentFaceDotAfter']=float(after.min())
    report['invalidCornersAfter']=int(np.count_nonzero(after<=1e-6))
    if split_infeasible:report['_cornerNormals']=corner_normals
    return result,report


def build_bake_basis(vertices, faces, uv, normals):
    vertices = np.asarray(vertices, dtype=float)
    faces = np.asarray(faces, dtype=np.int64)
    uv = np.asarray(uv, dtype=float)
    original_vertices,original_faces,original_uv=vertices,faces,uv
    normals,normal_repair = repair_source_normal_cones(vertices, faces, normals,split_infeasible=True)
    corner_normals=normal_repair.pop('_cornerNormals',None)
    base_sources=np.arange(len(vertices),dtype=np.int64)
    if corner_normals is not None and normal_repair['newNormalSeams']:
        sources=list(range(len(vertices)));expanded_normals=list(normals);output_faces=faces.copy();assigned={};claimed=set()
        for fi,face in enumerate(faces):
            for ci,vi in enumerate(face):
                normal=corner_normals[fi,ci];key=(int(vi),*map(float,normal))
                if key not in assigned:
                    if int(vi) not in claimed:
                        assigned[key]=int(vi);expanded_normals[vi]=normal;claimed.add(int(vi))
                    else:
                        assigned[key]=len(sources);sources.append(int(vi));expanded_normals.append(normal)
                output_faces[fi,ci]=assigned[key]
        base_sources=np.asarray(sources,dtype=np.int64);vertices=vertices[base_sources];uv=uv[base_sources]
        faces=output_faces;normals=np.asarray(expanded_normals)
    normal_repair['normalSplitAdditionalVertices']=len(base_sources)-len(original_vertices)
    xyz = vertices[faces]
    # Trimesh exports glTF V=1-localV. Include that flip exactly once.
    exported_uv = uv.copy(); exported_uv[:, 1] = 1 - exported_uv[:, 1]
    delta = exported_uv[faces][:, 1:] - exported_uv[faces][:, :1]
    determinant = np.linalg.det(delta)
    if np.any(np.abs(determinant) < 1e-12):
        raise ValueError('Degenerate UV triangle tangent basis')
    node = shutil.which('node')
    if not node:
        raise RuntimeError('Native MikkTSpace requires Node.js (installation prerequisite); node executable not found')
    request = {'positions': xyz.astype(np.float32).reshape(-1).tolist(),
               'normals': normals[faces].astype(np.float32).reshape(-1).tolist(),
               'uv': exported_uv[faces].astype(np.float32).reshape(-1).tolist()}
    worker = Path(__file__).resolve().parent / 'scripts' / 'native3d_mikktspace.mjs'
    try:
        completed = subprocess.run([node, str(worker)], input=json.dumps(request, allow_nan=False),
                                   text=True, encoding='utf-8', capture_output=True, timeout=120,
                                   check=False, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    except (OSError, subprocess.TimeoutExpired) as error:
        raise RuntimeError(f'Native MikkTSpace worker could not run: {error}') from error
    if completed.returncode:
        raise RuntimeError(f'Native MikkTSpace worker failed: {completed.stderr.strip()[:2000]}')
    try:
        corners = np.asarray(json.loads(completed.stdout)['tangents'], dtype=np.float32).reshape(*faces.shape, 4)
    except (ValueError, KeyError, TypeError) as error:
        raise RuntimeError('Native MikkTSpace returned invalid corner tangent data') from error
    corner_normals = normals[faces]
    if (not np.isfinite(corners).all() or
            not np.all(np.abs(corners[..., 3]) == 1) or
            not np.allclose(np.linalg.norm(corners[..., :3], axis=-1), 1, atol=2e-5) or
            np.max(np.abs(np.sum(corner_normals * corners[..., :3], axis=-1))) > 2e-5):
        raise ValueError('Invalid MikkTSpace normal/tangent frame')
    if np.any(corners[..., 3] != corners[:, :1, 3]):
        raise ValueError('Invalid source normal / UV orientation for tangent frame')
    # Mikk can return incompatible tangents at the same indexed vertex even
    # with identical handedness. Split by the complete corner frame, never
    # average the result back to a custom tangent basis.
    sources = list(range(len(vertices))); output_faces = faces.copy()
    assigned = {}; claimed = set(); frames = np.zeros((len(vertices), 4), dtype=np.float32)
    extra_frames = []
    for fi, face in enumerate(faces):
        for ci, vi in enumerate(face):
            frame = corners[fi, ci]
            pair = (int(vi), *map(float, frame))
            if pair not in assigned:
                if int(vi) not in claimed:
                    assigned[pair] = int(vi); frames[vi] = frame; claimed.add(int(vi))
                else:
                    assigned[pair] = len(sources); sources.append(int(vi)); extra_frames.append(frame)
            output_faces[fi, ci] = assigned[pair]
    if extra_frames:
        frames = np.vstack([frames, extra_frames])
    # Unreferenced source vertices are retained without inventing triangle data.
    for vi in range(len(vertices)):
        if frames[vi, 3] == 0:
            axis = np.eye(3)[np.argmin(np.abs(normals[vi]))]
            frames[vi] = np.r_[unit(np.cross(normals[vi], axis)), 1]
    sources = np.asarray(sources, dtype=np.int64)
    original_sources=base_sources[sources]
    if (not np.array_equal(original_vertices[original_sources][output_faces],original_vertices[original_faces]) or
        not np.array_equal(original_uv[original_sources][output_faces],original_uv[original_faces])):
        raise ValueError('Normal/tangent attribute split changed source corners or UV')
    normal_repair['sourceFaceCornersAndUVExact']=True
    return {'faces': output_faces, 'sourceVertex': original_sources,
            'normals': normals[sources].astype(np.float32), 'tangents': frames.astype(np.float32), 'normalRepair':normal_repair,
            'basisMethod': 'MikkTSpace (Three.js reference-derived port; raw glTF UV; negate sign once)'}


def interpolated_basis(normals, tangents, barycentric):
    n = unit(normals)
    t = unit(np.asarray(tangents)[:, :3])
    b = unit(np.cross(n, t) * np.asarray(tangents)[:, 3, None])
    weights = np.asarray(barycentric, dtype=float)
    return np.stack([unit(weights @ t), unit(weights @ b), unit(weights @ n)], axis=-1)


def encode_world_normals(world_normals, normals, tangents, barycentric):
    basis = interpolated_basis(normals, tangents, barycentric)
    if np.any(np.abs(np.linalg.det(basis)) < 1e-8):
        raise ValueError('Singular interpolated glTF tangent frame')
    return unit(np.linalg.solve(basis, np.asarray(world_normals)[..., None])[..., 0])


def uv_raster_coordinates(uv, resolution):
    # Integer raster index i represents UV pixel center (i+.5)/resolution.
    return np.asarray(uv) * [resolution, -resolution] + [0, resolution]
