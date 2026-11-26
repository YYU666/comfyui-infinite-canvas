"""Bounded CPU stage comparison: real triangle depth, shared source camera.

Report rendering never modifies a mesh, a project, or a generation queue.
An explicitly labelled simplified display proxy may be used for dense meshes;
all reported triangle measurements describe the actual input mesh.
"""
from functools import lru_cache
from pathlib import Path
import math

import numpy as np
from PIL import Image, ImageDraw, ImageFont

MAX_INPUT_FACES = 3_000_000
MAX_DISPLAY_FACES = 20_000
MAX_COLUMNS = 12
BG = (24, 29, 39)
DEFAULT_CREASE_ANGLE = 45.0


def shading_normals(mesh, *, corner_normals=None, vertex_normals=None,
                    crease_angle=DEFAULT_CREASE_ANGLE):
    """Return display-only corner normals and honest provenance.

    Explicit corner normals take precedence over vertex normals. For trimesh,
    inspect stored attributes/cache without requesting its auto-generated vertex
    normals property. Fallback groups join only manifold, indexed shared edges
    within the crease angle: coincident disconnected vertices remain split.
    """
    vertices, faces = _arrays(mesh)
    if len(faces) > MAX_DISPLAY_FACES:
        raise ValueError('Normal grouping requires a bounded display mesh')
    if not math.isfinite(crease_angle) or not 0 <= crease_angle < 180:
        raise ValueError('Invalid crease angle')
    if corner_normals is None:
        corner_normals = getattr(mesh, 'face_attributes', {}).get('corner_normals')
        if corner_normals is None:
            corner_normals = getattr(mesh, '__dict__', {}).get('corner_normals')
    source = 'supplied corner normals'
    if corner_normals is None:
        source = 'supplied vertex normals'
        if vertex_normals is None:
            vertex_normals = getattr(mesh, 'vertex_attributes', {}).get('normals')
        if vertex_normals is None:
            vertex_normals = getattr(mesh, '__dict__', {}).get('vertex_normals')
        if vertex_normals is None:
            cache = getattr(getattr(mesh, '_cache', None), 'cache', {})
            vertex_normals = cache.get('vertex_normals')
            source = 'stored vertex normals (authorship unverified)'
        if vertex_normals is not None:
            vertex_normals = np.asarray(vertex_normals, dtype=np.float64)
            if vertex_normals.shape != vertices.shape:
                raise ValueError('Invalid supplied vertex normals')
            corner_normals = vertex_normals[faces]
    if corner_normals is not None:
        normals = np.array(corner_normals, dtype=np.float64, copy=True)
        if normals.shape != (len(faces), 3, 3):
            raise ValueError('Invalid supplied corner normals')
        lengths = np.linalg.norm(normals, axis=-1)
        if normals.shape != (len(faces), 3, 3) or not np.isfinite(normals).all() or np.any(lengths <= 1e-12):
            raise ValueError('Invalid supplied corner normals')
        return normals / lengths[..., None], {'source': source}
    triangles = vertices[faces]
    weighted = np.cross(triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0])
    lengths = np.linalg.norm(weighted, axis=1)
    unit = weighted / np.maximum(lengths[:, None], 1e-30)
    parent = np.arange(len(faces) * 3)

    def root(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    edges = {}
    for fi, face in enumerate(faces):
        for a, b in ((0, 1), (1, 2), (2, 0)):
            edges.setdefault(tuple(sorted((int(face[a]), int(face[b])))), []).append((fi, a, b))
    cosine = math.cos(math.radians(crease_angle))
    for edge, incident in edges.items():
        if len(incident) != 2:
            continue
        (f, a, b), (g, c, d) = incident
        if lengths[f] <= 1e-12 or lengths[g] <= 1e-12 or unit[f] @ unit[g] < cosine - 1e-12:
            continue
        # Require consistent winding; never smooth across an inverted seam.
        if faces[f, a] != faces[g, d] or faces[f, b] != faces[g, c]:
            continue
        for first, second in ((3*f+a, 3*g+d), (3*f+b, 3*g+c)):
            parent[root(second)] = root(first)
    roots = np.array([root(i) for i in range(len(parent))])
    sums = np.zeros((len(parent), 3))
    np.add.at(sums, roots, np.repeat(weighted, 3, axis=0))
    normals = sums[roots].reshape((-1, 3, 3))
    normals /= np.maximum(np.linalg.norm(normals, axis=2, keepdims=True), 1e-30)
    return normals, {'source': 'angle-derived indexed edge groups', 'creaseAngleDegrees': float(crease_angle)}


@lru_cache(maxsize=12)
def _font(size):
    for path in ['C:/Windows/Fonts/msyh.ttc', 'C:/Windows/Fonts/simhei.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf']:
        if Path(path).is_file():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def _arrays(mesh):
    vertices = np.asarray(mesh.vertices, dtype=np.float64)
    faces = np.asarray(mesh.faces, dtype=np.int64)
    if vertices.ndim != 2 or vertices.shape[1] != 3 or faces.ndim != 2 or faces.shape[1] != 3:
        raise ValueError('Stage comparison requires triangle mesh arrays')
    if not 0 < len(faces) <= MAX_INPUT_FACES or not len(vertices) or not np.isfinite(vertices).all():
        raise ValueError('Stage comparison mesh is empty, nonfinite or exceeds bounded limit')
    if faces.min() < 0 or faces.max() >= len(vertices):
        raise ValueError('Invalid mesh indices')
    return vertices, faces


def camera_for_bounds(bounds, width, height, view='front'):
    """Fixed orthographic camera; only original high bounds determine framing."""
    bounds = np.asarray(bounds, dtype=np.float64)
    if bounds.shape != (2, 3) or not np.isfinite(bounds).all():
        raise ValueError('Invalid source bounds')
    extent = float(np.max(bounds[1] - bounds[0]))
    if not math.isfinite(extent) or extent <= 0 or np.any(bounds[1] < bounds[0]) or width < 16 or height < 16:
        raise ValueError('Invalid camera extent or dimensions')
    axes = {'front': ([1, 0, 0], [0, 1, 0], [0, 0, 1]),
            'side': ([0, 0, -1], [0, 1, 0], [1, 0, 0])}
    if view not in axes:
        raise ValueError('Unknown comparison view')
    right, up, toward = axes[view]
    return {'view': view, 'center': ((bounds[0] + bounds[1]) / 2).tolist(),
            'right': right, 'up': up, 'toward': toward,
            'scale': .84 * min(width, height) / extent,
            'width': int(width), 'height': int(height), 'sourceBounds': bounds.tolist()}


def project_vertices(vertices, camera):
    points = np.asarray(vertices, dtype=np.float64) - np.asarray(camera['center'])
    result = np.empty_like(points)
    result[:, 0] = points @ np.asarray(camera['right']) * camera['scale'] + camera['width'] / 2
    result[:, 1] = camera['height'] / 2 - points @ np.asarray(camera['up']) * camera['scale']
    result[:, 2] = points @ np.asarray(camera['toward'])
    return result


def rasterize(mesh, camera, *, return_buffers=False, smooth=False, max_faces=MAX_DISPLAY_FACES,
              corner_normals=None, vertex_normals=None, crease_angle=DEFAULT_CREASE_ANGLE):
    """Flat or interpolated-normal lit triangles; nearest wins each pixel.

    Surface depth is barycentrically interpolated, not painter-sorted. Camera
    depth increases toward the viewer; the largest value wins. No GPU/OpenGL.
    """
    vertices, faces = _arrays(mesh)
    if type(max_faces) is not int or not 1 <= max_faces <= 100000:
        raise ValueError('Invalid bounded rasterization face budget')
    if len(faces) > max_faces:
        raise ValueError('Use an explicitly labelled display proxy before rasterization')
    points = project_vertices(vertices, camera)
    if not np.isfinite(points).all():
        raise ValueError('Projected geometry is nonfinite')
    width, height = camera['width'], camera['height']
    pixels = np.full((height, width, 3), BG, dtype=np.uint8)
    depth = np.full((height, width), -np.inf, dtype=np.float64)
    owner = np.full((height, width), -1, dtype=np.int32)
    light = -.35 * np.asarray(camera['right']) + .7 * np.asarray(camera['up']) + np.asarray(camera['toward'])
    light /= np.linalg.norm(light)
    normals = shading_normals(mesh, corner_normals=corner_normals,
                              vertex_normals=vertex_normals, crease_angle=crease_angle)[0] if smooth else None
    for face_id, face in enumerate(faces):
        p = points[face]
        lower, upper = np.floor(p[:, :2].min(0)), np.ceil(p[:, :2].max(0))
        if (upper < 0).any() or (lower >= [width, height]).any():
            continue
        low = np.maximum(lower, 0).astype(int)
        high = np.minimum(upper, [width - 1, height - 1]).astype(int)
        if (high < low).any():
            continue
        a, b, c = p
        area = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1])
        if abs(area) < 1e-12:
            continue
        x, y = np.meshgrid(np.arange(low[0], high[0] + 1) + .5, np.arange(low[1], high[1] + 1) + .5)
        wa = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / area
        wb = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / area
        wc = 1 - wa - wb
        z = wa * a[2] + wb * b[2] + wc * c[2]
        region = np.s_[low[1]:high[1] + 1, low[0]:high[0] + 1]
        visible = (wa >= -1e-10) & (wb >= -1e-10) & (wc >= -1e-10) & (z > depth[region])
        if not visible.any():
            continue
        tri = vertices[face]
        normal = np.cross(tri[1] - tri[0], tri[2] - tri[0])
        length = np.linalg.norm(normal)
        diffuse = max(0., float(normal @ light / length)) if length else 0.
        if normals is None:
            color = np.clip(np.array([157, 189, 211]) * (.28 + .72 * diffuse), 0, 255).astype(np.uint8)
            pixels[region][visible] = color
        else:
            n = (wa[visible, None] * normals[face_id, 0] +
                 wb[visible, None] * normals[face_id, 1] +
                 wc[visible, None] * normals[face_id, 2])
            n /= np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-30)
            diffuse = np.maximum(0., n @ light)
            pixels[region][visible] = np.clip(np.array([157, 189, 211]) * (.28 + .72 * diffuse[:, None]), 0, 255).astype(np.uint8)
        depth[region][visible] = z[visible]
        owner[region][visible] = face_id
    image = Image.fromarray(pixels)
    return (image, depth, owner) if return_buffers else image


