"""Bounded local mesh worker. JSON request/result protocol; immutable source files."""
import argparse
import hashlib
import json
import math
import os
import shutil
from pathlib import Path
import struct
import subprocess
import sys
import time

from native3d_presets import AI_LOWPOLY_DEFAULTS

import numpy as np
import trimesh


MAX_BYTES = 512 * 1024**2
MAX_FACES = 3_000_000


def compact_json(value):
    """Lossless UTF-8 JSON payload; delivery's 4MiB limit remains authoritative.

    Evidence is never trimmed to meet transport limits. Oversized compact reports
    must remain local diagnostics until a separate evidence transport is added.
    """
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False)


def memory_gate(estimated_bytes):
    import psutil
    free = psutil.virtual_memory().available
    headroom = max(1024**3, int(psutil.virtual_memory().total * .10))
    if free < estimated_bytes + headroom:
        raise ValueError('Insufficient RAM for bounded Native3D operation estimate plus system headroom')
    return {'estimatedBytes': int(estimated_bytes), 'availableBytes': int(free), 'headroomBytes': headroom}


def progress(stage, value):
    print(json.dumps({'stage': stage, 'progress': value / 100}), flush=True)


def uv_progress_callback():
    """Expose CPU UV phases without pretending percentages are measured ETAs."""
    phases = {'uv_prepare':('检查UV输入',25), 'uv_parameterization':('展开UV',30),
              'uv_overlap':('检查展开重叠',40), 'uv_orient_pack':('整理方向与排布',48),
              'uv_contour_pack':('优化图集排布',55), 'uv_contour_geometry':('检查候选排布',62),
              'uv_output_prepare':('准备UV输出',70), 'uv_raster':('检查像素重叠与间距',72),
              'uv_final_geometry':('核对最终UV几何',78), 'uv_finalize':('保存UV阶段',82),
              'uv_restore_verified':('复用已验证UV，准备导出',82)}
    last = [25]
    def emit(stage,event,elapsed):
        label,value=phases.get(stage,('处理UV',last[0]))
        last[0]=max(last[0],value)
        progress(label,last[0])
    return emit


def prepare_ai_points(points, normals):
    """Normalize before FP16 conversion to preserve small translated assets."""
    points = np.asarray(points, dtype=np.float64)
    normals = np.asarray(normals, dtype=np.float64)
    if not np.isfinite(points).all() or not np.isfinite(normals).all():
        raise ValueError('Nonfinite AI conditioning values')
    center = (points.min(0) + points.max(0)) / 2
    radius = float(np.abs(points - center).max())
    if radius <= 0:
        raise ValueError('AI conditioning has zero spatial extent')
    pc = np.concatenate([(points - center) / radius * .9995, normals], axis=1).astype(np.float16)
    if not np.isfinite(pc).all():
        raise ValueError('AI conditioning cannot be represented in FP16')
    return pc, center, radius


def run_owned_worker(executable, script, reqpath, out, timeout=600, *, worker_lease=None):
    executable = Path(executable)
    if not executable.is_absolute() or not executable.is_file():
        raise ValueError('Configured absolute worker executable is required')
    environment = None
    if worker_lease:
        from gpu_lease import WORKER_LEASE_ENV
        environment = {**os.environ, WORKER_LEASE_ENV: worker_lease}
    child = subprocess.Popen([str(executable), '-B', str(Path(__file__).with_name(script)), '--request', str(reqpath), '--output', str(out)], env=environment)
    try:
        code = child.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        if sys.platform == 'win32':
            subprocess.run(['taskkill', '/PID', str(child.pid), '/T', '/F'], capture_output=True)
        else:
            child.kill()
        child.wait()
        raise RuntimeError(script + ' exceeded bounded deadline')
    if code:
        raise RuntimeError(script + ' failed with exit code ' + str(code))


def official_mc_mesh(sdf, source_center=None, source_scale=None):
    """MC256 shell; optional official float32 world mapping before Trimesh."""
    from skimage.measure import marching_cubes
    if sdf.shape != (256, 256, 256) or not np.isfinite(sdf).all():
        raise ValueError('Invalid MC256 SDF')
    vertices, faces, normals, _ = marching_cubes(np.abs(sdf), 2 / 256)
    vertices = vertices / 256 * 2 - 1
    if source_center is not None or source_scale is not None:
        if source_center is None or source_scale is None or not np.isfinite(source_scale) or source_scale <= 0 or not np.isfinite(source_center).all():
            raise ValueError('Invalid MC source coordinate transform')
        # Upstream divides float32 marching vertices before adding float64 center.
        # Trimesh would first cast to float64 and change conditioning bytes.
        vertices = vertices / float(source_scale) + np.asarray(source_center, dtype=np.float64)
    return trimesh.Trimesh(vertices, faces, normals=normals)


def repair_winding(mesh, reference=None):
    """Orient a working copy through exact-coordinate topology without welding its seams."""
    result = mesh.copy()
    original_faces = np.asarray(result.faces).copy()
    exact, reverse = np.unique(np.asarray(result.vertices), axis=0, return_inverse=True)
    topology = trimesh.Trimesh(exact, reverse[original_faces], process=False)
    before = np.asarray(topology.faces).copy()
    was_consistent = bool(topology.is_winding_consistent)
    trimesh.repair.fix_normals(topology, multibody=True)
    winding_flips = np.any(before != topology.faces, axis=1)
    component_flips = 0
    if reference is not None:
        import open3d as o3d
        scene = o3d.t.geometry.RaycastingScene()
        high = o3d.geometry.TriangleMesh(o3d.utility.Vector3dVector(reference.vertices), o3d.utility.Vector3iVector(reference.faces))
        scene.add_triangles(o3d.t.geometry.TriangleMesh.from_legacy(high))
        nearest = scene.compute_closest_points(o3d.core.Tensor(np.asarray(topology.triangles_center, dtype=np.float32)))
        high_normals = nearest['primitive_normals'].numpy()
        labels = trimesh.graph.connected_components(topology.face_adjacency, nodes=np.arange(len(topology.faces)))
        reference_flips = np.zeros(len(topology.faces), dtype=bool)
        for component in labels:
            score = np.sum(np.einsum('ij,ij->i', topology.face_normals[component], high_normals[component]) * topology.area_faces[component])
            if score < 0:
                reference_flips[component] = True
                component_flips += 1
        winding_flips ^= reference_flips
    final_faces = original_faces.copy()
    final_faces[winding_flips] = final_faces[winding_flips, ::-1]
    result.faces = final_faces
    # Explicit invalidation/rebuild prevents imported stale normals surviving face flips.
    result._cache.clear()
    np.asarray(result.face_normals)
    np.asarray(result.vertex_normals)
    return result, {'method': 'trimesh.fix_normals per exact-coordinate connected component; transfer flips without vertex welding',
                    'inputVertices': len(mesh.vertices), 'outputVertices': len(result.vertices),
                    'inputTriangles': len(mesh.faces), 'outputTriangles': len(result.faces),
                    'nearVertexWelding': False, 'exactCoordinateTopologyVertices': len(exact),
                    'windingConsistentBefore': was_consistent, 'facesFlipped': int(winding_flips.sum()),
                    'referenceAlignedComponents': component_flips,
                    'orientationReference': 'nearest original high surface normals' if reference is not None else 'component volume heuristic; open orientation unresolved'}


def face_tangent_basis(xyz, uv, normal):
    delta = np.asarray(uv)[1:] - uv[0]
    determinant = float(np.linalg.det(delta))
    if abs(determinant) < 1e-12:
        raise ValueError('Degenerate UV triangle tangent basis')
    tangent = ((xyz[1] - xyz[0]) * delta[1, 1] - (xyz[2] - xyz[0]) * delta[0, 1]) / determinant
    tangent -= normal * (normal @ tangent)
    tangent /= max(np.linalg.norm(tangent), 1e-20)
    # Trimesh exports glTF V=1-localV. Explicit exported handedness must include that flip.
    handedness = -float(np.sign(determinant))
    return tangent, np.cross(normal, tangent) * handedness, handedness


def export_glb(mesh, path):
    def tangents(tree):
        for entry in tree.get('meshes', []):
            for primitive in entry.get('primitives', []):
                attributes = primitive.get('attributes', {})
                if '_TANGENT' in attributes:
                    attributes['TANGENT'] = attributes.pop('_TANGENT')
    path.write_bytes(trimesh.exchange.gltf.export_glb(mesh, include_normals=True, tree_postprocessor=tangents))


def official_surface_sample(mesh, count, seed):
    """Pinned legacy trimesh4 area/barycentric sampling using numpy RandomState."""
    random = np.random.RandomState(seed)
    cumulative = np.cumsum(mesh.area_faces)
    ids = np.searchsorted(cumulative, random.random(count) * cumulative[-1])
    lengths = random.random((count, 2, 1))
    lengths[lengths.sum(axis=1).reshape(-1) > 1] -= 1
    lengths = np.abs(lengths)
    triangles = mesh.triangles[ids]
    points = triangles[:, 0] + ((triangles[:, 1:] - triangles[:, :1]) * lengths).sum(axis=1)
    return points, ids


