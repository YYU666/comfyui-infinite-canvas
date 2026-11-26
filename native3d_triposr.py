"""TripoSR inference in a configured local Python, without a workflow server."""
import hashlib
import os
from pathlib import Path
import sys
import types

CHECKPOINT_SHA256 = '429e2c6b22a0923967459de24d67f05962b235f79cde6b032aa7ed2ffcd970ee'
MODULES = ('torch', 'torchvision', 'transformers', 'omegaconf', 'einops', 'trimesh', 'numpy', 'PIL',
           'imageio', 'huggingface_hub', 'mcubes', 'fast_simplification', 'psutil')
MODEL_FILES = ('config.yaml', 'dino-config.json', 'model.ckpt')
CONFIG_SHA256 = {
    'config.yaml':'74ca708ce086bf68e97709ea6b3d91f14717921c04691e84043f0eb8fcc68e62',
    'dino-config.json':'b87c0270b97db085fd82cf114a761fd0f62ae7914fbd407c752a2260646b689c',
}
IMAGE_SUFFIXES = ('.png', '.jpg', '.jpeg', '.webp')
MAX_IMAGE_BYTES = 32 * 1024**2


def stream_sha256(stream):
    digest = hashlib.sha256()
    while block := stream.read(4 * 1024**2):
        digest.update(block)
    return digest.hexdigest()


def configuration_errors(config):
    if not isinstance(config, dict):
        return ['在 native3d-config.json 中配置 imageTo3D（TripoSR 独立 Python、源码目录、权重目录）']
    errors = []
    for key, filename in (('pythonExecutable', None), ('sourceDirectory', 'tsr/system.py'),
                          ('modelDirectory', 'model.ckpt')):
        raw = config.get(key)
        path = Path(raw) if isinstance(raw, str) and raw else None
        if not path or not path.is_absolute() or not (path / filename if filename else path).is_file():
            errors.append(f'imageTo3D.{key} 缺失或无效')
    extra = config.get('pythonModuleDirectory')
    if extra is not None and (not isinstance(extra, str) or not Path(extra).is_absolute() or not Path(extra).is_dir()):
        errors.append('imageTo3D.pythonModuleDirectory 必须是已存在的绝对路径')
    raw = config.get('modelDirectory')
    if isinstance(raw, str) and raw:
        for name in MODEL_FILES[:2]:
            if not (Path(raw) / name).is_file():
                errors.append(f'TripoSR 本地文件缺失：{name}')
    return errors


def worker_env(config):
    env = {**os.environ, 'HF_HUB_OFFLINE':'1', 'TRANSFORMERS_OFFLINE':'1', 'PYTHONDONTWRITEBYTECODE':'1'}
    env.pop('PYTHONPATH', None)
    if config.get('pythonModuleDirectory'):
        env['PYTHONPATH'] = config['pythonModuleDirectory']
    return env


