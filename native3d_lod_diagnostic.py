"""Read-only rejected LOD location board; all overlays labelled as X-ray guides."""
import numpy as np
from PIL import Image,ImageDraw
from native3d_report import rasterize,project_vertices,_font,BG


def render_diagnostic(mesh,evidence):
    pairs=evidence.get('intersection_pairs',[])
    if evidence.get('triangles')!=len(mesh.faces) or not 1<=len(mesh.faces)<=100000:
        raise ValueError('Diagnostic triangle identity/budget mismatch')
    if not isinstance(pairs,list) or len(pairs)>64:
        raise ValueError('Invalid diagnostic pairs')
    for pair in pairs:
        if not isinstance(pair,list) or len(pair)!=2 or any(type(f) is not int or not 0<=f<len(mesh.faces) for f in pair):
            raise ValueError('Invalid diagnostic triangle index')
    board=Image.new('RGB',(1600,1200),BG);draw=ImageDraw.Draw(board)
    draw.text((30,18),f"{str(evidence.get('stage','LOD')).upper()} · {len(mesh.faces)}面 · 自交诊断（未通过）",font=_font(32),fill='white')
    if not pairs:
        draw.text((30,100),'该阶段未记录三角形相交对；请查看原检查报告。',font=_font(24),fill='white')
        return board
    pairs=pairs[:2];vertices=np.asarray(mesh.vertices);faces=np.asarray(mesh.faces)
    focus=vertices[faces[np.unique(pairs)]].reshape(-1,3)
    toward=focus.mean(0)-np.asarray(mesh.bounds).mean(0)
    if np.linalg.norm(toward)<1e-9:toward=np.array([0.,0.,1.])
    toward/=np.linalg.norm(toward)
    up=np.array([0.,1.,0.])
    if abs(up@toward)>.95:up=np.array([0.,0.,1.])
    right=np.cross(up,toward);right/=np.linalg.norm(right);up=np.cross(toward,right)
    def camera(points,width,height):
        center=points.mean(0);projected=np.column_stack(((points-center)@right,(points-center)@up))
        extent=np.maximum(np.ptp(projected,axis=0),1e-7)
        return {'center':center,'right':right,'up':up,'toward':toward,'width':width,'height':height,
                'scale':.78*min(width/extent[0],height/extent[1])}
    def tile(cam,ids):
        im=rasterize(mesh,cam,smooth=True,max_faces=100000).convert('RGBA')
        overlay=Image.new('RGBA',im.size);d=ImageDraw.Draw(overlay);p=project_vertices(vertices,cam)
        colors=[(255,85,85,95),(255,200,40,95),(70,210,255,95)]
        for i,f in enumerate(ids):
            xy=[tuple(v) for v in p[faces[f],:2]]
            d.polygon(xy,fill=colors[i%3],outline=colors[i%3][:3]+(255,),width=3)
        return Image.alpha_composite(im,overlay).convert('RGB'),p
    whole,p=tile(camera(vertices,760,950),np.unique(pairs));board.paste(whole,(20,90))
    draw=ImageDraw.Draw(board)
    for i,pair in enumerate(pairs):
        q=p[faces[pair].reshape(-1),:2].mean(0)+[20,90]
        if i == 0:
            draw.ellipse((q[0]-25,q[1]-25,q[0]+25,q[1]+25),outline='white',width=3)
            draw.text((q[0]+30,q[1]-22),'问题区域',font=_font(23),fill='white')
        points=vertices[faces[pair]].reshape(-1,3)
        detail,_=tile(camera(points,760,410),pair);y=110+i*490;board.paste(detail,(820,y))
        draw=ImageDraw.Draw(board)
        draw.text((820,y-35),f'{i+1} · 面 {pair[0]} / {pair[1]} · 局部放大',font=_font(23),fill='white')
    draw.text((30,1080),'彩色面：检查发现互相穿插的三角面；左侧标位置，右侧看局部。',font=_font(24),fill='white')
    draw.text((30,1120),'彩色为穿透定位叠加，不代表表面可见性；未修改模型或修补错误。',font=_font(22),fill=(190,200,215))
    suffix='检查发现问题后提前停止，不代表仅有这些错误。' if not evidence.get('intersectionComplete') else '完整检查结果，未自动修复。'
    draw.text((30,1155),suffix,font=_font(22),fill=(255,190,95))
    return board
