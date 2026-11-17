"""Offline-only DWPose adapter for the pinned MOSS pose recipe.

Auxiliary node enums are not proof that detector weights exist. Verify the exact
author files before invoking ONNX, and never call from_pretrained/download code.
"""
import hashlib
import importlib
import inspect
from pathlib import Path


WEIGHTS = {
    'dw-ll_ucoco_384.onnx': (134399116, '724f4ff2439ed61afb86fb8a1951ec39c6220682803b4a8bd4f598cd913b1843'),
    'yolox_l.onnx': (216746733, '7860ae79de6c89a3c1eb72ae9a2756c0ccfbe04b7791bb5880afabd97855a411'),
}


def verify_weights(directory):
    directory = Path(directory)
    result = {}
    for name, (size, expected) in WEIGHTS.items():
        path = directory / name
        if not path.is_file():
            raise ValueError(f'DWPose 缺少已核实权重 {name}，已停止；不会自动下载。')
        if any(part.is_symlink() or (hasattr(part, 'is_junction') and part.is_junction()) for part in [path, *path.parents]):
            raise ValueError('DWPose 权重路径含链接，请使用经过校验的普通本地文件。')
        before = path.stat()
        if before.st_size != size:
            raise ValueError(f'DWPose 权重大小不符：{name}，已停止。')
        with path.open('rb') as stream:
            digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        after = path.stat()
        if digest != expected or (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
            raise ValueError(f'DWPose SHA-256 不符或文件正在变化：{name}，已停止。')
        result[name] = str(path.resolve())
    return result


class H3CheckedDWPose:
    @staticmethod
    def _runtime():
        import nodes
        wrapper = nodes.NODE_CLASS_MAPPINGS.get('DWPreprocessor')
        if wrapper is None:
            raise ValueError('请先安装并加载 comfyui_controlnet_aux；不会自动安装。')
        package = importlib.import_module(wrapper.__module__)
        detector_module = importlib.import_module(package.DwposeDetector.__module__)
        ckpts = inspect.signature(detector_module.custom_hf_download).parameters['ckpts_dir'].default
        if not isinstance(ckpts, (str, Path)):
            raise ValueError('无法确认 DWPose 本地权重目录，已停止。')
        paths = verify_weights(Path(ckpts) / 'yzd-v' / 'DWPose')
        return package, detector_module, paths

    @classmethod
    def INPUT_TYPES(cls):
        try:
            cls._runtime()
            state, reason = 'verified', '两份本地 ONNX 已通过大小与 SHA-256 校验。'
        except Exception as exc:
            state = 'blocked'
            reason = str(exc) if isinstance(exc, ValueError) else 'DWPose 运行依赖未就绪，请检查安装；不会自动下载。'
        return {'required': {
            'image': ('IMAGE',),
            'resolution': ('INT', {'default': 1024, 'min': 256, 'max': 1536, 'step': 64}),
            # Fresh object_info is the read-only pre-enqueue check. The graph
            # always requires "verified"; Comfy also rejects a blocked enum.
            'verified_local_weights': ([state], {'tooltip': reason}),
        }}

    RETURN_TYPES = ('IMAGE',)
    FUNCTION = 'estimate'
    CATEGORY = 'Refmuse Local Workbench/Pose'

    def estimate(self, image, resolution=1024, verified_local_weights='verified'):
        if verified_local_weights != 'verified':
            raise ValueError('DWPose 未通过本地权重校验，已停止。')
        package, detector_module, paths = self._runtime()
        # Wholebody accepts both local paths. Bypass from_pretrained entirely;
        # no fallback to HF, torch hub, a moving revision, or another quant.
        wholebody = detector_module.Wholebody(paths['yolox_l.onnx'], paths['dw-ll_ucoco_384.onnx'], torchscript_device=package.model_management.get_torch_device())
        detector = package.DwposeDetector(wholebody)
        def process(frame, **kwargs):
            pose_image, _ = detector(frame, **kwargs)
            return pose_image
        output = package.common_annotator_call(process, image, include_hand=True, include_face=True, include_body=True, image_and_json=True, resolution=resolution, xinsr_stick_scaling=False)
        return (output,)
