"""Project convex edge strength and apply wear to the verified baked atlas."""
import hashlib
from pathlib import Path
import shutil

from native3d_bake_padding import replace_glb_images
from native3d_glb_layout import read_glb_document

WEAR_CHANNELS = ('basecolor', 'roughness', 'metallic', 'normal', 'ao', 'curvature', 'hits',
                 'metallic-roughness')


def stream_sha256(stream):
    digest = hashlib.sha256()
    while block := stream.read(4 * 1024**2):
        digest.update(block)
    return digest.hexdigest()


def surface_curvature(mesh):
    import numpy as np
    import trimesh

    # Duplicate positions at UV seams represent the same geometric vertex.
    vertices, indices = np.unique(mesh.vertices, axis=0, return_inverse=True)
    welded = trimesh.Trimesh(vertices=vertices, faces=indices[mesh.faces], process=False)
    adjacency = welded.face_adjacency
    edges = welded.face_adjacency_edges
    convex = welded.face_adjacency_convex
    angles = welded.face_adjacency_angles
    strengths = np.where(convex, np.clip((angles - .10) / (np.pi/2 - .10), 0, 1), 0)
    incident = np.zeros((len(welded.faces), 3), dtype=np.float32)
    for side in range(2):
        triangles = adjacency[:, side]
        corners = welded.faces[triangles]
        opposite = (corners != edges[:, :1]) & (corners != edges[:, 1:])
        rows, columns = opposite.nonzero()
        np.maximum.at(incident, (triangles[rows], columns), strengths[rows])
    corners = np.asarray(mesh.triangles)
    lengths = np.linalg.norm(corners[:, [1, 2, 0]]-corners[:, [2, 0, 1]], axis=-1)
    altitude = 2*np.asarray(mesh.area_faces)[:, None] / np.maximum(lengths, 1e-15)
    return incident, altitude


def curvature_samples(curvature, triangles, uv, radius):
    import numpy as np

    strength, altitude = curvature
    bary = np.column_stack((1-uv.sum(axis=1), uv))
    distance = np.maximum(0, bary) * altitude[triangles]
    return (strength[triangles] * np.exp(-np.square(distance / radius))).max(axis=1)


def _hash(path):
    with path.open('rb') as stream:
        return stream_sha256(stream)


def freeze_wear(manager, job, directory):
    # Resolve these paths exclusively from the same-project bake receipt.
    from native3d_jobs import fail

    prior = manager.jobs.get(job['parameters'].get('bakeJobId'))
    if not prior or prior['projectId'] != job['projectId'] or prior['operation'] != 'bake' or prior['status'] != 'succeeded':
        fail('曲率磨损需要来自当前项目的成功烘焙。', 409, 'NATIVE3D_WEAR_SOURCE')
    files = {item['name']: item for item in prior['result']['files']}
    if files.get('model.glb', {}).get('sha256') != job['source']['sha256']:
        fail('模型与烘焙任务的网格或 UV 版本不匹配。', 409, 'NATIVE3D_WEAR_SOURCE')
    folder = Path(directory) / 'baked-atlas'
    folder.mkdir()
    channels = {}
    for name in WEAR_CHANNELS:
        filename = name + '.png'
        entry = files.get(filename)
        if not entry or entry['role'] != 'texture':
            fail('请重新烘焙所连模型，生成完整贴图及凸棱曲率。', 409, 'NATIVE3D_WEAR_SOURCE')
        source = manager.output_file(prior['id'], filename)
        if source.stat().st_size > 64 * 1024**2:
            fail('烘焙贴图超过 64 MiB。', 409, 'NATIVE3D_WEAR_SOURCE')
        target = folder / filename
        shutil.copyfile(source, target)
        sha = _hash(target)
        if sha != entry.get('sha256'):
            fail('烘焙贴图内容已变化。', 409, 'NATIVE3D_WEAR_SOURCE')
        channels[name] = {'file': str(target), 'sha256': sha}
    return {'bakeJobId': prior['id'], 'modelSha256': job['source']['sha256'],
            'resolution': prior['result']['metadata']['bake']['resolution'], 'channels': channels}


def apply_wear(source, output, snapshot, parameters):
    import numpy as np
    from PIL import Image

    if _hash(source) != snapshot['modelSha256']:
        raise ValueError('磨损输入与烘焙模型不一致。')
    resolution = snapshot['resolution']
    if resolution not in (1024, 2048, 4096):
        raise ValueError('烘焙贴图分辨率超出支持范围。')
    channels = snapshot['channels']

    def read(name, mode):
        entry = channels[name]
        path = Path(entry['file'])
        if _hash(path) != entry['sha256']:
            raise ValueError('磨损输入贴图的校验值已变化。')
        with Image.open(path) as image:
            if image.format != 'PNG' or image.size != (resolution, resolution):
                raise ValueError('磨损输入需要同尺寸的烘焙 PNG 贴图。')
            return np.asarray(image.convert(mode)).copy()

    curvature = read('curvature', 'L').astype(np.float32)/255
    threshold = parameters['threshold']
    mask = np.clip((curvature-threshold)/(1-threshold), 0, 1) * parameters['strength']
    color = read('basecolor', 'RGB')
    # Blend display colors in linear space so response to strength is predictable.
    rgb = color.astype(np.float32) / 255
    linear = np.where(rgb <= .04045, rgb/12.92, ((rgb+.055)/1.055)**2.4)
    linear += mask[..., None] * parameters['edgeLighten'] * (1-linear)
    rgb = np.where(linear <= .0031308, linear*12.92, 1.055*linear**(1/2.4)-.055)
    result_color = np.rint(np.clip(rgb, 0, 1)*255).astype('uint8')
    roughness = read('roughness', 'L')
    metallic = read('metallic', 'L')
    orm = read('metallic-roughness', 'RGB')
    edge_roughness = parameters['edgeRoughness']*255
    orm[:, :, 1] = np.rint(roughness+mask*(edge_roughness-roughness)).astype('uint8')
    orm[:, :, 2] = np.rint(metallic+mask*parameters['metalExposure']*(255-metallic)).astype('uint8')
    for name, data in {'basecolor': result_color, 'roughness': orm[:, :, 1], 'metallic': orm[:, :, 2],
                       'metallic-roughness': orm, 'edge-wear': np.rint(mask*255).astype('uint8')}.items():
        Image.fromarray(data).save(output/(name+'.png'))
    for name in ('normal', 'ao', 'curvature'):
        read(name, 'RGB' if name=='normal' else 'L')
        shutil.copyfile(channels[name]['file'], output/(name+'.png'))
    doc = read_glb_document(source)
    mat, = doc['materials']
    pbr = mat['pbrMetallicRoughness']
    replacements = {
        doc['textures'][pbr[slot]['index']]['source']: (output/(name+'.png')).read_bytes()
        for slot, name in (('baseColorTexture', 'basecolor'), ('metallicRoughnessTexture', 'metallic-roughness'))
    }
    if len(replacements) != 2:
        raise ValueError('烘焙模型的底色与粗糙度/金属度必须使用独立图像。')
    proof = replace_glb_images(source, output/'model.glb', replacements)
    shutil.copyfile(output/'model.glb', output/'proxy.glb')
    hits = read('hits', 'L') > 0
    return {'bakeJobId': snapshot['bakeJobId'], 'bakedModelSha256':snapshot['modelSha256'],
            'resolution': resolution, 'wearOnProjectedTexels': int(((mask > 0) & hits).sum()),
            'parameters': parameters, 'curvature': 'projected convex high-mesh edge strength',
            'glbPreservation': proof}
