"""Bounded static projection of actual geometry, with no interaction or scripts."""
from __future__ import annotations
import math
from pcg_geometry import validate_geometry, transform_point, cross, sub, unit


def render_preview_svg(value):
    validate_geometry(value)
    limit = 1800
    triangles, points = [], []
    total = 0
    kind = value['type']
    if kind == 'Mesh':
        total = len(value['triangles'])
        stride = max(1, math.ceil(total / limit))
        triangles = [[value['positions'][i] for i in face] for face in value['triangles'][::stride]]
    elif kind == 'PointSet':
        total = len(value['positions'])
        points = value['positions'][::max(1, math.ceil(total / limit))]
    else:
        mesh = value['prototype']
        total = len(mesh['triangles']) * len(value['instances'])
        stride = max(1, math.ceil(total / limit))
        face_count = len(mesh['triangles'])
        if face_count:
            for index in range(0, total, stride):
                instance = value['instances'][index // face_count]
                triangles.append([transform_point(mesh['positions'][i], instance['translation'], instance['rotation'], instance['scale']) for i in mesh['triangles'][index % face_count]])
    def project(p):
        return ((p[0]-p[2])*.70710678, -p[1]*.81649658+(p[0]+p[2])*.40824829, sum(p))
    projected = [project(p) for triangle in triangles for p in triangle] + [project(p) for p in points]
    if projected:
        lo = [min(p[i] for p in projected) for i in range(2)]
        hi = [max(p[i] for p in projected) for i in range(2)]
        scale = min(440/max(hi[0]-lo[0], 1e-8), 310/max(hi[1]-lo[1], 1e-8))
    else:
        lo, hi, scale = [0,0], [0,0], 1
    def xy(p):
        x,y,_ = project(p)
        return (256+(x-(hi[0]+lo[0])/2)*scale, 177+(y-(hi[1]+lo[1])/2)*scale)
    body = []
    for triangle in sorted(triangles, key=lambda t: sum(project(p)[2] for p in t)):
        normal = unit(cross(sub(triangle[1],triangle[0]), sub(triangle[2],triangle[0])))
        light = .35+.65*abs(sum(a*b for a,b in zip(normal,[.3,.8,.52])))
        color = f'rgb({int(70*light)},{int(165*light)},{int(220*light)})'
        coords = ' '.join(f'{x:.2f},{y:.2f}' for x,y in map(xy,triangle))
        body.append(f'<polygon points="{coords}" fill="{color}" stroke="#152a38" stroke-width=".4"/>')
    for point in points:
        x,y = xy(point)
        body.append(f'<circle cx="{x:.2f}" cy="{y:.2f}" r="2" fill="#72c6ed"/>')
    shown = len(triangles)+len(points)
    caption = f'{kind} | {shown}/{total}'+(' sampled preview' if shown < total else ' full preview')
    return ('<svg xmlns="http://www.w3.org/2000/svg" width="512" height="384" viewBox="0 0 512 384">'
            '<rect width="512" height="384" fill="#101c27"/>'+''.join(body)+
            f'<text x="12" y="372" fill="#d9e7ed" font-size="12">{caption}</text></svg>').encode('utf-8')
