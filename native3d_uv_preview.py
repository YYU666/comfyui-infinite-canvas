"""Read-only CPU UV inspection of immutable successful job models."""
import argparse
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw
from native3d_report import _arrays, camera_for_bounds, project_vertices, rasterize, _font

SEAM = (255, 103, 43)
BOUNDARY = (48, 220, 235)


def uv_edges(mesh, *, max_faces=20000):
    vertices, faces = _arrays(mesh)
    uv = np.asarray(getattr(mesh.visual, 'uv', None), dtype=float)
    if type(max_faces) is not int or max_faces not in (20000,100000):
        raise ValueError('Invalid UV preview face budget')
    if not 1 <= len(faces) <= max_faces or uv.shape != (len(vertices), 2) or not np.isfinite(uv).all():
        raise ValueError(f'UV preview requires 1..{max_faces} triangles and finite vertex UVs')
    # Match geometric positions, not vertex indices: UV export duplicates vertices.
    groups = {}
    for face in faces:
        for i, j in ((0, 1), (1, 2), (2, 0)):
            a, b = int(face[i]), int(face[j])
            ka, kb = tuple(vertices[a]), tuple(vertices[b])
            if ka == kb: continue
            if ka > kb: a, b, ka, kb = b, a, kb, ka
            groups.setdefault((ka, kb), []).append((a, b))
    seams, boundaries = [], []
    for edges in groups.values():
        if len(edges) == 1: boundaries.append(edges[0])
        elif any(not np.allclose(uv[list(edges[0])], uv[list(edge)], atol=1e-6, rtol=0) for edge in edges[1:]):
            seams.append(edges[0])
    return uv, seams, boundaries


def render_mesh(mesh, mode, *, max_faces=20000):
    if mode not in ('seams', 'checker'): raise ValueError('Invalid UV preview mode')
    uv, seams, boundaries = uv_edges(mesh,max_faces=max_faces)
    vertices, faces = _arrays(mesh)
    camera = camera_for_bounds(mesh.bounds, 640, 480, 'front')
    image, depth, owner = rasterize(mesh, camera, return_buffers=True,max_faces=max_faces)
    pixels = np.asarray(image).copy()
    points = project_vertices(vertices, camera)
    if mode == 'checker':
        for face_id, face in enumerate(faces):
            projected = points[face, :2]
            lo = np.maximum(np.floor(projected.min(0)), 0).astype(int)
            hi = np.minimum(np.ceil(projected.max(0)), [639,479]).astype(int)
            if (hi < lo).any(): continue
            yy, xx = np.where(owner[lo[1]:hi[1]+1,lo[0]:hi[0]+1] == face_id)
            xx += lo[0]; yy += lo[1]
            if not len(xx): continue
            a, b, c = points[face]
            area = (b[1]-c[1])*(a[0]-c[0])+(c[0]-b[0])*(a[1]-c[1])
            if abs(area) < 1e-12: continue
            wa = ((b[1]-c[1])*(xx+.5-c[0])+(c[0]-b[0])*(yy+.5-c[1]))/area
            wb = ((c[1]-a[1])*(xx+.5-c[0])+(a[0]-c[0])*(yy+.5-c[1]))/area
            coords = wa[:,None]*uv[face[0]]+wb[:,None]*uv[face[1]]+(1-wa-wb)[:,None]*uv[face[2]]
            parity = np.mod(np.floor(coords*16).sum(axis=1), 2)
            normal = np.cross(vertices[face[1]]-vertices[face[0]],vertices[face[2]]-vertices[face[0]])
            length = np.linalg.norm(normal)
            shade = .65+.35*abs(normal[2]/length) if length else .65
            colors = np.where(parity[:,None] == 0, [225,225,225], [65,78,92])
            pixels[yy,xx] = (colors*shade).astype(np.uint8)
    else:
        # Preserve surface lighting so seams can be located on the actual shape.
        tolerance = max(float(np.ptp(vertices,axis=0).max())*1e-5, 1e-9)
        for edges, color in ((boundaries, BOUNDARY), (seams, SEAM)):
            for ai, bi in edges:
                a,b=points[[ai,bi]]
                count=max(2,int(np.linalg.norm(b[:2]-a[:2])*3)+1)
                samples=a+(b-a)*np.linspace(0,1,count)[:,None]
                for dx,dy in ((0,0),(-1,0),(1,0),(0,-1),(0,1)):
                    xx=np.floor(samples[:,0]).astype(int)+dx; yy=np.floor(samples[:,1]).astype(int)+dy
                    valid=(xx>=0)&(xx<640)&(yy>=0)&(yy<480)
                    xx,yy,z=xx[valid],yy[valid],samples[valid,2]
                    visible=(owner[yy,xx]>=0)&(z>=depth[yy,xx]-tolerance)
                    pixels[yy[visible],xx[visible]]=color
    image=Image.fromarray(pixels)
    draw=ImageDraw.Draw(image)
    draw.rectangle((0,0,640,28), fill=(24,29,39))
    draw.text((10,5), '固定正面 · 实际 UV 棋盘格 · 每 UV 单位16格' if mode=='checker' else f'固定正面 · 最终 UV 切缝 {len(seams)} 边段（橙）· 开口 {len(boundaries)} 边段（青）', font=_font(14), fill=(240,240,240))
    return image