def official_mc_conditioning(processed, center, scale, seed, profile='canonical_safe', *, source_world=False):
    """Explicit FP16 coordinate-order profiles; never silently switch profiles."""
    if profile not in ('canonical_safe', 'legacy_world_fp16'):
        raise ValueError('Unsupported conditioningProfile')
    if not np.isfinite(scale) or scale <= 0 or not np.isfinite(center).all():
        raise ValueError('Invalid conditioning coordinate transform')
    sampling_mesh = processed
    if source_world and profile != 'legacy_world_fp16':
        raise ValueError('Source-world MC requires legacy_world_fp16')
    if profile == 'legacy_world_fp16' and not source_world:
        sampling_mesh = trimesh.Trimesh(np.asarray(processed.vertices) / scale + center,
                                        np.asarray(processed.faces), process=False)
    points, ids = official_surface_sample(sampling_mesh, 8192, seed)
    with np.errstate(over='ignore', invalid='ignore'):
        raw = np.concatenate([points, sampling_mesh.face_normals[ids]], axis=1, dtype=np.float16)
    if not np.isfinite(raw).all():
        raise ValueError('FP16 conditioning overflow/nonfinite values')
    extent = float(np.ptp(points, axis=0).max())
    if extent <= 0:
        raise ValueError('FP16 conditioning zero extent')
    quantization_ratio = float(np.abs(raw[:, :3].astype(np.float64) - points).max() / extent)
    unique_before = len(np.unique(points, axis=0))
    unique_after = len(np.unique(raw[:, :3], axis=0))
    if profile == 'legacy_world_fp16' and (quantization_ratio > .001 or unique_after < .99 * unique_before):
        raise ValueError('legacy_world_fp16 excessive quantization or collapsed unique positions')
    p = raw[:, :3]
    with np.errstate(over='ignore', invalid='ignore', divide='ignore'):
        local_center = (p.min(0) + p.max(0)) / 2
        centered = p - local_center
        radius = np.abs(centered).max()
        pc = np.concatenate([centered / radius * .9995, raw[:, 3:]], axis=1, dtype=np.float16)
    if radius <= 0 or not np.isfinite(radius) or not np.isfinite(pc).all():
        raise ValueError('Invalid official MC conditioning: FP16 normalization collapse/overflow')
    source_center = local_center.astype(np.float64)
    source_radius = float(radius)
    if profile == 'canonical_safe':
        source_center = source_center / scale + center
        source_radius /= scale
    return pc, source_center, source_radius, {'conditioningProfile': profile,
        'fp16MaxQuantizationExtentRatio': quantization_ratio,
        'sampleUniquePositionsBeforeFP16': unique_before, 'sampleUniquePositionsAfterFP16': unique_after}


def prepare_official_mc(mesh, config, request_path, out, seed, params=None):
    # Apply the official0.95 isotropic normalization before extension and FP16.
    # Keep this canonical space through MC/sampling, avoiding large-offset FP16 collapse.
    ram = memory_gate(1536 * 1024**2 + len(mesh.faces) * 400)
    center = mesh.bounds.mean(axis=0)
    scale = 1.9 / float(mesh.extents.max())
    canonical = (np.asarray(mesh.vertices, dtype=np.float64) - center) * scale
    np.savez_compressed(out / 'mc_input.npz', vertices=canonical, faces=np.asarray(mesh.faces))
    progress('official_mc256', 12)
    run_owned_worker(config.get('mesh2sdfPythonExecutable', ''), 'native3d_mesh2sdf.py', request_path, out)
    profile = (params or {}).get('conditioningProfile', AI_LOWPOLY_DEFAULTS['conditioningProfile'])
    if profile not in ('canonical_safe', 'legacy_world_fp16'):
        raise ValueError('Unsupported conditioningProfile')
    sdf = np.load(out / 'mc_sdf.npy', allow_pickle=False)
    legacy = profile == 'legacy_world_fp16'
    processed = official_mc_mesh(sdf, center, scale) if legacy else official_mc_mesh(sdf)
    pc, source_center, source_radius, conditioning = official_mc_conditioning(processed, center, scale, seed, profile, source_world=legacy)
    np.savez_compressed(out / 'ai_input.npz', pc=pc, center=source_center, radius=source_radius)
    receipt = json.loads((out / 'mc_receipt.json').read_text(encoding='utf-8'))
    receipt.update({'algorithm': 'official normalize0.95 -> mesh2sdf256 -> marching_cubes(abs(sdf),2/256)',
                    'ramGate': ram,
                    'coordinateSafety': ('MC and FP16 sampling in canonical coordinates; affine source inverse retained'
                        if profile == 'canonical_safe' else 'Explicit legacy source-world FP16 sampling; quantization/collapse gates enforced'),
                    'sampling': 'legacy trimesh4 area-weighted RandomState distribution', 'inputSeed': seed,
                    'processedTriangles': len(processed.faces), 'sourceCenter': center.tolist(), 'sourceToCanonicalScale': scale,
                    'sampleCenterSource': source_center.tolist(), 'sampleRadiusSource': source_radius,
                    'conditioningSha256': hashlib.sha256(pc.tobytes()).hexdigest(), **conditioning})
    (out / 'mc_receipt.json').write_text(json.dumps(receipt), encoding='utf-8')
    return receipt


def ai_shape_gate(source, output, cleanup):
    """Reject gross neural collapse, independently of a successful subprocess exit."""
    import open3d as o3d
    diagnostic = quality(output)
    points, _ = trimesh.sample.sample_surface(source, 2048, seed=719)
    scene = o3d.t.geometry.RaycastingScene()
    legacy = o3d.geometry.TriangleMesh(o3d.utility.Vector3dVector(output.vertices), o3d.utility.Vector3iVector(output.faces))
    scene.add_triangles(o3d.t.geometry.TriangleMesh.from_legacy(legacy))
    nearest = scene.compute_closest_points(o3d.core.Tensor(points.astype(np.float32)))['points'].numpy()
    diagonal = float(np.linalg.norm(source.extents))
    distances = np.linalg.norm(nearest - points, axis=1) / diagonal
    source_scene = o3d.t.geometry.RaycastingScene()
    high_legacy = o3d.geometry.TriangleMesh(o3d.utility.Vector3dVector(source.vertices), o3d.utility.Vector3iVector(source.faces))
    source_scene.add_triangles(o3d.t.geometry.TriangleMesh.from_legacy(high_legacy))
    output_points, _ = trimesh.sample.sample_surface(output, 2048, seed=720)
    source_nearest = source_scene.compute_closest_points(o3d.core.Tensor(output_points.astype(np.float32)))['points'].numpy()
    reverse_distances = np.linalg.norm(source_nearest - output_points, axis=1) / diagonal
    diagnostic.update({'sourceToOutputMeanDiagonalRatio': float(distances.mean()),
                       'sourceToOutputP95DiagonalRatio': float(np.percentile(distances, 95)),
                       'outputToSourceMeanDiagonalRatio': float(reverse_distances.mean()),
                       'outputToSourceP95DiagonalRatio': float(np.percentile(reverse_distances, 95)),
                       'independentSourceSamples': len(points), 'cleanup': cleanup})
    failures = []
    if cleanup['removedFraction'] > .20:
        failures.append('more than20% decoder triangles removed as duplicates/degenerates')
    if diagnostic['nonManifoldEdges'] > max(2, len(output.faces) * .01):
        failures.append('excess non-manifold topology')
    if distances.mean() > .03 or np.percentile(distances, 95) > .08:
        failures.append('gross source-surface coverage deviation')
    if reverse_distances.mean() > .03 or np.percentile(reverse_distances, 95) > .08:
        failures.append('gross extra-geometry deviation from source surface')
    diagnostic['rejectionReasons'] = failures
    diagnostic['status'] = 'rejected' if failures else 'needs_review'
    return diagnostic