def _prepare_image(source, background, foreground_ratio):
    import numpy as np
    from PIL import Image, ImageOps

    if source.suffix.lower() not in IMAGE_SUFFIXES or not 0 < source.stat().st_size <= MAX_IMAGE_BYTES:
        raise ValueError('图生模型需要小于 32 MiB 的 PNG、JPEG 或 WebP 项目素材。')
    with Image.open(source) as opened:
        if opened.format not in ('PNG', 'JPEG', 'WEBP') or max(opened.size) > 8192:
            raise ValueError('参考图格式无效或边长超过 8192。')
        image = ImageOps.exif_transpose(opened).convert('RGBA')
    image.thumbnail((1536, 1536), Image.Resampling.LANCZOS)
    alpha = image.getchannel('A')
    if alpha.getextrema() == (255, 255) and background == 'light':
        rgb = np.asarray(image.convert('RGB'), dtype=np.float32)
        corner = max(1, min(rgb.shape[:2]) // 32)
        patches = [rgb[y:y+corner, x:x+corner] for y in (0, len(rgb)-corner)
                   for x in (0, rgb.shape[1]-corner)]
        reference = np.median(np.concatenate([patch.reshape(-1, 3) for patch in patches]), axis=0)
        if reference.min() < 175:
            raise ValueError('浅色背景模式要求四角为浅色。请换透明 PNG 或选择保留整图。')
        distance = np.max(np.abs(rgb-reference), axis=-1)
        alpha = Image.fromarray(np.clip((distance-25)/25*255, 0, 255).astype('uint8'))
        image.putalpha(alpha)
    if background == 'alpha' and alpha.getextrema() == (255, 255):
        raise ValueError('当前模式需要带透明背景的 PNG 或 WebP。')
    bounds = alpha.point(lambda value: 255 if value >= 128 else 0).getbbox()
    if not bounds:
        raise ValueError('参考图没有可识别的前景。')
    image = image.crop(bounds)
    size = int(max(image.size) / foreground_ratio)
    frame = Image.new('RGBA', (size, size), (128, 128, 128, 255))
    frame.alpha_composite(image, ((size-image.width)//2, (size-image.height)//2))
    return frame.convert('RGB')


def _bind_upstream(source, dino):
    # The upstream extractor calls torchmcubes and swaps z/x. Use the local
    # compiled CPU PyMCubes wheel and supply that same coordinate convention.
    import mcubes
    import torch

    def marching_cubes(level, threshold):
        vertices, faces = mcubes.marching_cubes(level.detach().cpu().numpy(), threshold)
        return torch.as_tensor(vertices[:, ::-1].copy(), dtype=torch.float32), torch.as_tensor(faces.astype('int64'))

    sys.path.insert(0, str(source))
    cube_adapter = types.ModuleType('torchmcubes')
    cube_adapter.marching_cubes = marching_cubes
    sys.modules['torchmcubes'] = cube_adapter
    # Upstream imports rembg unconditionally. This integration preprocesses the
    # project image itself; no additional segmentation model is requested.
    if 'rembg' not in sys.modules:
        sys.modules['rembg'] = types.ModuleType('rembg')
    from tsr.models.tokenizers import image as tokenizer
    from tsr.system import TSR

    def local_config(*, repo_id, filename):
        if repo_id != 'facebook/dino-vitb16' or filename != 'config.json':
            raise ValueError('TripoSR requested an unexpected tokenizer asset.')
        return str(dino)

    tokenizer.hf_hub_download = local_config
    return TSR


def generate(source, config, parameters, progress):
    import numpy as np
    import torch
    from omegaconf import OmegaConf

    missing = configuration_errors(config)
    if missing:
        raise ValueError('；'.join(missing))
    if not torch.cuda.is_available():
        raise ValueError('TripoSR 配置的 Python 无法使用 CUDA。')
    root = Path(config['modelDirectory'])
    for name, expected in CONFIG_SHA256.items():
        with (root/name).open('rb') as stream:
            if stream_sha256(stream) != expected:
                raise ValueError(f'TripoSR 配置校验失败：{name}')
    prepared = _prepare_image(source, parameters['background'], parameters['foregroundRatio'])
    progress('load_triposr', 20)
    weights = root/'model.ckpt'
    with weights.open('rb') as stream:
        weight_sha = stream_sha256(stream)
    if weight_sha != CHECKPOINT_SHA256:
        raise ValueError('TripoSR 权重 SHA-256 不匹配。')
    cls = _bind_upstream(Path(config['sourceDirectory']), root/'dino-config.json')
    settings = OmegaConf.load(root/'config.yaml')
    OmegaConf.resolve(settings)
    model = cls(settings)
    model.load_state_dict(torch.load(weights, map_location='cpu', weights_only=True), strict=True)
    model.renderer.set_chunk_size(8192)
    model = model.to('cuda').eval()
    torch.cuda.reset_peak_memory_stats()
    progress('image_to_triplanes', 40)
    with torch.inference_mode():
        triplanes = model([prepared], device='cuda')
        progress('extract_colored_surface', 55)
        mesh, = model.extract_mesh(triplanes, has_vertex_color=True, resolution=parameters['gridResolution'])
    mesh.fix_normals()
    # glTF vertex-color accessors are linear. The model predicts display RGB.
    colors = mesh.visual.vertex_colors
    srgb = colors[:, :3].astype(np.float32) / 255
    linear = np.where(srgb <= .04045, srgb / 12.92, ((srgb + .055) / 1.055) ** 2.4)
    colors[:, :3] = np.rint(linear * 255).astype('uint8')
    mesh.visual.vertex_colors = colors
    return mesh, {'provider':'triposr','checkpointSha256':weight_sha,
                  'gridResolution':parameters['gridResolution'],'background':parameters['background'],
                  'inputSize':list(prepared.size),'geometryTriangles':len(mesh.faces),
                  'color':'linear glTF vertex color inferred from image',
                  'peakCudaBytes':torch.cuda.max_memory_allocated()}
