"""Local, deterministic texture-to-material maps for ComfyUI."""

import torch
from torch.nn import functional as F


class RefmuseTextureToPBR:
    @classmethod
    def INPUT_TYPES(cls):
        return {'required': {
            'image': ('IMAGE',),
            'normal_strength': ('FLOAT', {'default': 2.0, 'min': 0.0, 'max': 12.0}),
            'roughness': ('FLOAT', {'default': 0.65, 'min': 0.0, 'max': 1.0}),
        }, 'optional': {'metal_mask': ('MASK',)}}

    RETURN_TYPES = ('IMAGE',) * 6
    RETURN_NAMES = ('base_color', 'height', 'normal', 'roughness', 'metallic', 'ao')
    FUNCTION = 'derive'
    CATEGORY = 'Refmuse/3D'

    def derive(self, image, normal_strength, roughness, metal_mask=None):
        base = image[..., :3].clamp(0, 1)
        linear = torch.where(base <= 0.04045, base / 12.92, ((base + 0.055) / 1.055) ** 2.4)
        height = (linear * linear.new_tensor([0.2126, 0.7152, 0.0722])).sum(dim=-1)
        padded = F.pad(height.unsqueeze(1), (1, 1, 1, 1), mode='replicate')[:, 0]
        dx = (padded[:, 1:-1, 2:] - padded[:, 1:-1, :-2]) * 0.5
        dy = (padded[:, 2:, 1:-1] - padded[:, :-2, 1:-1]) * 0.5
        normal = F.normalize(torch.stack((-normal_strength * dx, normal_strength * dy,
                                          torch.ones_like(dx)), dim=-1), dim=-1) * 0.5 + 0.5
        local = F.avg_pool2d(height.unsqueeze(1), 9, stride=1, padding=4,
                             count_include_pad=False)[:, 0]
        rough = (roughness + (local - height) * 0.25).clamp(0, 1)
        ao = (1 - 1.2 * (local - height).clamp_min(0)).clamp(0, 1)
        metal = torch.zeros_like(height)
        if metal_mask is not None:
            metal = F.interpolate(metal_mask.to(height).unsqueeze(1), size=height.shape[1:],
                                  mode='bilinear', align_corners=False)[:, 0].clamp(0, 1)
            if metal.shape[0] not in (1, height.shape[0]):
                raise ValueError('Metal mask batch must match the image batch or contain one mask.')
            metal = metal.expand_as(height)

        def rgb(channel):
            return channel.unsqueeze(-1).expand(-1, -1, -1, 3)

        return base, rgb(height), normal, rgb(rough), rgb(metal), rgb(ao)


NODE_CLASS_MAPPINGS = {'RefmuseTextureToPBR': RefmuseTextureToPBR}
NODE_DISPLAY_NAME_MAPPINGS = {'RefmuseTextureToPBR': 'Refmuse Texture to PBR'}
