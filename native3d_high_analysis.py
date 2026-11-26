"""Bounded full-geometry CPU AO on fixed visible surface pixels; no UV/mesh edits.

Blocks are screen-space normal/depth connected regions, NOT 3D semantic parts.
"""
import argparse
from collections import deque
import hashlib
import json
from pathlib import Path
import time
import numpy as np


def file_sha(path):
    digest=hashlib.sha256()
    with Path(path).open('rb') as stream:
        while chunk:=stream.read(1024*1024): digest.update(chunk)
    return digest.hexdigest()


def hemisphere(count):
    u=(np.arange(count)+.5)/count; phi=np.arange(count)*np.pi*(3-np.sqrt(5))
    return np.column_stack((np.sqrt(u)*np.cos(phi),np.sqrt(u)*np.sin(phi),np.sqrt(1-u)))


def screen_blocks(normals, points, valid, diagonal, angle=80, sigma=3):
    """Connected visible samples; smoothed normals affect grouping only, never AO."""
    from scipy.ndimage import gaussian_filter
    denom=gaussian_filter(valid.astype(float),sigma)
    smooth=np.stack([gaussian_filter(np.where(valid,normals[:,:,i],0),sigma)/np.maximum(denom,1e-20) for i in range(3)],axis=2)
    smooth/=np.maximum(np.linalg.norm(smooth,axis=2)[:,:,None],1e-30)
    labels=np.full(valid.shape,-1,np.int32); height,width=valid.shape; sizes=[]
    threshold=np.cos(np.deg2rad(angle))
    for y,x in zip(*np.where(valid)):
        if labels[y,x]>=0: continue
        label=len(sizes);labels[y,x]=label;queue=deque([(y,x)]);size=0;seed=smooth[y,x]
        while queue:
            a,b=queue.popleft();size+=1
            for c,d in ((a-1,b),(a+1,b),(a,b-1),(a,b+1)):
                if (0<=c<height and 0<=d<width and valid[c,d] and labels[c,d]<0
                    and smooth[c,d]@seed>=threshold and smooth[c,d]@smooth[a,b]>=np.cos(np.deg2rad(35))
                    and np.linalg.norm(points[c,d]-points[a,b])<=diagonal*.015):
                    labels[c,d]=label;queue.append((c,d))
        sizes.append(size)
    return labels,sizes


