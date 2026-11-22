"""Check the running ComfyUI backend for the single-image Pixal3D recipe."""

from __future__ import annotations

import argparse
import json
import sys
from urllib.error import URLError
from urllib.request import urlopen

# The Pixal3D-only path does not require the alternative TRELLIS.2 UNet.
# The two TRELLIS.2 VAEs are shared and are still required.
MODEL_INPUTS = {
    "UNETLoader": ("unet_name", ("pixal3d_int8_convrot.safetensors",)),
    "VAELoader": (
        "vae_name",
        ("trellis_2_shape_vae_bf16.safetensors", "trellis_2_texture_vae_bf16.safetensors"),
    ),
    "CLIPVisionLoader": ("clip_name", ("dino_v3_L_naf_fp32.safetensors",)),
    "LoadMoGeModel": ("model_name", ("moge_2_vitl_normal_fp16.safetensors",)),
    "LoadBackgroundRemovalModel": ("bg_removal_name", ("birefnet.safetensors",)),
}
RECIPE_NODES = (
    "LoadImage",
    "Pixal3DConditioning",
    "Trellis2ShapeStage",
    "Trellis2UpsampleStage",
    "Trellis2TextureStage",
    "VaeDecodeStructureTrellis2",
    "VaeDecodeShapeTrellis",
    "VaeDecodeTextureTrellis",
    "SaveGLB",
)


def loader_options(node, field):
    required = node.get("input", {}).get("required", {})
    spec = required.get(field, [])
    if not spec:
        return []
    if isinstance(spec[0], list):
        return spec[0]
    config = spec[1] if len(spec) > 1 and isinstance(spec[1], dict) else {}
    return config.get("options", [])


def check_readiness(object_info):
    missing_nodes = [
        name for name in (*MODEL_INPUTS, *RECIPE_NODES) if name not in object_info
    ]
    models = {}
    for node_name, (field, expected) in MODEL_INPUTS.items():
        options = loader_options(object_info.get(node_name, {}), field)
        by_name = {}
        for option in options:
            name = option.replace(chr(92), "/").rsplit("/", 1)[-1]
            by_name.setdefault(name, []).append(option)
        for name in expected:
            candidates = by_name.get(name, [])
            models[name] = {
                "loader": node_name,
                "status": "ready" if len(candidates) == 1 else ("ambiguous" if candidates else "missing"),
                "choices": candidates,
            }
    return {
        "ready": not missing_nodes and all(model["status"] == "ready" for model in models.values()),
        "missingNodes": missing_nodes,
        "models": models,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:8188", help="ComfyUI backend URL")
    args = parser.parse_args()
    try:
        with urlopen(args.url.rstrip("/") + "/object_info", timeout=15) as response:
            object_info = json.load(response)
        if not isinstance(object_info, dict):
            raise ValueError("Expected a ComfyUI object_info object")
        report = check_readiness(object_info)
    except (OSError, URLError, ValueError) as exc:
        print(json.dumps({"ready": False, "error": str(exc)}, ensure_ascii=False))
        return 2
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0 if report["ready"] else 1


if __name__ == "__main__":
    sys.exit(main())
