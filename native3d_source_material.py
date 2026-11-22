"""Projected source material sampling in bounded batches, using glTF frames."""
import json
from pathlib import Path
import shutil
import subprocess
import numpy as np
from native3d_bake_basis import unit

MAX_SAMPLES = 4096


def source_basis(mesh):
    """Original source normals are shading data, never low-normal repair input."""
    faces = np.asarray(mesh.faces)
    normals = unit(mesh.vertex_normals)[faces]
    uv = np.asarray(mesh.visual.uv).copy(); uv[:, 1] = 1 - uv[:, 1]
    delta = uv[faces][:, 1:] - uv[faces][:, :1]
    degenerate = np.abs(np.linalg.det(delta)) < 1e-12
    node = shutil.which('node')
    if not node:
        raise RuntimeError('Native source MikkTSpace requires Node.js')
    # Full adjacency is retained for reference Mikk grouping. Binary transport
    # avoids tens of millions of boxed Python/JS floats and giant JSON strings.
    import tempfile
    module = (Path(__file__).resolve().parent / 'node_modules/three/examples/jsm/libs/mikktspace.module.js').as_uri()
    script = """
import fs from 'node:fs';
const {generateTangents}=await import(process.argv[1]);
function floats(path){const b=fs.readFileSync(path);return new Float32Array(b.buffer,b.byteOffset,b.byteLength/4);}
const t=generateTangents(floats(process.argv[2]),floats(process.argv[3]),floats(process.argv[4]));
for(let i=3;i<t.length;i+=4)t[i]*=-1;
fs.writeFileSync(process.argv[5],Buffer.from(t.buffer,t.byteOffset,t.byteLength));
"""
    with tempfile.TemporaryDirectory(prefix='native3d-source-mikk-') as temporary:
        root = Path(temporary)
        np.asarray(mesh.vertices)[faces].astype('<f4').tofile(root/'positions.bin')
        normals.astype('<f4').tofile(root/'normals.bin')
        uv[faces].astype('<f4').tofile(root/'uv.bin')
        result = subprocess.run([node, '--input-type=module', '-e', script, module,
            *[str(root/name) for name in ('positions.bin','normals.bin','uv.bin','tangents.bin')]],
            text=True, encoding='utf-8', capture_output=True, timeout=300,
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        if result.returncode:
            raise RuntimeError('Source MikkTSpace failed: ' + result.stderr.strip()[:2000])
        tangents = np.fromfile(root/'tangents.bin', dtype='<f4').reshape(*faces.shape, 4)
    usable = (~degenerate & np.isfinite(tangents).all(axis=(1,2)) &
        (np.abs(tangents[..., 3]) == 1).all(axis=1) &
        np.isclose(np.linalg.norm(tangents[..., :3],axis=-1),1,atol=2e-5).all(axis=1) &
        (np.abs(np.sum(normals*tangents[..., :3],axis=-1)) <= 2e-5).all(axis=1) &
        (tangents[...,3] == tangents[:,:1,3]).all(axis=1))
    invalid = np.flatnonzero(~usable)
    bounds = None if not len(invalid) else np.asarray(mesh.vertices)[faces[invalid]].reshape(-1,3)
    report = {'faces':len(faces),'degenerateUVFaces':int(degenerate.sum()),
        'invalidNormalFrameFaces':len(invalid),'invalidFaceIds':invalid.tolist(),
        'invalidRegionBounds':None if bounds is None else [bounds.min(0).tolist(),bounds.max(0).tolist()],
        'policy':'reference Mikk runs complete source adjacency; inherited degenerate frames remain invalid; no invented tangent or geometry-normal fallback',
        'transport':'binary float32 full-adjacency Mikk; no million-face JSON'}
    return {'faces': np.arange(faces.size).reshape(faces.shape),
            'normals': normals.reshape(-1, 3), 'tangents': tangents.reshape(-1, 4),
            'validFaces':usable,'report':report}


def srgb_decode(value):
    value = np.asarray(value, dtype=float)
    return np.where(value <= .04045, value / 12.92, ((value + .055) / 1.055) ** 2.4)


def bilinear(pixels, coords, srgb=False):
    """Trimesh local UV (bottom-left); decode BEFORE interpolation."""
    pixels = np.asarray(pixels)
    coords = np.asarray(coords, dtype=float)
    if not np.isfinite(coords).all():
        raise ValueError('Nonfinite source texture coordinates')
    output = np.empty((len(coords), pixels.shape[2]), dtype=float)
    h, w = pixels.shape[:2]
    for start in range(0, len(coords), MAX_SAMPLES):
        c = coords[start:start + MAX_SAMPLES]
        xy = np.column_stack([(c[:, 0] % 1) * w - .5, (1 - c[:, 1] % 1) * h - .5])
        ij = np.floor(xy).astype(np.int64); f = xy - ij
        x, y = ij[:, 0] % w, ij[:, 1] % h
        taps = [pixels[y, x], pixels[y, (x + 1) % w],
                pixels[(y + 1) % h, x], pixels[(y + 1) % h, (x + 1) % w]]
        taps = [srgb_decode(t / 255.) if srgb else t / 255. for t in taps]
        output[start:start + len(c)] = (taps[0] * (1-f[:, :1]) * (1-f[:, 1:]) +
            taps[1] * f[:, :1] * (1-f[:, 1:]) + taps[2] * (1-f[:, :1]) * f[:, 1:] +
            taps[3] * f[:, :1] * f[:, 1:])
    return output


class SourceMaterial:
    def __init__(self, mesh):
        materials = mesh.metadata.get('nativeMaterials', [])
        if len(materials) > 1:
            raise ValueError('Multiple source materials unsupported')
        self.material = materials[0] if materials else {}
        self.pbr = self.material.get('pbrMetallicRoughness', {})
        self.faces = np.asarray(mesh.faces)
        self.uv = getattr(mesh.visual, 'uv', None)
        if self.uv is not None and (np.shape(self.uv) != (len(mesh.vertices), 2) or not np.isfinite(self.uv).all()):
            raise ValueError('Source UV must be finite per-vertex coordinates')
        material = getattr(mesh.visual, 'material', None)
        self.images = {}
        for channel in ('baseColorTexture', 'metallicRoughnessTexture', 'normalTexture', 'occlusionTexture'):
            spec = (self.pbr if channel in ('baseColorTexture', 'metallicRoughnessTexture') else self.material).get(channel, {})
            if spec.get('texCoord', 0) != 0 or spec.get('extensions'):
                raise ValueError('Source transfer supports untransformed TEXCOORD_0 only')
            image = getattr(material, channel, None)
            if spec and image is None:
                raise ValueError('Source ' + channel + ' could not be decoded')
            if image is not None:
                if self.uv is None or not mesh.metadata.get('nativeSourceUV'):
                    raise ValueError('Textured high mesh requires source UV')
                self.images[channel] = np.asarray(image.convert('RGB'))
        self.normal_scale = float(self.material.get('normalTexture', {}).get('scale', 1))
        self.ao_strength = float(self.material.get('occlusionTexture', {}).get('strength', 1))
        if not np.isfinite(self.normal_scale) or not 0 <= self.ao_strength <= 1:
            raise ValueError('Invalid source normal scale / AO strength')
        self.basis = None
        if 'normalTexture' in self.images:
            if mesh.metadata.get('nativeSourceTangentDeclared'):
                raise ValueError('Explicit source TANGENT retention is not verified; normal transfer refused')
            self.basis = source_basis(mesh)
        self.report = {'normal': 'source OpenGL/glTF +Y tangent normal to world per projection AA tap, then low Mikk TBN' if self.basis else 'high geometry shading normals',
                       'sourceFrame': 'Mikk on original source NORMAL and exported glTF UV; local V flip exactly once; bitangent cross(N,T)*sign',
                       'ao': 'source-only (no multiplication by geometry AO)' if 'occlusionTexture' in self.images else 'geometry AO',
                       'baseColorFiltering': 'sRGB decoded before bilinear filtering; factors in linear space',
                       'maxSamplesPerChunk': MAX_SAMPLES,
                       'sourceFrameValidity':None if self.basis is None else self.basis['report']}

    def coordinates(self, ids, primitive_uvs):
        ids = np.asarray(ids, dtype=np.int64)
        if np.any(ids < 0) or np.any(ids >= len(self.faces)):
            raise ValueError('Invalid source face index; projection misses cannot sample textures')
        tri = np.asarray(self.uv)[self.faces[ids]]
        weights = np.column_stack([1-np.asarray(primitive_uvs).sum(1), primitive_uvs])
        return np.einsum('ni,nij->nj', weights, tri)

    def sample(self, channel, ids, primitive_uvs):
        return bilinear(self.images[channel], self.coordinates(ids, primitive_uvs), srgb=channel == 'baseColorTexture')

    def world_normals(self, ids, primitive_uvs):
        ids = np.asarray(ids, dtype=np.int64)
        if np.any(ids < 0) or np.any(ids >= len(self.faces)):
            raise ValueError('Invalid source face index; projection misses cannot sample textures')
        if not self.basis['validFaces'][ids].all():
            raise ValueError('Projected source normal frame is invalid; explicit normal validity mask required')
        # coordinates validates indices before either texture or frame lookup.
        sampled = self.sample('normalTexture', ids, primitive_uvs) * 2 - 1
        sampled[:, :2] *= self.normal_scale
        sampled = unit(sampled)
        weights = np.column_stack([1-np.asarray(primitive_uvs).sum(1), primitive_uvs])
        frame_ids = self.basis['faces'][ids]
        n = unit(self.basis['normals'][frame_ids])
        t = unit(self.basis['tangents'][frame_ids, :3])
        b = unit(np.cross(n, t) * self.basis['tangents'][frame_ids, 3, None])
        frame = np.stack([unit(np.einsum('ni,nij->nj', weights, axis)) for axis in (t,b,n)], axis=-1)
        return unit(np.einsum('nij,nj->ni', frame, sampled))


def filtered_source_normals(xy,tex,xyz,high_faces,high_vertex_normals,cage,query,low_corner_normals=None,center_normals=None,center_valid=None, source_material=None):
    """Same four projection taps as geometry normals; decode source at each hit.

    Kept local so material support cannot change the existing geometry-only
    projection/normal regression path. No image-space filtering or center-only
    substitution for an inside-face missed tap is permitted.
    """
    xy=np.asarray(xy);matrix=np.column_stack([tex[1]-tex[0],tex[2]-tex[0]])
    inv=np.linalg.inv(matrix);total=np.zeros((len(xy),3));counts=np.zeros(len(xy),dtype=np.int32)
    invalid_source=np.zeros(len(xy),bool)
    inside_counts=np.zeros(len(xy),dtype=np.int32);tap_normals=np.zeros((4,len(xy),3));tap_valid=np.zeros((4,len(xy)),bool)
    report={'insideFaceTaps':0,'outsideFaceTaps':0,'validTaps':0,'cageRejectedTaps':0,'centerOnlySubpixelTexels':0,
        'highNormalUnnormalizableFallbacks':0,'highNormalOpposingOwnGeometryFallbacks':0,
        'strongOpposingTapPairs':0,'texelsWithStrongOpposingTaps':0,'invalidSourceFrameTaps':0,'invalidSourceFrameTexels':0}
    for tap_index,(dx,dy) in enumerate([(.25,.25),(.75,.25),(.25,.75),(.75,.75)]):
        bary2=(xy+[dx,dy]-tex[0])@inv.T
        inside=(bary2>=-1e-10).all(axis=1)&(bary2.sum(axis=1)<=1+1e-10)
        inside_counts+=inside
        report['insideFaceTaps']+=int(inside.sum());report['outsideFaceTaps']+=int((~inside).sum())
        ids=np.flatnonzero(inside)
        if not len(ids):continue
        points=xyz[0]+bary2[ids]@(xyz[1:]-xyz[0])
        if low_corner_normals is None:
            found=query(points)
        else:
            weights=np.column_stack([1-bary2[ids].sum(1),bary2[ids]])
            found=query(points,unit(weights@np.asarray(low_corner_normals)))
        nearest=np.asarray(found['points'])
        valid=np.isfinite(nearest).all(axis=1)&(np.asarray(found['valid'],dtype=bool) if 'valid' in found else np.linalg.norm(nearest-points,axis=1)<=cage)
        projected_ids=np.asarray(found['primitive_ids'])
        frame_ok=np.zeros(len(valid),bool)
        in_range=valid&(projected_ids>=0)&(projected_ids<len(source_material.faces))
        frame_ok[in_range]=source_material.basis['validFaces'][projected_ids[in_range].astype(np.int64)]
        bad=valid&~frame_ok;invalid_source[ids[bad]]=True
        report['invalidSourceFrameTaps']+=int(bad.sum())
        valid &= frame_ok
        report['validTaps']+=int(valid.sum());report['cageRejectedTaps']+=int((~valid).sum())
        if not valid.any():continue
        geometric=np.asarray(found['primitive_normals'])[valid] if 'primitive_normals' in found else None
        normals=source_material.world_normals(np.asarray(found['primitive_ids'])[valid],np.asarray(found['primitive_uvs'])[valid])
        tap_normals[tap_index,ids[valid]]=normals;tap_valid[tap_index,ids[valid]]=True
        total[ids[valid]]+=normals;counts[ids[valid]]+=1
    risk=np.zeros(len(xy),bool)
    for i in range(4):
        for j in range(i+1,4):
            opposing=tap_valid[i]&tap_valid[j]&(np.sum(tap_normals[i]*tap_normals[j],axis=1)<-.5)
            risk|=opposing;report['strongOpposingTapPairs']+=int(opposing.sum())
    report['texelsWithStrongOpposingTaps']=int(risk.sum())
    if center_normals is not None and center_valid is not None:
        center_bary=(xy+.5-tex[0])@inv.T
        center_inside=(center_bary>=1e-7).all(axis=1)&(center_bary.sum(axis=1)<=1-1e-7)
        single=(inside_counts==0)&center_inside&np.asarray(center_valid,dtype=bool)
        total[single]=np.asarray(center_normals)[single];counts[single]=1
        report['centerOnlySubpixelTexels']=int(single.sum())
    report['invalidSourceFrameTexels']=int(invalid_source.sum())
    usable=(~invalid_source)&(counts>0)&(np.linalg.norm(total,axis=1)>1e-8)
    output=np.zeros_like(total);output[usable]=unit(total[usable])
    report['texelsWithoutValidTaps']=int(np.count_nonzero(counts==0));report['cancelledNormalTexels']=int(np.count_nonzero((counts>0)&~usable))
    return output,usable,report