def render_ao_mesh(mesh, evidence, mode, *, max_faces=20000):
    import hashlib
    vertices, faces = _arrays(mesh)
    if type(max_faces) is not int or max_faces not in (20000,100000) or not 1 <= len(faces) <= max_faces: raise ValueError('AO diagnostic triangle limit')
    geometry = hashlib.sha256(vertices.tobytes()+faces.tobytes()).hexdigest()
    if evidence.get('geometrySha256') != geometry: raise ValueError('AO source geometry does not match original computation')
    report=evidence.get('aoGeometry', {})
    darkness=np.asarray(report.get('faceDarkness'), dtype=np.float64)
    if darkness.shape!=(len(faces),) or not np.isfinite(darkness).all() or np.any((darkness<0)|(darkness>1)):
        raise ValueError('Missing valid original face AO signal; new UV task required')
    if hashlib.sha256(darkness.astype('<f8').tobytes()).hexdigest()!=report.get('darknessSha256'):
        raise ValueError('Original AO signal hash mismatch')
    camera=camera_for_bounds(mesh.bounds,640,480,'front')
    _,depth,owner=rasterize(mesh,camera,return_buffers=True,max_faces=max_faces)
    pixels=np.full((480,640,3),(24,29,39),np.uint8)
    visible=owner>=0
    shades=np.clip(225*(1-darkness[owner[visible]]),0,255).astype(np.uint8)
    pixels[visible]=shades[:,None]
    high_guided=report.get('backend')=='Open3D CPU high-surface samples projected to target'
    if high_guided:
        support=report.get('referenceSupportedFaces')
        if not isinstance(support,list) or len(support)!=len(faces) or any(type(x) is not bool for x in support):
            raise ValueError('High-surface AO requires exact target face support flags')
        pixels[visible & ~np.asarray(support,dtype=bool)[np.maximum(owner,0)]]=(110,115,125)
    if mode=='ao-seams':
        points=project_vertices(vertices,camera)
        tolerance=max(float(np.ptp(vertices,axis=0).max())*1e-5,1e-9)
        reasons=evidence.get('seamReasons')
        if not isinstance(reasons,dict) or len(reasons)>max_faces*3: raise ValueError('Missing bounded original cut reasons; new UV task required')
        actual_edges={tuple(edge) for edge in np.sort(np.asarray(mesh.edges),axis=1)}
        for key,reason in reasons.items():
            indices=[int(x) for x in key.split(':')]
            if len(indices)!=2 or tuple(sorted(indices)) not in actual_edges: raise ValueError('Invalid original cut edge')
            color=(255,103,43) if reason=='ao_supported_signed_concave' else (185,115,255) if reason in ('coarse_normal_block','high_surface_region_boundary') else (245,210,65)
            a,b=points[indices]; count=max(2,int(np.linalg.norm(b[:2]-a[:2])*3)+1)
            samples=a+(b-a)*np.linspace(0,1,count)[:,None]
            for dx,dy in ((0,0),(-1,0),(1,0),(0,-1),(0,1)):
                xx=np.floor(samples[:,0]).astype(int)+dx; yy=np.floor(samples[:,1]).astype(int)+dy
                inside=(xx>=0)&(xx<640)&(yy>=0)&(yy<480)
                xx,yy,z=xx[inside],yy[inside],samples[inside,2]
                show=(owner[yy,xx]>=0)&(z>=depth[yy,xx]-tolerance)
                pixels[yy[show],xx[show]]=color
    image=Image.fromarray(pixels); draw=ImageDraw.Draw(image)
    draw.rectangle((0,0,640,44),fill=(24,29,39))
    samples=report.get('raySamplesPerFace')
    sampling=f'{samples}射线' if isinstance(samples,int) else '原始射线'
    heading='高模 AO 映射证据 · 固定正面 · 灰色为无支持' if high_guided else f'本次计算的 AO · 每面1采样点/{sampling} · 固定正面'
    draw.text((8,3),heading,font=_font(14),fill=(240,240,240))
    reasons=evidence.get('seamReasons',{})
    ao_count=sum(reason=='ao_supported_signed_concave' for reason in reasons.values())
    coarse_count=sum(reason in ('coarse_normal_block','high_surface_region_boundary') for reason in reasons.values())
    other_count=len(reasons)-ao_count-coarse_count
    text='越暗表示局部遮挡越强 · 保留原始逐面采样，未平滑' if mode=='ao' else f'候选边段：橙 AO凹缝{ao_count} · 紫 块面边界{coarse_count} · 黄 辅助{other_count}（非岛数）'
    if high_guided and mode=='ao':text='外部高模采样/平滑/投射证据 · UV阶段不重算AO'
    draw.text((8,23),text,font=_font(13),fill=(240,240,240))
    return image


def render(source, target, mode, evidence=None, *, max_faces=20000):
    from native3d_engine import read_mesh
    mesh=read_mesh(Path(source))
    if mode in ('ao','ao-seams'):
        import json
        image=render_ao_mesh(mesh,json.loads(Path(evidence).read_text(encoding='utf-8')),mode,max_faces=max_faces)
    else: image=render_mesh(mesh,mode,max_faces=max_faces)
    target=Path(target); temporary=target.with_suffix('.tmp')
    image.save(temporary,format='PNG'); temporary.replace(target)

if __name__ == '__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--source',required=True); parser.add_argument('--output',required=True)
    parser.add_argument('--mode',required=True,choices=['seams','checker','ao','ao-seams'])
    parser.add_argument('--evidence')
    parser.add_argument('--max-faces',type=int,choices=[20000,100000],default=20000)
    args=parser.parse_args(); render(args.source,args.output,args.mode,args.evidence,max_faces=args.max_faces)