def read_mesh(path):
    path = Path(path)
    if not path.is_absolute() or not path.is_file():
        raise ValueError('sourcePath must be an existing absolute mesh path')
    if path.stat().st_size > MAX_BYTES:
        raise ValueError('Source exceeds512 MiB pilot limit')
    suffix = path.suffix.lower()
    if suffix == '.fbx':
        import tempfile
        from native3d_fbx import import_fbx
        with tempfile.TemporaryDirectory(prefix='native3d-fbx-') as temporary:
            converted = Path(temporary) / 'source.glb'
            receipt = import_fbx(path, converted)
            mesh = read_mesh(converted)
            mesh.metadata['nativeFbx'] = receipt
            return mesh
    if suffix not in ('.obj', '.glb'):
        raise ValueError('Pilot accepts self-contained GLB or geometry-only OBJ')
    source_uv = False
    source_normals = False
    source_tangents = False
    source_colors = False
    material_info = []
    texture_wrapping = []
    if suffix == '.obj':
        with path.open('r', encoding='utf-8-sig', errors='strict') as f:
            for line in f:
                head = line.strip().split(maxsplit=1)
                if not head:
                    continue
                if head[0].lower() in ('mtllib', 'usemtl'):
                    raise ValueError('OBJ external/material dependencies unsupported; import self-contained GLB')
                source_uv |= head[0] == 'vt'
                source_normals |= head[0] == 'vn'
    else:
        from native3d_glb_layout import read_glb_document, validate_glb_layout
        doc = read_glb_document(path)
        validate_glb_layout(doc)
        for collection in ('buffers', 'images'):
            for item in doc.get(collection, []):
                if 'uri' in item:
                    raise ValueError('GLB URI dependencies unsupported; embed buffers and images')
        samplers = doc.get('samplers', [])
        wrapping = [(s.get('wrapS', 10497), s.get('wrapT', 10497)) for s in samplers]
        if any(mode not in (10497, 33071) for pair in wrapping for mode in pair):
            raise ValueError('Texture transfer supports REPEAT or CLAMP_TO_EDGE wrapping')
        for texture in doc.get('textures', []):
            index = texture.get('sampler')
            if index is not None and (type(index) is not int or not 0 <= index < len(wrapping)):
                raise ValueError('Invalid glTF texture sampler index')
            texture_wrapping.append((10497, 10497) if index is None else wrapping[index])
        if doc.get('skins') or doc.get('animations'):
            raise ValueError('Animated/skinned meshes unsupported in static pilot')
        material_info = doc.get('materials', [])
        if any(m.get('extensions') or m.get('alphaMode', 'OPAQUE') != 'OPAQUE' or m.get('emissiveTexture') for m in material_info):
            raise ValueError('Material extensions, transparency and emissive textures unsupported')
        for mesh in doc.get('meshes', []):
            for primitive in mesh.get('primitives', []):
                if primitive.get('mode', 4) != 4 or primitive.get('targets'):
                    raise ValueError('Only static triangle primitives supported')
                attributes = primitive.get('attributes', {})
                if 'COLOR_0' in attributes:
                    accessors = doc.get('accessors', [])
                    index = attributes['COLOR_0']
                    if type(index) is not int or not 0 <= index < len(accessors):
                        raise ValueError('GLB COLOR_0 has an invalid accessor.')
                    colors = accessors[index]
                    if (colors.get('type') not in ('VEC3', 'VEC4') or colors.get('componentType') != 5121
                            or colors.get('normalized') is not True or 'sparse' in colors):
                        raise ValueError('GLB COLOR_0 requires dense normalized unsigned-byte RGB or RGBA.')
                    if 'material' in primitive:
                        raise ValueError('GLB COLOR_0 combined with a material is outside the vertex-color pilot.')
                    source_colors = True
                source_uv |= 'TEXCOORD_0' in attributes
                source_tangents |= 'TANGENT' in primitive.get('attributes', {})
                source_normals |= 'NORMAL' in primitive.get('attributes', {})
    scene = trimesh.load(path, force='scene', process=False)
    nodes = list(scene.graph.nodes_geometry)
    if len(nodes) != 1 or len(scene.geometry) != 1:
        raise ValueError('Pilot requires exactly one geometry instance; refusing silent geometry loss')
    transform, name = scene.graph[nodes[0]]
    # GLB NORMAL is stored in Trimesh's vertex_normals cache. A default copy
    # discards it and silently regenerates a different shading field.
    mesh = scene.geometry[name].copy(include_cache=True)
    # A declaration alone is insufficient (e.g. OBJ vn without usable face
    # indices). Record imported normals only when the loader retained them.
    retained_source_normals = bool(source_normals and 'vertex_normals' in mesh._cache.cache)
    mesh.apply_transform(transform)
    if len(mesh.faces) == 0 or len(mesh.faces) > MAX_FACES:
        raise ValueError('Triangle count outside1..3000000 pilot bounds')
    if not np.isfinite(mesh.vertices).all() or np.ptp(mesh.vertices, axis=0).max() <= 0:
        raise ValueError('Source contains nonfinite or zero-size geometry')
    if source_colors:
        if getattr(mesh.visual, 'kind', None) != 'vertex':
            raise ValueError('GLB COLOR_0 mixed with unsupported material attributes.')
        mesh.metadata['nativeSourceVertexColor'] = True
    mesh.metadata['nativeSourceUV'] = source_uv
    mesh.metadata['nativeSourceTangentDeclared'] = source_tangents
    mesh.metadata['nativeMaterials'] = material_info
    mesh.metadata['nativeTextureWrapping'] = texture_wrapping
    mesh.metadata['nativeNormalSource'] = 'verified loader-retained source NORMAL/vn' if retained_source_normals else 'trimesh geometry-generated vertex normals (source normals absent or not retained)'
    return mesh


def simplify(mesh, target):
    if len(mesh.faces) <= target:
        return mesh.copy(include_cache=True)
    import fast_simplification
    points, faces = fast_simplification.simplify(np.asarray(mesh.vertices), np.asarray(mesh.faces), target_count=target)
    return trimesh.Trimesh(points, faces, process=False)


def quality(mesh):
    from native3d_highpoly import topology_report
    topology = topology_report(mesh)
    return {'status': 'needs_review', 'vertices': len(mesh.vertices), 'triangles': len(mesh.faces),
            'bounds': mesh.bounds.tolist(), 'finite': bool(np.isfinite(mesh.vertices).all()),
            'degenerateTriangles': topology['degenerateTriangles'],
            'boundaryEdges': topology['boundaryEdges'], 'nonManifoldEdges': topology['nonManifoldEdges'],
            'uvSeamEdges': topology['uvSeamEdges'], 'uvSeamsReportedAsBoundary': topology['uvSeamsReportedAsBoundary'],
            'weldedVertices': topology['weldedVertices'],
            'watertight': bool(mesh.is_watertight), 'selfIntersection': 'not_checked'}


def poster(mesh, path):
    """Genuine orthographic triangle rendering with a painter depth buffer approximation."""
    from PIL import Image, ImageDraw
    preview = simplify(mesh, 12000)
    v = np.asarray(preview.vertices).copy()
    v -= (v.min(0) + v.max(0)) / 2
    rotation = trimesh.transformations.euler_matrix(math.radians(65), 0, math.radians(35))[:3, :3]
    v = v @ rotation.T
    scale = 540 / max(float(np.ptp(v[:, :2], axis=0).max()), 1e-12)
    screen = v[:, :2] * [scale, -scale] + [320, 320]
    image = Image.new('RGB', (640, 640), '#171d28')
    draw = ImageDraw.Draw(image)
    light = np.array([.25, -.4, .85]); light /= np.linalg.norm(light)
    norms = preview.face_normals @ rotation.T
    for index in np.argsort(v[preview.faces, 2].mean(1)):
        shade = .32 + .68 * abs(float(norms[index] @ light))
        color = tuple(int(c * shade) for c in (139, 190, 219))
        draw.polygon([tuple(x) for x in screen[preview.faces[index]]], fill=color)
    image.save(path)


def unwrap(mesh, params):
    import xatlas
    materials = mesh.metadata.get('nativeMaterials', [])
    if any(m.get('normalTexture') or m.get('occlusionTexture') or m.get('pbrMetallicRoughness', {}).get('baseColorTexture') or m.get('pbrMetallicRoughness', {}).get('metallicRoughnessTexture') for m in materials):
        raise ValueError('Re-unwrapping an existing textured material requires texture transfer; unsupported in UV pilot')
    mesh, winding = repair_winding(mesh)
    atlas = xatlas.Atlas()
    atlas.add_mesh(np.asarray(mesh.vertices, dtype=np.float32), np.asarray(mesh.faces, dtype=np.uint32))
    pack = xatlas.PackOptions()
    pack.resolution = int(params.get('resolution', 1024))
    padding = int(params.get('padding', 8))
    if not 1 <= padding <= 32:
        raise ValueError('UV padding outside1..32')
    pack.padding = padding
    atlas.generate(pack_options=pack)
    xref, faces, uv = atlas[0]
    if len(faces) != len(mesh.faces) or not np.array_equal(np.asarray(xref)[faces], mesh.faces):
        raise RuntimeError('xatlas triangle lineage mismatch')
    result = trimesh.Trimesh(np.asarray(mesh.vertices)[xref], faces, process=False)
    result.visual = trimesh.visual.TextureVisuals(uv=uv, material=trimesh.visual.material.PBRMaterial(
        baseColorFactor=[188, 188, 188, 255], metallicFactor=0., roughnessFactor=.8))
    if materials and hasattr(mesh.visual, 'material'):
        result.visual.material = mesh.visual.material.copy()
    return result, {'backend': 'xatlas', 'charts': int(atlas.chart_count), 'resolution': pack.resolution,
                    'padding': padding, 'exactTriangleMapping': True, 'uvVertices': len(uv), 'windingRepair': winding}


