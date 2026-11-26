"""Bounded CPU review renders from a trusted failed-job UV diagnostic NPZ.
Never unwraps, packs, bakes, changes source data, or certifies UV acceptance.
"""
from pathlib import Path
import json
import numpy as np
from PIL import Image,ImageDraw


def render_diagnostic(npz_path, output_directory, *, max_faces=100000, image_size=1920):
    if not 128<=image_size<=2048 or not 1<=max_faces<=100000:
        raise ValueError('Diagnostic budget exceeds 100k faces / 2048 pixels')
    with np.load(npz_path,allow_pickle=False) as data:
        vertices=data['vertices'].copy();faces=data['faces'].copy();uv=data['uv'].copy()
    if (vertices.ndim!=2 or vertices.shape[1]!=3 or faces.ndim!=2 or faces.shape[1]!=3 or
        not 1<=len(faces)<=max_faces or len(vertices)>3*max_faces or uv.shape!=(len(vertices),2) or
        not np.issubdtype(faces.dtype,np.integer) or faces.min()<0 or faces.max()>=len(vertices) or
        not np.isfinite(vertices).all() or not np.isfinite(uv).all()):
        raise ValueError('Invalid or over-budget diagnostic arrays')
    folder=Path(output_directory);folder.mkdir(parents=True,exist_ok=True)
    width=image_size;height=width*3//4;header=90;panel=width//2
    canvas=Image.new('RGB',(width,height),(23,27,33));draw=ImageDraw.Draw(canvas)
    report_path=folder/'uv-rejected-report.json'
    report=json.loads(report_path.read_text(encoding='utf-8')) if report_path.is_file() else {}
    draw.text((24,16),'REJECTED UV / REVIEW ONLY - saved overlap pairs: '+str(report.get('overlapPairs','unknown')),fill='white')
    draw.text((24,40),'Surface checker uses actual saved solver UV; not a bake or an accepted model.',fill=(245,190,90))
    draw.text((24,62),'Temporary per-island scale and layout; final packing / texel density not evaluated.',fill=(190,195,205))
    xyz=vertices-(vertices.min(axis=0)+vertices.max(axis=0))*.5
    tri=xyz[faces];normals=np.cross(tri[:,1]-tri[:,0],tri[:,2]-tri[:,0]);normals/=np.maximum(np.linalg.norm(normals,axis=1)[:,None],1e-30)
    for view,(horizontal,depth,label) in enumerate(((0,2,'FRONT (+Z)'),(2,0,'SIDE (+X)'))):
        h=height-header;w=panel
        extent=max(float(np.ptp(xyz[:,horizontal])),float(np.ptp(xyz[:,1]))*w/h)
        scale=.87*w/max(extent,1e-30)
        screen=np.column_stack((xyz[:,horizontal]*scale+w/2,-xyz[:,1]*scale+h/2))
        pixels=np.full((h,w,3),[32,37,44],dtype=np.uint8);zbuffer=np.full((h,w),-np.inf)
        light=np.array([.3,.6,.8]) if depth==2 else np.array([.8,.6,.3]);light/=np.linalg.norm(light)
        shade=.45+.55*np.abs(normals@light)
        for fi,face in enumerate(faces):
            points=screen[face];lo=np.maximum(np.floor(points.min(axis=0)).astype(int),0);hi=np.minimum(np.ceil(points.max(axis=0)).astype(int),[w-1,h-1])
            if np.any(hi<lo):continue
            a,b,c=points;det=(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0])
            if abs(det)<1e-12:continue
            yy,xx=np.mgrid[lo[1]:hi[1]+1,lo[0]:hi[0]+1];xx=xx+.5;yy=yy+.5
            beta=((xx-a[0])*(c[1]-a[1])-(yy-a[1])*(c[0]-a[0]))/det
            gamma=((b[0]-a[0])*(yy-a[1])-(b[1]-a[1])*(xx-a[0]))/det
            alpha=1-beta-gamma;inside=(alpha>=0)&(beta>=0)&(gamma>=0)
            z=alpha*xyz[face[0],depth]+beta*xyz[face[1],depth]+gamma*xyz[face[2],depth]
            region=zbuffer[lo[1]:hi[1]+1,lo[0]:hi[0]+1];visible=inside&(z>region)
            if not visible.any():continue
            tex=alpha[...,None]*uv[face[0]]+beta[...,None]*uv[face[1]]+gamma[...,None]*uv[face[2]]
            checks=(np.floor(tex[...,0]*12).astype(np.int64)+np.floor(tex[...,1]*12).astype(np.int64))%2
            color=np.where(checks[...,None]==0,np.array([225,225,218]),np.array([49,104,151]))*shade[fi]
            pixels[lo[1]:hi[1]+1,lo[0]:hi[0]+1][visible]=color[visible].astype(np.uint8);region[visible]=z[visible]
        canvas.paste(Image.fromarray(pixels),(view*panel,header));draw.text((view*panel+20,header+14),label,fill='white')
    checker=folder/'uv-rejected-checker.png';canvas.save(checker)
    # Existing per-chart grid is diagnostic, not a packed UV tile. Label it explicitly.
    source_layout=folder/'uv-rejected-layout.png'
    layout=Image.open(source_layout).convert('RGB') if source_layout.is_file() else None
    atlas=None
    if layout is not None:
        layout.thumbnail((image_size,image_size-80));atlas_image=Image.new('RGB',(image_size,image_size),(25,25,25))
        atlas_image.paste(layout,((image_size-layout.width)//2,80));ad=ImageDraw.Draw(atlas_image)
        ad.text((20,16),'REJECTED UV / TEMPORARY PER-ISLAND REVIEW GRID',fill=(255,200,90))
        ad.text((20,40),'Not final atlas packing. Utilization and padding are not acceptance results.',fill='white')
        atlas=folder/'uv-rejected-atlas.png';atlas_image.save(atlas)
    preview=folder/'uv-rejected-review.jpg';canvas.thumbnail((960,720));canvas.save(preview,quality=82)
    receipt={'status':'rejected_needs_review','acceptedUV':False,'bakeAllowed':False,'source':'actual saved diagnostic UV',
             'faces':len(faces),'vertices':len(vertices),'checkerFrequency':12,'checkerUVSpace':'saved temporary solver UV',
             'viewAxes':['front +Z, up +Y','side +X, up +Y'],'files':[checker.name]+([] if atlas is None else [atlas.name]),
             'preview':preview.name,'finalPacking':False}
    (folder/'uv-rejected-render.json').write_text(json.dumps(receipt,indent=2),encoding='utf-8')
    return receipt