def _display_mesh(mesh):
    vertices, faces = _arrays(mesh)
    count = len(faces)
    if count <= MAX_DISPLAY_FACES:
        return mesh, {'triangles': count, 'displayTriangles': count, 'displayProxy': False}
    import trimesh
    import fast_simplification
    points, triangles = fast_simplification.simplify(vertices, faces, target_count=MAX_DISPLAY_FACES)
    proxy = trimesh.Trimesh(points, triangles, process=False)
    _arrays(proxy)
    if len(proxy.faces) > MAX_DISPLAY_FACES:
        raise ValueError('Display proxy exceeds triangle budget')
    return proxy, {'triangles': count, 'displayTriangles': len(proxy.faces), 'displayProxy': True}


def _text(draw, text, xy, width, *, fill=(220, 228, 236), size=16, max_lines=3):
    font = _font(size)
    lines, line = [], ''
    for char in str(text):
        if char == '\n' or draw.textlength(line + char, font=font) > width:
            lines.append(line)
            line = '' if char == '\n' else char
        else:
            line += char
    if line:
        lines.append(line)
    for i, value in enumerate(lines[:max_lines]):
        if i == max_lines - 1 and len(lines) > max_lines:
            value = value[:-1] + '…'
        draw.text((xy[0], xy[1] + i * (size + 5)), value, font=font, fill=fill)