def resolve_bake_settings(params, high_diagonal):
    """Worker and queue share strict schema validation; no numeric coercion."""
    from native3d_jobs import validate_parameters
    from project_store import StoreError
    try:
        settings=validate_parameters('bake',params)
    except StoreError as exc:
        raise ValueError(str(exc)) from exc
    if not np.isfinite(high_diagonal) or high_diagonal<=0:
        raise ValueError('Bake needs a finite positive high-source diagonal')
    settings['paddingRequested']=settings['padding']
    settings['padding']=max(8, settings['padding'] or settings['resolution']//128)
    settings['cageDistance']=settings['rayDistance']*high_diagonal
    settings['aoRadius']=settings['aoRadiusFraction']*high_diagonal
    # Deliberately retain existing projection-linked origin bias in this slice.
    settings['aoEpsilon']=max(settings['cageDistance']*1e-4,1e-7)
    settings['baselineVersion']='bake-defaults-20261104'
    return settings


def bake(low, high, out, params, progress_callback=None):
    import open3d as o3d
    from PIL import Image
    from native3d_bake_basis import build_bake_basis, encode_world_normals, uv_raster_coordinates
    from native3d_bake_ao import sample_high_surface_ao
    from native3d_bake_normal import filtered_high_normals, interpolate_high_normals
    from native3d_bake_projection import project_cage, ExternalVisibleProjector
    settings=resolve_bake_settings(params,np.linalg.norm(high.extents))
    resolution=settings['resolution']
    source_normals = np.asarray(low.vertex_normals).copy()
    repaired, winding = repair_winding(low, reference=high)
    low.faces = repaired.faces.copy()
    low._cache.clear()
    uv = getattr(low.visual, 'uv', None)
    if not low.metadata.get('nativeSourceUV') or uv is None or len(uv) != len(low.vertices):
        raise ValueError('Bake low mesh requires actual source UV coordinates')
    uv = np.asarray(uv, dtype=float)
    if not np.isfinite(uv).all() or uv.min() < -1e-6 or uv.max() > 1.000001:
        raise ValueError('Bake supports finite non-tiled UVs inside0..1')
    # Freeze plain arrays once: indexing Trimesh's TrackedArray face iterator
    # dirties its parent hash, making cached face_normals rehash the mesh for
    # every triangle. No geometry is mutated until final attribute export.
    low_vertices=np.array(low.vertices,copy=True)
    low_faces=np.array(low.faces,copy=True)
    low_face_normals=np.array(low.face_normals,copy=True)
    high_vertices=np.array(high.vertices,copy=True)
    high_faces=np.array(high.faces,copy=True)
    for array in (low_vertices,low_faces,low_face_normals,high_vertices,high_faces):array.setflags(write=False)
    basis = build_bake_basis(low_vertices, low_faces, uv, source_normals)
    corner_normals = basis['normals'][basis['faces']]
    corner_tangents = basis['tangents'][basis['faces']]
    materials = high.metadata.get('nativeMaterials', [])
    from native3d_source_material import SourceMaterial, filtered_source_normals
    source_material = SourceMaterial(high)
    pbr = source_material.pbr
    base_pixels = source_material.images.get('baseColorTexture')
    mr_pixels = source_material.images.get('metallicRoughnessTexture')
    source_ao = 'occlusionTexture' in source_material.images
    source_normal = source_material.basis is not None
    if source_normal:
        def filtered_high_normals(*args, **kwargs):
            return filtered_source_normals(*args, **kwargs, source_material=source_material)
    vertex_rgb = (np.asarray(high.visual.vertex_colors[:, :3], dtype=np.float32) / 255
                  if high.metadata.get('nativeSourceVertexColor') else None)
    factor = np.asarray(pbr.get('baseColorFactor', [1, 1, 1, 1]) if materials else
                        ([1, 1, 1, 1] if vertex_rgb is not None else [.5, .5, .5, 1]))[:3]
    if vertex_rgb is not None:
        source_material.report['vertexColor'] = 'GLB linear vertex color barycentric projection'
    from native3d_material_wear import surface_curvature, curvature_samples
    high_curvature = surface_curvature(high)
    curvature = np.zeros((resolution, resolution), dtype=np.uint8)
    curvature_radius = float(np.linalg.norm(high.extents)) * .008
    rough_factor = float(pbr.get('roughnessFactor', 1) if materials else .8)
    metal_factor = float(pbr.get('metallicFactor', 1) if materials else 0)
    cage=settings['cageDistance']
    ao_radius=settings['aoRadius']
    ao_epsilon=settings['aoEpsilon']
    ao_samples=settings['aoSamples']
    if not np.isfinite(cage) or cage <= 0 or cage > np.linalg.norm(high.extents) * .25:
        raise ValueError('cageDistance must be positive and at most25% high-source diagonal')
    scene = o3d.t.geometry.RaycastingScene()
    legacy = o3d.geometry.TriangleMesh(o3d.utility.Vector3dVector(high_vertices.copy()), o3d.utility.Vector3iVector(high_faces.copy()))
    scene.add_triangles(o3d.t.geometry.TriangleMesh.from_legacy(legacy))
    cast_projection=lambda rays:{key:value.numpy() for key,value in scene.cast_rays(o3d.core.Tensor(rays)).items()}
    visible_projector=ExternalVisibleProjector(high_vertices,high_faces,cast_projection,np.linalg.norm(high.extents),ao_epsilon)
    supplemental_normal_sampling={}
    high_normal_safety={'supplementalCenters':{},'aoCenters':{}}
    recovered_centers=0
    coverage = np.zeros((resolution, resolution), dtype=np.uint8)
    hitmask = np.zeros_like(coverage)
    normal_hitmask = np.zeros_like(coverage)
    invalid_source_normal_texels = 0
    normal = np.full((resolution, resolution, 3), [128, 128, 255], dtype=np.uint8)
    ao = np.full((resolution, resolution), 255, dtype=np.uint8)
    scalar_srgb = np.where(factor <= .0031308, factor * 12.92, 1.055 * np.maximum(factor, 0) ** (1/2.4) - .055)
    basecolor = np.broadcast_to(np.clip(scalar_srgb * 255, 0, 255).astype(np.uint8), (resolution, resolution, 3)).copy()
    roughness = np.full((resolution, resolution), int(rough_factor * 255), dtype=np.uint8)
    metallic = np.full((resolution, resolution), int(metal_factor * 255), dtype=np.uint8)
    overlap = hits = misses = covered = opposing_normals = 0
    projection_report={'centerRayMisses':0,'centerBackfacingHits':0,'centerHitsBeyondSegment':0,'normalTapOnlyMisses':0,'centerBackfaceRejectedSamples':0,'centerNonOutwardRejectedSamples':0,'centerInvalidGeometricNormalSamples':0}
    high_vertex_normals = np.asarray(high.vertex_normals).copy()
    normal_sampling = {'mode':'2x2 directional cage high barycentric vertex NORMAL; world-space average, center interpolated low TBN encoding',
                       'normalSource':high.metadata.get('nativeNormalSource','in-memory high vertex normals (source provenance unavailable)'),
                       'tapsPerTexel':4,'offsets':[.25,.75], 'insideFaceTaps':0,'outsideFaceTaps':0,'validTaps':0,
                       'cageRejectedTaps':0,'texelsWithoutValidTaps':0,'cancelledNormalTexels':0,'centerValidButNoNormalTexels':0,'centerOnlySubpixelTexels':0}
    if source_normal:
        normal_sampling['mode']='2x2 directional-cage projection taps; source OpenGL tangent normal decoded through original high Mikk TBN, world average, low Mikk encoding'
    # Tile-sized batches bound projection memory, including4K outputs.
    last_progress=time.monotonic()
    for fi, face in enumerate(low_faces):
        if progress_callback is not None and (fi==0 or time.monotonic()-last_progress>=5.):
            progress_callback('bake_faces_'+str(fi)+'_of_'+str(len(low_faces)),25+int(55*fi/len(low_faces)))
            last_progress=time.monotonic()
        tex = uv_raster_coordinates(uv[face], resolution)
        lo = np.maximum(np.floor(tex.min(0)).astype(int), 0)
        hi = np.minimum(np.ceil(tex.max(0)).astype(int), resolution - 1)
        matrix = np.column_stack([tex[1] - tex[0], tex[2] - tex[0]])
        if abs(np.linalg.det(matrix)) < 1e-10:
            continue
        inv = np.linalg.inv(matrix)
        xyz = low_vertices[face]
        delta_uv = uv[face][1:] - uv[face][0]
        determinant = np.linalg.det(delta_uv)
        if abs(determinant) < 1e-12:
            continue
        n = low_face_normals[fi]
        tangent, bitangent, _ = face_tangent_basis(xyz, uv[face], n)
        rows_per_chunk = max(1, 4096 // max(1, int(hi[0] - lo[0] + 1)))
        for row in range(lo[1], hi[1] + 1, rows_per_chunk):
            xx, yy = np.meshgrid(np.arange(lo[0], hi[0] + 1), np.arange(row, min(row + rows_per_chunk, hi[1] + 1)))
            xy = np.column_stack([xx.ravel(), yy.ravel()])
            bary2 = (xy + .5 - tex[0]) @ inv.T
            inside = (bary2 >= 1e-7).all(1) & (bary2.sum(1) <= 1 - 1e-7)
            xy, bary2 = xy[inside], bary2[inside]
            if not len(xy):
                continue
            x, y = xy.T
            overlap += int(np.count_nonzero(coverage[y, x]))
            coverage[y, x] = 1
            points = xyz[0] + bary2 @ (xyz[1:] - xyz[0])
            center_weights=np.column_stack([1-bary2.sum(1),bary2])
            projection_normals=center_weights@corner_normals[fi]
            def query_projection(sample_points,sample_normals):
                return project_cage(sample_points,sample_normals,cage,cast_projection)
            def query_with_visible(sample_points,sample_normals,scope='tap'):
                result=query_projection(sample_points,sample_normals)
                missing=~result['valid']
                if missing.any():
                    supplement=visible_projector.project(sample_points[missing],sample_normals[missing],scope)
                    for key in result:
                        if key in supplement:result[key][missing]=supplement[key]
                return result
            found=query_projection(points,projection_normals)
            nearest=found['points'];hn=found['primitive_normals'].astype(float)
            valid=found['valid'].copy()
            projection_report['centerRayMisses']+=int(np.count_nonzero(~np.isfinite(found['t_hit'])))
            projection_report['centerHitsBeyondSegment']+=int(np.count_nonzero(np.isfinite(found['t_hit'])&((found['t_hit']<0)|(found['t_hit']>2*cage))))
            projection_report['centerBackfacingHits']+=int(found['backfaceRejectedMask'].sum())
            projection_report['centerBackfaceRejectedSamples']+=int(found['backfaceRejectedMask'].sum())
            projection_report['centerNonOutwardRejectedSamples']+=int(found['nonOutwardRejectedMask'].sum())
            projection_report['centerInvalidGeometricNormalSamples']+=int(found['invalidGeometricNormalMask'].sum())
            filtered_normal, normal_valid, normal_report = filtered_high_normals(xy, tex, xyz, high_faces, high_vertex_normals, cage, query_projection,corner_normals[fi])
            projection_report['normalTapOnlyMisses']+=int(np.count_nonzero(valid&~normal_valid))
            for key,value in normal_report.items():normal_sampling[key]=normal_sampling.get(key,0)+value
            normal_sampling['centerValidButNoNormalTexels']+=int(np.count_nonzero(valid & ~normal_valid))
            # Existing successful center+normal samples stay byte-for-byte
            # unchanged. Only unresolved texels receive certified supplements.
            unresolved=~(valid&normal_valid)
            if unresolved.any():
                extra=query_with_visible(points[unresolved],projection_normals[unresolved],'center')
                center_normal=np.zeros((int(unresolved.sum()),3))
                center_normal_valid=extra['valid'].copy()
                if source_normal:
                    center_normal_valid[extra['valid']] &= source_material.basis['validFaces'][extra['primitive_ids'][extra['valid']].astype(np.int64)]
                if center_normal_valid.any():
                    center_normal[center_normal_valid]=(source_material.world_normals(extra['primitive_ids'][center_normal_valid],extra['primitive_uvs'][center_normal_valid]) if source_normal else interpolate_high_normals(high_vertex_normals,high_faces,extra['primitive_ids'][center_normal_valid],extra['primitive_uvs'][center_normal_valid],extra['primitive_normals'][center_normal_valid],high_normal_safety['supplementalCenters']))
                extra_normal,extra_valid,extra_report=filtered_high_normals(xy[unresolved],tex,xyz,high_faces,high_vertex_normals,cage,query_with_visible,corner_normals[fi],center_normal,center_normal_valid)
                accepted=extra['valid']&extra_valid
                recovered_centers+=int(accepted.sum())
                for key,value in extra_report.items():supplemental_normal_sampling[key]=supplemental_normal_sampling.get(key,0)+value
                for key in found:
                    if key in extra:found[key][unresolved]=extra[key]
                filtered_normal[unresolved]=extra_normal;normal_valid[unresolved]=extra_valid
                valid=found['valid'].copy();nearest=found['points'];hn=found['primitive_normals'].astype(float)
            if source_normal:
                center_frames_ok=np.zeros(len(valid),bool)
                center_frames_ok[valid]=source_material.basis['validFaces'][found['primitive_ids'][valid].astype(np.int64)]
                normal_valid &= center_frames_ok
                invalid_source_normal_texels += int(np.count_nonzero(valid & ~normal_valid))
            else:
                valid &= normal_valid
            normal_hitmask[y[valid & normal_valid], x[valid & normal_valid]] = 255
            hitmask[y[valid], x[valid]] = 255
            if valid.any():
                ids = found['primitive_ids'][valid]
                primitive_uvs = found['primitive_uvs'][valid]
                curvature[y[valid], x[valid]] = np.rint(
                    curvature_samples(high_curvature, ids, primitive_uvs, curvature_radius) * 255).astype(np.uint8)
                if base_pixels is not None or vertex_rgb is not None:
                    if base_pixels is not None:
                        linear = source_material.sample('baseColorTexture', ids, primitive_uvs) * factor
                    else:
                        bary = np.column_stack((1-primitive_uvs.sum(axis=1), primitive_uvs))
                        linear = (vertex_rgb[high_faces[ids]] * bary[..., None]).sum(axis=1) * factor
                    srgb = np.where(linear <= .0031308, linear * 12.92, 1.055 * np.maximum(linear, 0) ** (1/2.4) - .055)
                    basecolor[y[valid], x[valid]] = np.clip(srgb * 255, 0, 255).astype(np.uint8)
                if mr_pixels is not None:
                    sampled = source_material.sample('metallicRoughnessTexture', ids, primitive_uvs)
                    roughness[y[valid], x[valid]] = np.clip(sampled[:, 1] * rough_factor * 255, 0, 255).astype(np.uint8)
                    metallic[y[valid], x[valid]] = np.clip(sampled[:, 2] * metal_factor * 255, 0, 255).astype(np.uint8)
                if source_ao:
                    sampled = source_material.sample('occlusionTexture', ids, primitive_uvs)[:, 0]
                    ao[y[valid], x[valid]] = np.clip((1 + source_material.ao_strength * (sampled - 1)) * 255, 0, 255).astype(np.uint8)
            hits += int(valid.sum()); misses += int((~valid).sum()); covered += len(points)
            weights = np.column_stack([1 - bary2.sum(1), bary2])
            # Invalid normals are never treated as real projection hits. A
            # neutral placeholder only avoids passing a zero vector to solve.
            filtered_normal[~normal_valid] = n
            local_n = encode_world_normals(filtered_normal, corner_normals[fi], corner_tangents[fi], weights)
            opposing_normals += int(np.count_nonzero(valid & (local_n[:, 2] < 0)))
            local_n /= np.maximum(np.linalg.norm(local_n, axis=1)[:, None], 1e-20)
            normal_write=valid & normal_valid
            normal[y[normal_write], x[normal_write]] = np.clip((local_n[normal_write] * .5 + .5) * 255, 0, 255).astype(np.uint8)
            # Valid high-surface hits only; no low-triangle or UV-chart frame.
            if valid.any() and not source_ao:
                ao_shading_normals = interpolate_high_normals(high_vertex_normals, high_faces,
                    found['primitive_ids'][valid], found['primitive_uvs'][valid],hn[valid],high_normal_safety['aoCenters'])
                visibility = sample_high_surface_ao(nearest[valid], ao_shading_normals, ao_samples, ao_radius, ao_epsilon,
                    lambda rays: scene.cast_rays(o3d.core.Tensor(rays))['t_hit'].numpy(), geometric_normals=hn[valid],attenuation=settings['aoAttenuation'])
                ao[y[valid], x[valid]] = np.clip(visibility * 255, 0, 255).astype(np.uint8)
    if progress_callback is not None:progress_callback('bake_faces_'+str(len(low_faces))+'_of_'+str(len(low_faces)),80)
    if covered == 0 or hits == 0:
        raise ValueError('No valid UV texels/high-surface projection hits')
    if overlap:
        raise ValueError('Overlapping source UV texels unsupported for unique bake')
    # Extend only outside island coverage; never overwrite valid texels or masked projection misses.
    from scipy.ndimage import distance_transform_edt
    distance, indices = distance_transform_edt(hitmask == 0, return_indices=True)
    dilated = (coverage == 0) & (distance <= settings['padding'])
    for pixels in (normal, ao, basecolor, roughness, metallic, curvature):
        pixels[dilated] = pixels[indices[0][dilated], indices[1][dilated]]
    auto_wear = bool(params.get('autoWear', False))
    auto_wear_report = {'enabled': False}
    if auto_wear:
        from native3d_material_wear import apply_wear_arrays
        wear_params = {
            'strength': float(params.get('wearStrength', 0.55)),
            'threshold': float(params.get('wearThreshold', 0.18)),
            'edgeLighten': float(params.get('wearEdgeLighten', 0.28)),
            'edgeRoughness': float(params.get('wearEdgeRoughness', 0.52)),
            'metalExposure': float(params.get('wearMetalExposure', 0.15)),
        }
        basecolor, roughness, metallic, edge_wear, wear_mask = apply_wear_arrays(
            basecolor, roughness, metallic, curvature, wear_params)
        edge_wear[dilated] = edge_wear[indices[0][dilated], indices[1][dilated]]
        Image.fromarray(edge_wear).save(out / 'edge-wear.png')
        auto_wear_report = {
            'enabled': True,
            'wearOnProjectedTexels': int(((wear_mask > 0) & (hitmask > 0)).sum()),
            'parameters': wear_params,
            'curvature': 'projected convex high-mesh edge strength',
        }
    Image.fromarray(normal).save(out / 'normal.png')
    Image.fromarray(ao).save(out / 'ao.png')
    Image.fromarray(curvature).save(out / 'curvature.png')
    Image.fromarray(coverage * 255).save(out / 'coverage.png')
    Image.fromarray(hitmask).save(out / 'hits.png')
    Image.fromarray(normal_hitmask).save(out / 'normal-valid.png')
    source_material.report['projectedNormalInvalidTexels']=invalid_source_normal_texels
    source_material.report['normalValidityMask']='normal-valid.png; covered zeros are explicit invalid/neutral normal placeholders'
    source_material.report['normalComplete']=invalid_source_normal_texels==0
    Image.fromarray(basecolor).save(out / 'basecolor.png')
    Image.fromarray(roughness).save(out / 'roughness.png')
    Image.fromarray(metallic).save(out / 'metallic.png')
    from native3d_material_atlas import texture_qc_warnings, write_packed_maps
    write_packed_maps(out, ao, roughness, metallic)
    texture_warnings = texture_qc_warnings(normal, roughness, mask=coverage > 0)
    def loaded_image(name):
        with Image.open(out / name) as image:
            return image.copy()
    orm = loaded_image('orm.png')
    low.visual.material = trimesh.visual.material.PBRMaterial(
        baseColorTexture=loaded_image('basecolor.png'),
        normalTexture=loaded_image('normal.png'),
        occlusionTexture=orm,
        metallicRoughnessTexture=orm,
        metallicFactor=1., roughnessFactor=1.)
    # Mirror-only index splits preserve every original corner position/UV and
    # source shading normal. Export precisely the frames used by texel encoding.
    source_vertex = basis['sourceVertex']
    saved_uv = np.asarray(low.visual.uv).copy()
    saved_attributes = {key: np.asarray(value).copy() for key, value in low.vertex_attributes.items()}
    low.vertices = low_vertices[source_vertex].copy()
    low.faces = basis['faces']
    low.visual.uv = saved_uv[source_vertex]
    low.vertex_normals = basis['normals']
    low.vertex_attributes = {key: value[source_vertex] for key, value in saved_attributes.items()}
    low.vertex_attributes['_TANGENT'] = basis['tangents']
    from native3d_highpoly import deliver_shared_lods
    return {'resolution': resolution,'bakeSettings':settings,'defaultsBaseline':'bake-defaults-20261104',
            'concavitySafety':{'version':'concavity-safety-v1','primaryFacingPolicy':'reject actual high geometric N dot normalized low direction<=0; no blind next-hit search',
                'highShadingNormalPolicy':'unnormalizable or backfacing to its own actual high geometric N (dot<0) uses that geometric N; tangent dot=0 and positive grazing preserved; never clamps or flips against low N',
                'primaryFacingTerminology':'non-outward means backfacing or tangent; historical backfaceRejectedMask/centerBackfaceRejectedSamples include both',
                'normalSafetyCounts':high_normal_safety,'normalSafetyCountUnit':'evaluated samples per scope, not unique repaired vertices',
                'aaRiskPolicy':'tap pair dot<-.5 is reported only; no automatic vote, rejection or hole fill; same-layer AA remains unresolved'},
            'aoRadiusFraction':settings['aoRadiusFraction'],'aoAttenuation':settings['aoAttenuation'],'padding':settings['padding'],
            'projection': 'finite directional cage first hit; only unresolved texels use bounded external-visible candidate certification', 'projectionDiagnostics': projection_report,
            'externalVisibleProjection':{**visible_projector.report,'recoveredCoveredTexels':recovered_centers,'supplementalNormalSampling':supplemental_normal_sampling,'subpixelNormalRule':'Only source-face interior centers with all four2x2 taps outside the face may use their certified center high normal. Inside-face projection misses never use this rule.'},
            'cageDistance': cage, 'coveredSamples': covered, 'hitSamples': hits, 'missSamples': misses,
            'hitRatio': hits / covered, 'overlapSamples': overlap, 'aoRays': 0 if source_ao else ao_samples,
            'projectionQuality': {'status':'needs_review',
                'coveredMissTexels':misses,'coveredMissFraction':misses/covered,
                'normalInvalidTexels':invalid_source_normal_texels,
                'completeNormalTransfer':invalid_source_normal_texels==0 and misses==0,
                'unresolvedMissTolerance':0,'completeProjection':misses==0,
                'automaticAcceptance':False,
                'reviewReasons':(['invalid source normal frame/AA samples; see normal-valid.png and source frame validity'] if invalid_source_normal_texels else [])+(['unresolved covered projection misses; neutral normal/white AO are placeholders, not successful hits'] if misses else [])+
                    (['non-outward primary first hits rejected; certified fallback or unresolved miss'] if projection_report['centerBackfaceRejectedSamples'] else [])+
                    (['strongly opposing normal taps detected; no same-layer AA correction performed'] if normal_sampling.get('texelsWithStrongOpposingTaps',0)+supplemental_normal_sampling.get('texelsWithStrongOpposingTaps',0) else [])+
                    ['visual surface correspondence and normal continuity require review'],
                'direction':'primary normalized interpolated low shading normal; unresolved samples use certified external-visible candidate rays',
                'maximumRaySegment':float(2*cage),
                'fallback':'unresolved samples only: bounded external-visible candidate certification; no unverified nearest sampling or covered-island inpainting'},
            'aoSampler': {'policy': source_material.report['ao'],
                          'sequence':'source texture at valid center hits' if source_ao else 'deterministic midpoint Hammersley cosine hemisphere',
                          'frame':'Duff ONB from actual center high primitive geometric normal; hemisphere and origin bias use the same high geometry N; no low tangent/UV dependency',
                          'radius':float(ao_radius),'epsilon':float(ao_epsilon),
                          'radiusFraction':settings['aoRadiusFraction'],'attenuation':settings['aoAttenuation'],
                          'originBias':'high primitive geometric normal','validProjectionHitsOnly':True,
                          'limitation':'high primitive normals can remain discontinuous across high mesh hard/flat faces'},
            'opposingHighNormalSamples': opposing_normals, 'opposingHighNormalRatio': opposing_normals / hits,
            'tangentBasis': basis['basisMethod'],
            'tangentMirrorSplitVertices': int(len(source_vertex) - len(source_normals)),
            'normalSampling': normal_sampling,
            'shadingNormalRepair': basis['normalRepair'],
            'rasterConvention': 'UV*resolution; texel centers at integer+.5',
            'windingRepair': winding,
            'materialFallback': ('vertex colors; roughness 0.8, metallic 0' if vertex_rgb is not None else
                                 'neutral matte: linear baseColor0.5,roughness0.8,metallic0; no original high material') if not materials else 'none; original material factors/textures preserved',
            'curvature': {'kind':'convex-edge-dihedral','radius':curvature_radius},
            'sourceMaterialTransfer': source_material.report,
            'pbrTransfer': {'baseColor': ('embedded texture times original factor' if base_pixels is not None else
                                          'linear vertex-color projection encoded to sRGB' if vertex_rgb is not None else 'original/default scalar factor'),
                            'metallicRoughness': 'embedded texture times original factors' if mr_pixels is not None else 'original/default scalar factors'},
            'dilation': {'pixels':settings['padding'],'requestedPixels':settings['paddingRequested'],'automatic':settings['paddingRequested']==0, 'changedTexels': int(dilated.sum()), 'outsideIslandCoverageOnly': True},
            'autoWear': auto_wear_report,
            'textureQuality': {'warnings': texture_warnings},
            'sharedLods': deliver_shared_lods(low, out)}


def run(request, output, *, worker_lease=None):
    started = time.monotonic()
    out = Path(output).resolve()
    out.mkdir(parents=True, exist_ok=True)
    if (out / 'result.json').exists():
        raise ValueError('Refusing to overwrite an existing successful result')
    source = Path(request['sourcePath'])
    operation = request['operation']
    if operation not in ('analyze', 'ai_lowpoly', 'repair_lod', 'source_lod', 'uv_plan', 'uv', 'bake', 'image_to_3d', 'material_wear'):
        raise ValueError('Unsupported operation')
    params = request.get('parameters') or {}
    if operation=='bake':
        from native3d_jobs import validate_parameters
        from project_store import StoreError
        try:
            params=validate_parameters('bake',request.get('parameters',{}))
        except StoreError as exc:
            raise ValueError(str(exc)) from exc
    progress('read_source', 5)
    if source.is_file():
        memory_gate(max(512 * 1024**2, source.stat().st_size * 8))
    generation = None
    if operation == 'image_to_3d':
        from native3d_triposr import generate
        mesh, generation = generate(source, request.get('imageTo3D'), params, progress)
        if not 4 <= len(mesh.faces) <= MAX_FACES:
            raise ValueError('图生模型输出的三角面数超出原生处理范围。')
    else:
        mesh = read_mesh(source)
    ram = memory_gate(max(512 * 1024**2, len(mesh.faces) * 400 + int(params.get('resolution', 1024))**2 * (64 if operation == 'bake' else 4)))
    original = quality(mesh)
    warnings = ['Quality requires user review; self-intersection has not been exhaustively checked.']
    metadata = {'operation': operation, 'sourceSha256': hashlib.sha256(source.read_bytes()).hexdigest(),
                'sourceUV': bool(mesh.metadata.get('nativeSourceUV')),
                'sourceVertexColor': bool(mesh.metadata.get('nativeSourceVertexColor')), 'sourceMaterials': len(mesh.metadata.get('nativeMaterials', [])),
                'sourceTransform': 'scene instance transform applied to world geometry', 'source': original, 'ramGate': ram}
    files = []
    review=request.get('geometryReview')
    if review is not None:
        from native3d_geometry_review import apply_review_metadata
        if operation not in ('uv_plan','uv','bake') or review.get('sourceSha256')!=metadata['sourceSha256'] or review.get('reviewedBoundaryJobId')!=params.get('reviewedBoundaryJobId') or review.get('reviewedBoundaryStage')!=params.get('reviewedBoundaryStage'):
            raise ValueError('Reviewed geometry snapshot identity mismatch')
        high_review_path=Path(request.get('highSourcePath',''))
        if not high_review_path.is_file() or hashlib.sha256(high_review_path.read_bytes()).hexdigest()!=(review.get('bakeHighSha256') or review.get('originalSourceSha256')):
            raise ValueError('Reviewed original high snapshot identity mismatch')
        apply_review_metadata(metadata,warnings,review)
    if operation in ('source_lod','uv_plan') and request.get('source',{}).get('sha256') not in (None,metadata['sourceSha256']):
        raise ValueError('Source snapshot SHA256 changed')
    if operation == 'image_to_3d':
        metadata['generation'] = generation
    elif operation == 'material_wear':
        from native3d_material_wear import apply_wear
        metadata['materialWear'] = apply_wear(source, out, request['materialWear'], params)
        for name in ('basecolor','roughness','metallic','normal','ao','curvature','metallic-roughness','orm','edge-wear'):
            files.append({'name':name+'.png', 'role':'texture', 'mime':'image/png'})
    elif operation == 'ai_lowpoly':
        if not worker_lease:
            raise ValueError('MeshAnything shared GPU resource reservation required')
        cfg = request.get('adapterConfig') or {}
        if request.get('adapterId', 'meshanything-v2-local') != 'meshanything-v2-local':
            raise ValueError('Unsupported AI adapter')
        exe = Path(cfg.get('pythonExecutable', ''))
        if not exe.is_absolute() or not exe.is_file():
            raise ValueError('Configured absolute MeshAnything pythonExecutable is required')
        seed = int(params.get('seed', AI_LOWPOLY_DEFAULTS['seed']))
        if not 0 <= seed <= 2**32 - 1:
            raise ValueError('seed outside uint32 range')
        input_seed = int(params.get('inputSeed', AI_LOWPOLY_DEFAULTS['inputSeed']))
        if not 0 <= input_seed <= 2**32 - 1:
            raise ValueError('inputSeed outside uint32 range')
        reqpath = out / 'ai_request.json'
        reqpath.write_text(json.dumps(request), encoding='utf-8')
        metadata['mc'] = prepare_official_mc(mesh, cfg, reqpath, out, input_seed, params)
        source_mesh = mesh
        run_owned_worker(exe, 'native3d_meshanything.py', reqpath, out, worker_lease=worker_lease)
        data = np.load(out / 'ai_output.npz', allow_pickle=False)
        raw_count = len(data['faces'])
        mesh = trimesh.Trimesh(data['vertices'], data['faces'], process=True)
        mesh.update_faces(mesh.unique_faces()); mesh.update_faces(mesh.nondegenerate_faces()); mesh.remove_unreferenced_vertices()
        if not len(mesh.faces):
            raise ValueError('AI cleanup left an empty mesh')
        metadata['ai'] = json.loads((out / 'ai_receipt.json').read_text(encoding='utf-8'))
        metadata['ai']['inputSeed'] = input_seed
        mesh, metadata['windingRepair'] = repair_winding(mesh, reference=source_mesh)
        cleanup = {'rawTriangles': raw_count, 'cleanTriangles': len(mesh.faces),
                   'removedFraction': 1 - len(mesh.faces) / max(raw_count, 1)}
        ai_quality = ai_shape_gate(source_mesh, mesh, cleanup)
        (out / 'ai_quality.json').write_text(json.dumps(ai_quality, indent=2), encoding='utf-8')
        if ai_quality['rejectionReasons']:
            raise ValueError('AI geometry rejected: ' + '; '.join(ai_quality['rejectionReasons']))
        metadata['aiQuality'] = ai_quality
        if 'targetFaces' in params:
            target = int(params['targetFaces'])
            if not 4 <= target <= 100000:
                raise ValueError('targetFaces outside4..100000')
            before = len(mesh.faces); mesh = simplify(mesh, target)
            metadata['postSimplification'] = {'backend': 'fast_simplification', 'before': before, 'actual': len(mesh.faces), 'requested': target}
            final_gate = ai_shape_gate(source_mesh, mesh, {'rawTriangles': len(mesh.faces), 'cleanTriangles': len(mesh.faces), 'removedFraction': 0})
            metadata['postSimplification']['quality'] = final_gate
            if final_gate['rejectionReasons']:
                (out / 'ai_quality.json').write_text(json.dumps(final_gate, indent=2), encoding='utf-8')
                raise ValueError('Post-simplification geometry rejected: ' + '; '.join(final_gate['rejectionReasons']))
        warnings += ['Official MC256 unsigned shell changes open-surface thickness. Canonical coordinates preserve FP16 offset safety; backend remains experimental. targetFaces is optional post-simplification, not AI topology control.']
    elif operation == 'source_lod':
        from native3d_lod_source import run_source_lod
        if params.get('localRepairJobId'):
            from native3d_lod_repair import run_local_repair
            context=request['sourceLodLocalRepair']
            candidate_path=Path(context['candidatePath']);high_path=Path(request['highSourcePath'])
            if hashlib.sha256(candidate_path.read_bytes()).hexdigest()!=context['candidateFileSha256'] or hashlib.sha256(high_path.read_bytes()).hexdigest()!=context['originalSourceSha256']:
                raise ValueError('Local repair frozen input changed')
            mesh, metadata['geometry'], artifacts = run_local_repair(read_mesh(candidate_path), read_mesh(high_path), out, params, context, progress)
        elif params.get('retryJobId'):
            from native3d_lod_retry import run_retry
            high_path=Path(request['highSourcePath'])
            if hashlib.sha256(high_path.read_bytes()).hexdigest()!=request['source']['highSha256']:
                raise ValueError('Retry high source snapshot changed')
            mesh, metadata['geometry'], artifacts = run_retry(mesh, read_mesh(high_path), out,
                params, request['sourceLodRetry'], progress)
        else:
            mesh, metadata['geometry'], artifacts = run_source_lod(mesh, out,
                {**params, 'sourceFileSha256':metadata['sourceSha256']}, progress=progress)
        for artifact in artifacts:
            path=Path(artifact['path'])
            if artifact.get('role')=='export' and path.suffix=='.glb':
                files.append({'name':path.name,'role':'export','mime':'model/gltf-binary'})
        warnings = ['Source-high progressive CPU simplification; geometry-only output requires UV and material transfer. Nanite uses the same LOD0 asset; UE build has not been performed.']
        if metadata['geometry'].get('chainStatus')=='blocked':
            warnings.append(('部分LOD未完成：当前选用档已通过。' if metadata['geometry'].get('status')=='accepted' else '本次LOD未通过检查，仅供诊断。')+str(metadata['geometry'].get('chainBlocker','')))
        if metadata['geometry'].get('status')!='accepted':
            warnings.append('GEOMETRY BLOCKED: '+str(metadata['geometry'].get('blocker','required audit not accepted')))
    elif operation == 'uv_plan':
        from native3d_uv_plan import build_plan
        high_path=Path(request.get('highSourcePath',''))
        if not high_path.is_file():raise ValueError('UV plan requires original high source')
        memory_gate(max(512*1024**2, high_path.stat().st_size*8+len(mesh.faces)*800))
        high=read_mesh(high_path)
        metadata['highSourceSha256']=hashlib.sha256(high_path.read_bytes()).hexdigest()
        if request.get('source',{}).get('highSha256') not in (None,metadata['highSourceSha256']):
            raise ValueError('High source snapshot SHA256 changed')
        planned=build_plan(mesh,high,out,{k:v for k,v in params.items() if k!='externalGeometryReviewed'},
            low_sha256=metadata['sourceSha256'],high_sha256=metadata['highSourceSha256'],
            config=request.get('partfieldConfig',{}),progress=progress,worker_lease=worker_lease)
        metadata.update(planned['metadata'])
        metadata['wallSeconds']=time.monotonic()-started
        report={'metadata':metadata,'quality':{'status':'needs_review','unwrapExecuted':False},
                'warnings':warnings+planned['plan'].get('limitations',[])}
        (out/'report.json').write_text(compact_json(report),encoding='utf-8')
        result={**report,'files':planned['files']+[{'name':'report.json','role':'report','mime':'application/json'}]}
        temporary=out/'result.tmp'
        temporary.write_text(compact_json(result),encoding='utf-8');temporary.replace(out/'result.json')
        return result
    elif operation == 'repair_lod':
        from native3d_geometry import process
        high_path = Path(request.get('highSourcePath', ''))
        if high_path.is_file():
            memory_gate(max(512 * 1024**2, high_path.stat().st_size * 8 + len(mesh.faces) * 400))
        high = read_mesh(high_path)
        metadata['highSourceSha256'] = hashlib.sha256(high_path.read_bytes()).hexdigest()
        if len(mesh.faces) > 10000:
            raise ValueError('Exact repair/LOD audit is bounded to 10000 candidate triangles; source high remains reference only')
        progress('repair_fit_progressive_lod', 15)
        mesh, metadata['geometry'], stage_files = process(mesh, high, out, params)
        for artifact in stage_files:
            path = Path(artifact['path'])
            if artifact['role'] == 'export' and path.suffix == '.glb':
                files.append({'name': path.name, 'role': 'export', 'mime': 'model/gltf-binary'})
        from native3d_report import render_report
        stage_titles = [('raw_ai', 'AI原始候选'), ('repair', '局部修复'), ('orientation', '朝向校正'), ('fit', '受约束贴合')]
        stage_titles += [('lod_' + str(params.get('lod'+str(i), budget)), 'LOD ' + str(params.get('lod'+str(i), budget))) for i, budget in enumerate((1200, 800, 500, 300), 1)]
        existing = {entry['stage']: entry for entry in metadata['geometry'].get('stages', [])}
        views = []
        for stage_id, title in stage_titles:
            entry = existing.get(stage_id)
            stage_mesh = read_mesh(out / entry['filename']) if entry else None
            status = 'candidate' if entry else 'not_run'
            metrics = {'阶段': '真实已执行' if entry else '上游未通过，未执行'}
            if entry and metadata['geometry']['status'] == 'blocked' and entry is metadata['geometry']['stages'][-1]:
                status = 'blocked'
                metrics['未通过'] = metadata['geometry'].get('blocker', '几何检查未通过')
            views.append({'name': title, 'mesh': stage_mesh, 'status': status, 'metrics': metrics})
        metadata['comparison'] = render_report(high, views, out / 'comparison.png')
        files.append({'name': 'comparison.png', 'role': 'export', 'mime': 'image/png'})
        if metadata['geometry']['status'] != 'accepted':
            warnings.append('GEOMETRY BLOCKED: ' + metadata['geometry'].get('blocker', 'Required geometry checks not accepted') + '; diagnostic result only, no formal UV or bake.')
    elif operation == 'uv':
        uv_face_limit = 120000 if request.get('uvPlanPath') else 20000
        if len(mesh.faces) > uv_face_limit:
            raise ValueError('UV pilot limit is'+str(uv_face_limit)+' triangles; simplify first')
        resolution = int(params.get('resolution', 2048))
        if resolution not in (1024, 2048, 4096):
            raise ValueError('UV resolution must be1024,2048 or4096')
        progress('unwrap', 25)
        from native3d_uv import unwrap as structural_unwrap
        materials = mesh.metadata.get('nativeMaterials', [])
        if any(m.get('normalTexture') or m.get('occlusionTexture') or m.get('pbrMetallicRoughness', {}).get('baseColorTexture') or m.get('pbrMetallicRoughness', {}).get('metallicRoughnessTexture') for m in materials):
            raise ValueError('Re-unwrapping textured material requires a verified source transfer; original UV must remain intact')
        reference = None
        if params.get('seamStrategy') == 'ao_geometry' and request.get('highSourcePath'):
            high_path = Path(request['highSourcePath'])
            memory_gate(max(512 * 1024**2, high_path.stat().st_size * 8 + len(mesh.faces) * 400))
            reference = read_mesh(high_path)
            metadata['highSourceSha256'] = hashlib.sha256(high_path.read_bytes()).hexdigest()
        labels = None
        high_guided_evidence = None
        if params.get('highGuidedEvidence'):
            if metadata['sourceSha256'] != request['source'].get('sha256'):
                raise ValueError('High-guided target snapshot SHA256 mismatch')
            if params.get('seamStrategy') != 'coherent' or params.get('segmentationEvidence'):
                raise ValueError('High-guided UV requires coherent strategy and no conflicting segmentation evidence')
            high_path = Path(request.get('highSourcePath', ''))
            if not high_path.is_file():
                raise ValueError('High-guided UV requires the original high source snapshot')
            high_digest = hashlib.sha256()
            with high_path.open('rb') as stream:
                while chunk := stream.read(1024 * 1024): high_digest.update(chunk)
            metadata['highSourceSha256'] = high_digest.hexdigest()
            if metadata['highSourceSha256'] != request['source'].get('highSha256'):
                raise ValueError('High-guided source snapshot SHA256 mismatch')
            from native3d_uv_evidence import read_high_guided_evidence
            high_guided_evidence, receipt = read_high_guided_evidence(params['highGuidedEvidence'], metadata['sourceSha256'], metadata['highSourceSha256'], len(mesh.faces))
            metadata['highGuidedEvidence'] = receipt
        if params.get('segmentationEvidence'):
            from native3d_uv_evidence import read_face_labels
            labels, evidence = read_face_labels(params['segmentationEvidence'], request['source']['sha256'], len(mesh.faces))
            metadata['segmentation'] = evidence
        if request.get('uvPlanPath'):
            from native3d_uv_plan import load_plan, unwrap_plan, DEFAULTS
            high_path=Path(request.get('highSourcePath',''))
            if not high_path.is_file():raise ValueError('Frozen UV plan requires original high snapshot')
            metadata['highSourceSha256']=hashlib.sha256(high_path.read_bytes()).hexdigest()
            plan=load_plan(request['uvPlanPath'],low_sha256=metadata['sourceSha256'],
                           high_sha256=metadata['highSourceSha256'],plan_sha256=params['planSha256'])
            for key in set(params) & set(plan['settings']):
                if params[key]!=plan['settings'].get(key):raise ValueError('UV_PLAN_STALE: '+key+' changed')
            mesh,metadata['uv']=unwrap_plan(mesh,plan,output=out,progress=uv_progress_callback(),
                checkpoint_root=out.parent.parent/'uv-stage-cache')
            if metadata['uv'].get('stretchPolicy'):
                warnings.append('Experimental UV stretch policy experimental-stretch-review-v1: stretch is warning-only; visual review required. Warning islands: '+str(metadata['uv'].get('stretchWarningIslandCount',0)))
            metadata['uvPlan']={'planSha256':plan['planSha256'],'planJobId':params['planJobId'],'confirmed':True}
        elif params.get('annularSeamPlan'):
            from native3d_uv_annular import build_annular_plan
            from native3d_uv_coherent import coherent_unwrap
            plan, receipt = build_annular_plan(mesh, params['annularSeamPlan'], metadata['sourceSha256'])
            mesh, metadata['uv'] = coherent_unwrap(mesh, {**params, 'diagnosticsDirectory': str(out)},
                                                  _frozen_plan=plan, progress=uv_progress_callback())
            metadata['uv']['annularSeams'] = receipt
        else:
            mesh, metadata['uv'] = structural_unwrap(mesh, {**params, 'diagnosticsDirectory': str(out)}, reference_mesh=reference, face_labels=labels, high_guided_evidence=high_guided_evidence)
        for name in ('uv-layout.png', 'uv-checker.png', 'ao-view.png', 'seam-view.png'):
            if not (out / name).is_file(): continue
            files.append({'name': name, 'role': 'export', 'mime': 'image/png'})
    elif operation == 'bake':
        high_path = Path(request.get('highSourcePath', ''))
        if high_path.is_file():
            memory_gate(max(512 * 1024**2, high_path.stat().st_size * 8 + len(mesh.faces) * 400))
        high = read_mesh(high_path)
        metadata['highSourceSha256'] = hashlib.sha256(Path(request['highSourcePath']).read_bytes()).hexdigest()
        metadata['ramGate'] = memory_gate(max(512 * 1024**2, (len(high.faces) + len(mesh.faces)) * 400 + params['resolution']**2 * 64))
        if len(mesh.faces) > 120000:
            raise ValueError('Bake low mesh pilot limit is120000 triangles')
        if request.get('bakePaddingReuse'):
            from native3d_bake_padding import derive_padding
            if metadata['sourceSha256']!=request['source']['sha256'] or metadata['highSourceSha256']!=request['source']['highSha256']:
                raise ValueError('Padding reuse input snapshot changed')
            progress('bake_padding_only',25)
            metadata['bake']=derive_padding(request['bakePaddingReuse'],request,out)
            mesh=read_mesh((out/'model.glb').resolve())
        else:
            progress('project_and_bake', 25)
            metadata['bake'] = bake(mesh, high, out, params, progress_callback=progress)
        from native3d_material_atlas import BAKE_TEXTURES
        for name in BAKE_TEXTURES:
            if name == 'curvature' and not (out/'curvature.png').is_file():
                continue
            files.append({'name': name + '.png', 'role': 'texture', 'mime': 'image/png'})
        if (out / 'edge-wear.png').is_file():
            files.append({'name': 'edge-wear.png', 'role': 'texture', 'mime': 'image/png'})
        warnings += ['Normal uses2x2 directional-cage high barycentric samples; tangent basis: '+metadata['bake']['tangentBasis']+'. Projection preserves primary finite cage hits; unresolved samples use bounded k32 external-visible candidate first-hit certification, retrying k64 only for still-unresolved samples. Candidate search is not globally optimal; remaining covered misses stay neutral/white and require review. AO uses deterministic cosine Hammersley rays in the actual high geometric-normal hemisphere; radius is independent of cage, while origin epsilon remains cage-linked. '+str(metadata['bake']['padding'])+'px dilation only outside island coverage. PBR channels report original textures or scalar factors.']
        warnings += list(metadata['bake'].get('textureQuality', {}).get('warnings') or [])
        for name in metadata['bake'].get('sharedLods', {}).get('files') or []:
            files.append({'name': name, 'role': 'export', 'mime': 'model/gltf-binary'})
    # Detect report type/size errors before spending time rendering and exporting.
    uv_quality = quality(mesh) if operation=='uv' else None
    if operation=='uv':
        preflight = compact_json({'metadata':metadata,'quality':uv_quality,'warnings':warnings})
        if len(preflight.encode('utf-8')) > 4*1024**2:
            raise ValueError('Native3D report exceeds delivery budget before export')
    progress('export_preview', 85)
    proxy = simplify(mesh, 100000)
    poster(proxy, out / 'poster.png')
    # read_mesh has already checked static self-contained GLB restrictions.
    # For bounded analyze imports, keep attributes/materials/node transforms
    # verbatim: Trimesh round-tripping can silently discard standard TANGENT.
    # The proxy simplifier works on split UV vertices and can open seams. Use
    # the verified original for moderately sized textured imports.
    see_original = len(mesh.faces) <= 120000 or (
        len(mesh.faces) <= 300000 and source.stat().st_size <= 32 * 1024**2
    )
    preserve_glb = operation == 'analyze' and source.suffix.lower() == '.glb' and see_original
    if operation == 'material_wear':
        metadata['glbPreservation'] = metadata['materialWear']['glbPreservation']
    elif operation=='bake' and request.get('bakePaddingReuse'):
        # derive_padding already preserves every original geometry/UV/NORMAL/TANGENT buffer byte.
        # A Trimesh round-trip here would discard the original standard TANGENT.
        metadata['glbPreservation']={'mode':'padding_images_only','geometryAttributesBytePreserved':True}
    elif preserve_glb:
        shutil.copyfile(source, out / 'proxy.glb')
        shutil.copyfile(source, out / 'model.glb')
        metadata['glbPreservation'] = {
            'mode': 'source_bytes', 'bytePreserved': True,
            'reason': 'validated static self-contained GLB within original preview budget',
            'sourceSha256': metadata['sourceSha256'],
            'preserved': ['geometry', 'UV', 'NORMAL', 'TANGENT', 'materials', 'node transforms']}
        metadata['sourceTransform'] = 'analysis/poster use world geometry; output GLB preserves original node transforms for browser application'
    else:
        export_glb(proxy, out / 'proxy.glb')
        # Heavy analyze inputs retain the bounded browser proxy behavior.
        export_mesh = proxy if operation == 'analyze' else mesh
        export_glb(export_mesh, out / 'model.glb')
    from native3d_fbx import capabilities as fbx_capabilities, export_fbx
    if fbx_capabilities().get('available'):
        try:
            # Bake/wear deliver PBR through the GLB and named texture sidecars.
            # Their FBX explicitly delivers geometry, UVs and normals only.
            material_stage = operation in ('bake', 'material_wear')
            filename = 'model.geometry-only.fbx' if material_stage else 'model.fbx'
            policy = 'geometry_only' if material_stage else 'reject_lossy'
            metadata['fbxExport'] = export_fbx(out / 'model.glb', out / filename, material_policy=policy)
            files.append({'name': filename, 'role': 'export', 'mime': 'application/octet-stream'})
        except (ValueError, RuntimeError) as exc:
            metadata['fbxExport'] = {'status': 'unsupported', 'reason': str(exc)}
            warnings.append('FBX export not delivered: ' + str(exc))
    metadata['wallSeconds'] = time.monotonic() - started
    report = {'metadata': metadata, 'quality': uv_quality if uv_quality is not None else quality(mesh), 'warnings': warnings}
    (out / 'report.json').write_text(compact_json(report), encoding='utf-8')
    files += [{'name': 'model.glb', 'role': 'model', 'mime': 'model/gltf-binary'},
              {'name': 'proxy.glb', 'role': 'proxy', 'mime': 'model/gltf-binary'},
              {'name': 'poster.png', 'role': 'poster', 'mime': 'image/png'},
              {'name': 'report.json', 'role': 'report', 'mime': 'application/json'}]
    result = {**report, 'files': files}
    temporary = out / 'result.tmp'
    temporary.write_text(compact_json(result), encoding='utf-8')
    temporary.replace(out / 'result.json')
    progress('complete', 100)
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--request', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    try:
        from gpu_lease import WORKER_LEASE_ENV, adopt_worker_lease
        worker_lease = os.environ.get(WORKER_LEASE_ENV)
        adopt_worker_lease()
        run(json.loads(Path(args.request).read_text(encoding='utf-8-sig')), args.output, worker_lease=worker_lease)
    except Exception as exc:
        print(json.dumps({'stage': 'failed', 'error': str(exc)}), file=sys.stderr, flush=True)
        raise SystemExit(1)