def inspect(source, expected_sha, bounds, output, width=480,height=360,samples=32,radius=.08,angle=80):
    if not 16<=width<=640 or not 16<=height<=480 or not 8<=samples<=128 or not .01<=radius<=.3:
        raise ValueError('Sampling budget outside bounded limits')
    bounds=np.asarray(bounds,dtype=float)
    if bounds.shape!=(2,3) or not np.isfinite(bounds).all() or np.any(bounds[1]<bounds[0]):
        raise ValueError('Invalid fixed source camera bounds')
    import open3d as o3d
    import psutil
    from PIL import Image,ImageDraw
    from native3d_engine import read_mesh
    from native3d_report import camera_for_bounds, _font
    wall=time.perf_counter();cpu=time.process_time();timings={};output=Path(output);output.mkdir(parents=True,exist_ok=True)
    def checkpoint(name,start):
        timings[name]=time.perf_counter()-start
        if psutil.Process().memory_info().rss>8*1024**3 or time.perf_counter()-wall>180:
            raise RuntimeError('Bounded analysis exceeded8GiB RSS or180s')
    start=time.perf_counter()
    if file_sha(source)!=expected_sha:raise ValueError('Source SHA mismatch')
    mesh=read_mesh(Path(source).resolve());checkpoint('readAndHashSeconds',start)
    if not 1<=len(mesh.faces)<=3000000:raise ValueError('Full geometry triangle limit')
    if not np.isfinite(mesh.vertices).all():raise ValueError('Nonfinite source')
    source_vertices=len(mesh.vertices);source_faces=len(mesh.faces)
    vertices=np.asarray(mesh.vertices,dtype=np.float32);faces=np.asarray(mesh.faces,dtype=np.uint32)
    start=time.perf_counter();scene=o3d.t.geometry.RaycastingScene(nthreads=8)
    scene.add_triangles(o3d.core.Tensor(vertices),o3d.core.Tensor(faces))
    # Open3D builds lazily: force first ray into BVH timing.
    scene.cast_rays(o3d.core.Tensor(np.array([[0,0,1e6,0,0,-1]],np.float32)))
    checkpoint('bvhBuildSeconds',start)
    camera=camera_for_bounds(bounds,width,height,'front');diagonal=float(np.linalg.norm(np.asarray(bounds)[1]-np.asarray(bounds)[0]))
    yy,xx=np.indices((height,width));center=np.array(camera['center']);z=float(np.asarray(bounds)[1,2]+diagonal)
    origins=np.stack(((xx+.5-width/2)/camera['scale']+center[0],(height/2-yy-.5)/camera['scale']+center[1],np.full(xx.shape,z)),axis=2).astype(np.float32)
    rays=np.concatenate((origins,np.broadcast_to([0.,0.,-1.],origins.shape)),axis=2).astype(np.float32)
    start=time.perf_counter();hits=scene.cast_rays(o3d.core.Tensor(rays));distances=hits['t_hit'].numpy();valid=np.isfinite(distances)
    normals=hits['primitive_normals'].numpy().astype(float);points=origins.copy();points[:,:,2]-=np.where(valid,distances,0)
    checkpoint('surfaceRaySeconds',start)
    normals[~valid]=0;flat_normals=normals[valid];flat_points=points[valid];local=hemisphere(samples);dark=np.zeros(len(flat_points));start=time.perf_counter()
    for begin in range(0,len(flat_points),2048):
        n=flat_normals[begin:begin+2048];centers=flat_points[begin:begin+2048]
        axes=np.tile([0.,0.,1.],(len(n),1));axes[np.abs(n[:,2])>.9]=[0,1,0]
        tangent=np.cross(axes,n);tangent/=np.maximum(np.linalg.norm(tangent,axis=1)[:,None],1e-30);bitangent=np.cross(n,tangent)
        directions=local[None,:,0,None]*tangent[:,None]+local[None,:,1,None]*bitangent[:,None]+local[None,:,2,None]*n[:,None]
        ao_origins=np.broadcast_to((centers+n*diagonal*1e-5)[:,None],directions.shape)
        ao_rays=np.concatenate((ao_origins,directions),axis=2).reshape(-1,6).astype(np.float32)
        distance=scene.cast_rays(o3d.core.Tensor(ao_rays))['t_hit'].numpy().reshape(-1,samples)
        dark[begin:begin+len(n)]=np.mean((distance>diagonal*1e-6)&(distance<diagonal*radius),axis=1)
        if psutil.Process().memory_info().rss>8*1024**3 or time.perf_counter()-wall>180:raise RuntimeError('Analysis budget exceeded')
    checkpoint('aoSeconds',start);ao=np.zeros(valid.shape);ao[valid]=dark
    start=time.perf_counter();labels,sizes=screen_blocks(normals,points,valid,diagonal,angle);checkpoint('blocksSeconds',start)
    boundary=np.zeros(valid.shape,bool)
    boundary[1:]|=valid[1:]&valid[:-1]&(labels[1:]!=labels[:-1]);boundary[:,1:]|=valid[:,1:]&valid[:,:-1]&(labels[:,1:]!=labels[:,:-1])
    rng=np.random.default_rng(42);palette=rng.integers(55,230,size=(max(1,len(sizes)),3),dtype=np.uint8)
    gray=np.clip(225*(1-ao),0,255).astype(np.uint8)
    images={}
    for kind in ('ao','normals','blocks','boundaries'):
        pixels=np.full((height,width,3),(24,29,39),np.uint8)
        if kind=='ao':pixels[valid]=gray[valid,None]
        elif kind=='normals':pixels[valid]=np.clip((normals[valid]+1)*127.5,0,255).astype(np.uint8)
        else:
            pixels[valid]=palette[labels[valid]]
            if kind=='boundaries':pixels[boundary]=(255,110,40)
        # Presentation rescale only; source sampling resolution is declared.
        image=Image.fromarray(pixels).resize((1200,900),Image.Resampling.NEAREST);draw=ImageDraw.Draw(image)
        draw.rectangle((0,0,1200,66),fill=(24,29,39))
        title={'ao':'完整几何上的可见表面射线 AO（未平滑）','normals':'完整几何：可见表面原始法线','blocks':'可见表面块面：屏幕空间连通区域','boundaries':'可见表面块面边界（非UV切缝）'}[kind]
        draw.text((16,5),title,font=_font(22),fill=(240,240,240))
        draw.text((16,35),f'{source_faces:,}三角面 · {width}×{height}固定正面采样 · 每命中点{samples}射线 · 非全3D语义分割',font=_font(18),fill=(230,230,230))
        image.save(output/(kind+'.png'));images[kind]=str(output/(kind+'.png'))
    np.savez_compressed(output/'samples.npz',ao=ao,normal=normals,valid=valid,labels=labels,positions=points,depth=distances,primitive_ids=hits['primitive_ids'].numpy())
    checkpoint('totalSeconds',wall)
    report={'sourceSha256':expected_sha,'sourceTriangles':source_faces,'sourceVertices':source_vertices,'noGeometrySimplification':True,
        'camera':camera,'width':width,'height':height,'samplesPerHit':samples,'visibleSamples':len(dark),'aoRaysCast':len(dark)*samples,
        'radiusFraction':radius,'radiusWorld':radius*diagonal,'darknessMean':float(dark.mean()) if len(dark) else None,
        'blockCount':len(sizes),'blocksAtLeast16Pixels':sum(s>=16 for s in sizes),'blockLargestPixels':sorted(sizes,reverse=True)[:10],
        'blockNormalSigmaPixels':3,'blockSeedAngleDegrees':angle,'blockNeighborAngleDegrees':35,'maxDepthLinkFraction':.015,
        'timings':timings,'cpuSeconds':time.process_time()-cpu,'processPeakRssBytes':getattr(psutil.Process().memory_info(),'peak_wset',psutil.Process().memory_info().rss),'images':images,
        'limitations':['Visible front surface pixels only; hidden/back geometry still occludes AO rays.','Not full 3D or semantic segmentation; no PartField.','Normals aggregated only for block grouping; AO is not smoothed.','PNG nearest-neighbor enlargement from declared sampling grid.','Block boundaries are screen regions, not UV seam candidates.']}
    if file_sha(source)!=expected_sha:raise RuntimeError('Source changed during read-only analysis')
    (output/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    return report

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--source',required=True);p.add_argument('--sha',required=True);p.add_argument('--bounds',required=True);p.add_argument('--output',required=True)
    a=p.parse_args();inspect(a.source,a.sha,json.loads(Path(a.bounds).read_text(encoding='utf-8')),a.output)
