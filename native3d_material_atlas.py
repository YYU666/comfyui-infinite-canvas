"""Texture delivery names and linear glTF occlusion/roughness/metallic packing."""
BAKE_TEXTURES = ('normal', 'ao', 'coverage', 'hits', 'normal-valid', 'basecolor', 'roughness',
                 'metallic', 'metallic-roughness', 'orm', 'curvature')


def shares_orm_storage(document, material):
    metallic = material.get('pbrMetallicRoughness', {}).get('metallicRoughnessTexture')
    ao = material.get('occlusionTexture')
    if not metallic or not ao:
        return False
    textures, images = document['textures'], document['images']
    ao_view = images[textures[ao['index']]['source']].get('bufferView')
    mr_view = images[textures[metallic['index']]['source']].get('bufferView')
    return ao_view is not None and ao_view == mr_view


def texture_qc_warnings(normal, roughness):
    """Flag a dead-flat roughness map or a flat tangent-space purple normal."""
    import numpy as np
    warnings = []
    normal = np.asarray(normal)
    roughness = np.asarray(roughness)
    if normal.ndim == 3 and normal.size:
        pixels = normal.reshape(-1, normal.shape[-1]).astype(np.float64)
        mean = pixels.mean(axis=0)
        if float(pixels.std(axis=0).max()) < 1.5 and abs(float(mean[0]) - 128) < 12 and abs(float(mean[1]) - 128) < 12 and float(mean[2]) > 240:
            warnings.append('法线贴图接近纯平紫，质检未通过。')
    if roughness.size and float(roughness.std()) < 1.5:
        warnings.append('粗糙度贴图接近常数死灰，质检未通过。')
    return warnings


def write_packed_maps(output, ao, roughness, metallic):
    import numpy as np
    from PIL import Image

    # Keep the older metal/roughness file for existing consumers. The shared
    # glTF occlusion and metal/roughness texture samples separate channels.
    packed = np.stack((ao, roughness, metallic), axis=-1)
    Image.fromarray(packed).save(output / 'orm.png')
    packed[..., 0] = 0
    Image.fromarray(packed).save(output / 'metallic-roughness.png')
