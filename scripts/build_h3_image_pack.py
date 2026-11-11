"""Build portable, data-only H3 Image canvas nodes; never bundle weights or inputs."""
from __future__ import annotations

import argparse
import io
import json
from pathlib import Path
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from workflow_extensions import inspect_package

MODELS = {
    "unet": "minimax_h3_image_pruned_int8_convrot.safetensors",
    "clip": "qwen3vl_32b_minimax_h3_int8_convrot.safetensors",
    "vae": "minimax_h3_image_vae_fp16.safetensors",
}


def graph_for(count):
    graph = {
        "model": {"class_type": "UNETLoader", "inputs": {"unet_name": MODELS["unet"], "weight_dtype": "default"}},
        "text": {"class_type": "CLIPLoader", "inputs": {"clip_name": MODELS["clip"], "type": "minimax", "device": "default"}},
        "vae": {"class_type": "VAELoader", "inputs": {"vae_name": MODELS["vae"]}},
        "positive": {"class_type": "MiniMaxH3ImageConditioning", "inputs": {
            "clip": ["text", 0], "vae": ["vae", 0], "prompt": "A red ceramic teapot on a wooden table, warm window light, natural photography.",
            "width": 2048, "height": 2048,
        }},
        "negative": {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": ["positive", 0]}},
        "sample": {"class_type": "KSampler", "inputs": {
            "model": ["model", 0], "positive": ["positive", 0], "negative": ["negative", 0], "latent_image": ["positive", 1],
            "seed": 42, "steps": 6, "cfg": 1, "sampler_name": "euler", "scheduler": "simple", "denoise": 1,
        }},
        "decode": {"class_type": "VAEDecode", "inputs": {"samples": ["sample", 0], "vae": ["vae", 0]}},
        "save": {"class_type": "SaveImage", "inputs": {"images": ["decode", 0], "filename_prefix": "H3/extensions/h3-image"}},
    }
    for number in range(1, count + 1):
        key = f"image_{number}"
        graph[key] = {"class_type": "LoadImage", "inputs": {"image": "input.png"}}
        graph["positive"]["inputs"][f"images.image_{number}"] = [key, 0]
    if count:
        graph["positive"]["inputs"]["prompt"] = "Edit <Picture 1>. Change the lighting to soft golden hour while preserving the composition."
    return graph


def definition_for(count):
    key = "t2i" if count == 0 else f"edit-{count}"
    title = "H3-Image · 文生图" if count == 0 else f"H3-Image · {count} 图参考编辑"
    properties = {
        "prompt": {"type": "string", "title": "详细提示词（参考图使用 <Picture 1> 等编号）", "default": graph_for(count)["positive"]["inputs"]["prompt"]},
        "width": {"type": "integer", "title": "输出宽度", "enum": [2048, 2560, 3072, 4096], "default": 2048},
        "height": {"type": "integer", "title": "输出高度", "enum": [2048, 2560, 3072, 4096], "default": 2048},
        "seed": {"type": "integer", "title": "固定种子（改数值获得新结果）", "minimum": 0, "maximum": 9007199254740991, "default": 42},
    }
    bindings = [{"sourceKind": "parameter", "sourceId": name, "nodeId": "sample" if name == "seed" else "positive", "input": name} for name in properties]
    ports = []
    for number in range(1, count + 1):
        image = f"image_{number}"
        ports.append({"id": image, "type": "image", "required": True, "list": False, "label": f"图 {number}", "description": f"提示词中的 <Picture {number}>；按端口编号对应"})
        bindings.append({"sourceKind": "input", "sourceId": image, "nodeId": image, "input": "image"})
    return {
        "nodeDefinitionSchemaVersion": "0.1", "nodeDefinitionId": key, "name": title,
        "description": "本地 INT8 · 6 步 · CFG 1 · 默认 2048²（4MP）。16MP 请确认显存余量。",
        "inputs": ports, "outputs": [{"id": "image", "type": "image", "nodeId": "save"}],
        "parameters": {"type": "object", "additionalProperties": False, "properties": properties}, "bindings": bindings,
    }


def build_pack():
    readme = """# Refmuse H3-Image 画布节点

在画布「节点库 → 本地节点 / 导入工作流」导入此 .h3pack。
包含文生图与 1/2/3/4 图编辑五种节点；选用与实际图片数量一致的节点，把图片连到对应图号端口，填写提示词并生成。结果自动回到画布，可继续连接其他节点。

画布实际连接的 ComfyUI 必须支持 MiniMaxH3ImageConditioning（已核验 0.45.0，commit 0228a9d73cd7c2daf8f61fe13d56b12efe307171）。单独开另一个后台不改变画布连接。
模型目录：diffusion_models/minimax_h3_image_pruned_int8_convrot.safetensors、text_encoders/qwen3vl_32b_minimax_h3_int8_convrot.safetensors、vae/minimax_h3_image_vae_fp16.safetensors。
下载来源 https://huggingface.co/Comfy-Org/MiniMax-H3-Image ，既有相同 32B 文本编码器可以复用；不需要额外提示词扩写模型或云端 API。

详细提示词建议使用英文；图片按端口编号引用 <Picture 1>、<Picture 2>，编辑图 1 时可写 Edit <Picture 1>. ... 。默认 4MP，宽高可分别选 2048/2560/3072/4096。4096² 为 16MP，显存和内存需求更高。6 步固定、CFG 1，无负面提示词、不加载其他模型 LoRA；不提供局部遮罩模式。

此包只含工作流配置，没有模型、图片、API 密钥、个人路径或可执行代码。模型仍须安装在每台电脑的 ComfyUI 模型目录；导入工作流不会自动升级 ComfyUI。
模型使用 MiniMax-H3-Image Community License，存在地域、第三方托管服务和营收等授权条件；详见 https://huggingface.co/MiniMaxAI/MiniMax-H3-Image/blob/main/LICENSE 。
"""
    manifest = {
        "manifestSchemaVersion": "0.1", "packageId": "refmuse/h3-image", "version": "1.0.0", "type": "workflow", "publisherId": "refmuse",
        "name": "MiniMax H3-Image · 本地生图与多图编辑", "summary": "本地 INT8 · 6 步 · 图片直连与画布结果回传", "description": readme,
        "source": {"kind": "direct-upload"}, "compatibility": {"extensionApiVersion": "0.1"},
        "dependencies": {"comfyNodes": sorted({n["class_type"] for n in graph_for(1).values()}), "models": list(MODELS.values()), "python": []},
        "permissions": {"network": [], "externalServices": [], "fileAccess": [], "background": False},
        "licenses": {"workflow": "Apache-2.0", "models": "MiniMax-H3-Image Community License Agreement; separate model terms apply"},
        "verification": {"environments": [], "examples": []}, "nodes": [],
    }
    files = {"README.md": readme, "LICENSE": (ROOT / "LICENSE").read_text(encoding="utf-8")}
    for count in range(5):
        definition = definition_for(count)
        key = definition["nodeDefinitionId"]
        entry = {"nodeDefinitionId": key, "definition": f"nodes/{key}.json", "workflow": f"workflows/{key}.json"}
        manifest["nodes"].append(entry)
        files[entry["definition"]] = definition
        files[entry["workflow"]] = graph_for(count)
    files["manifest.json"] = manifest
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path, content in files.items():
            value = content if isinstance(content, str) else json.dumps(content, ensure_ascii=False, sort_keys=True)
            item = zipfile.ZipInfo(path, (2026, 11, 11, 0, 0, 0))
            item.compress_type = zipfile.ZIP_DEFLATED
            item.external_attr = 0o100644 << 16
            archive.writestr(item, value.encode("utf-8"))
    data = buffer.getvalue()
    inspect_package(data)
    return data


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(build_pack())
    print(args.output)
