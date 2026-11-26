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


def write_packed_maps(output, ao, roughness, metallic):
    import numpy as np
    from PIL import Image

    # Keep the older metal/roughness file for existing consumers. The shared
    # glTF occlusion and metal/roughness texture samples separate channels.
    packed = np.stack((ao, roughness, metallic), axis=-1)
    Image.fromarray(packed).save(output / 'orm.png')
    packed[..., 0] = 0
    Image.fromarray(packed).save(output / 'metallic-roughness.png')