def render_report(high, stages, output_png, *, title='原生3D · 同机位阶段对照', tile_width=224, render_height=278, smooth=True, crease_angle=DEFAULT_CREASE_ANGLE):
    """Render supplied real stages only; unavailable stages remain labelled text.

    stages: dicts with name, mesh (or None), status, metrics. The reference is
    always prepended. Mesh coordinates must already share the source frame;
    this renderer never aligns, fits or independently normalizes a stage.
    """
    if not isinstance(stages, (list, tuple)) or len(stages) + 1 > MAX_COLUMNS:
        raise ValueError('Comparison exceeds bounded column count')
    if not 160 <= tile_width <= 320 or not 160 <= render_height <= 400:
        raise ValueError('Comparison dimensions outside bounded limits')
    output_png = Path(output_png).resolve()
    if output_png.suffix.lower() != '.png':
        raise ValueError('Official comparison artifact must be PNG')
    audit_path = output_png.with_name(output_png.stem + '.audit.jpg')
    if output_png.exists() or audit_path.exists():
        raise ValueError('Comparison artifacts require new paths')
    source_vertices, _ = _arrays(high)
    bounds = np.array([source_vertices.min(0), source_vertices.max(0)])
    columns = [{'name': '高模参考', 'mesh': high, 'status': 'reference', 'metrics': {}}] + list(stages)
    header, col_header, metrics_height, label_width, gap = 88, 104, 104, 84, 12
    width = label_width + len(columns) * (tile_width + gap) + gap
    height = header + col_header + 2 * (render_height + gap) + metrics_height + 28
    report = Image.new('RGB', (width, height), (13, 17, 24))
    draw = ImageDraw.Draw(report)
    _text(draw, title, (18, 10), width - 36, size=24, max_lines=1)
    _text(draw, '统一原高模边界、世界坐标、正交比例与光照；正面 +Z / 侧面 +X，Y向上。仅结构预览，不证明UV或材质通过。', (18, 48), width - 36, size=15, max_lines=2)
    cameras = {view: camera_for_bounds(bounds, tile_width, render_height, view) for view in ['front', 'side']}
    records = []
    for i, stage in enumerate(columns):
        if not isinstance(stage, dict):
            raise ValueError('Invalid stage record')
        x = label_width + gap + i * (tile_width + gap)
        name, status, mesh = str(stage.get('name', '未命名阶段')), str(stage.get('status', 'available')), stage.get('mesh')
        record = {'name': name, 'status': status, 'rendered': False, 'metrics': stage.get('metrics') or {}}
        proxy = None
        if mesh is not None:
            try:
                proxy, measurements = _display_mesh(mesh)
                record.update(measurements)
                if smooth:
                    display_normals, record['shading'] = shading_normals(proxy, crease_angle=crease_angle)
                else:
                    display_normals, record['shading'] = None, {'source': 'flat face normals'}
                record['rendered'] = True
            except (ValueError, RuntimeError, ImportError) as exc:
                proxy = None
                record['renderError'] = str(exc)[:240]
                record['status'] = 'render_failed'
        _text(draw, name, (x + 6, header), tile_width - 12, size=19, max_lines=2)
        color = (248, 145, 127) if record['status'] in {'blocked', 'failed', 'render_failed'} else (141, 205, 178)
        count_text = f"实测 {record['triangles']:,} 三角面" if 'triangles' in record else '无可渲染模型'
        _text(draw, count_text + '\n' + record['status'], (x + 6, header + 50), tile_width - 12, size=14, fill=color, max_lines=2)
        for row, view in enumerate(['front', 'side']):
            y = header + col_header + row * (render_height + gap)
            if i == 0:
                _text(draw, '正面\n+Z' if row == 0 else '侧面\n+X', (12, y + render_height // 2 - 24), label_width - 12, size=18)
            draw.rounded_rectangle((x, y, x + tile_width, y + render_height), radius=7, fill=BG)
            if proxy is not None:
                image = rasterize(proxy, cameras[view], smooth=smooth, corner_normals=display_normals, crease_angle=crease_angle)
                report.paste(image, (x, y))
                shading_label = record['shading']['source']
                if 'creaseAngleDegrees' in record['shading']:
                    shading_label = f"角度分组平滑 {crease_angle:g}° / 保留锐边"
                _text(draw, shading_label, (x + 7, y + 7), tile_width - 14, size=11, max_lines=2)
                if record['displayProxy']:
                    _text(draw, f"显示代理 {record['displayTriangles']:,} 面", (x + 7, y + render_height - 27), tile_width - 14, size=13, fill=(249, 204, 125), max_lines=1)
                projected = project_vertices(np.asarray(proxy.vertices), cameras[view])
                clipped = np.any((projected[:, 0] < 0) | (projected[:, 0] >= tile_width) | (projected[:, 1] < 0) | (projected[:, 1] >= render_height))
                if clipped:
                    record.setdefault('clippedViews', []).append(view)
                    _text(draw, '超出统一视框', (x + 7, y + 7), tile_width - 14, size=13, fill=(250, 145, 127), max_lines=1)
            else:
                _text(draw, '未生成 / 不可用\n' + record['status'] + '\n' + str(record.get('renderError', '此列没有真实模型')), (x + 12, y + render_height // 2 - 42), tile_width - 24, size=16, fill=(186, 154, 145), max_lines=4)
        metric_y = header + col_header + 2 * (render_height + gap) + 5
        metrics = record['metrics']
        if isinstance(metrics, dict):
            text = '\n'.join(f'{k}: {v}' for k, v in list(metrics.items())[:4])
        else:
            text = str(metrics)
        _text(draw, text or '仅显示实际模型；验收依据见阶段报告', (x + 6, metric_y), tile_width - 12, size=13, max_lines=5)
        records.append(record)
    _text(draw, '结构阶段图 · 统一相机 · 缺失阶段保持空白状态 · 显示代理不替代原模型或几何验收', (18, height - 25), width - 36, size=13, fill=(142, 156, 174), max_lines=1)
    output_png.parent.mkdir(parents=True, exist_ok=True)
    report.save(output_png)
    audit = report.copy()
    audit.thumbnail((1280, 900), Image.Resampling.LANCZOS)
    audit.save(audit_path, quality=76, optimize=True)
    return {'png': str(output_png), 'auditJpeg': str(audit_path), 'size': [width, height],
            'cameras': cameras, 'sourceBounds': bounds.tolist(), 'columns': records,
            'renderer': 'CPU triangle z-buffer, orthographic, ' + ('smooth normal diffuse' if smooth else 'flat diffuse'),
            'materialValidation': False, 'uvValidation': False}
