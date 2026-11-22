"""Check the running ComfyUI backend for the single-image Pixal3D recipe."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from urllib.error import URLError
from urllib.request import urlopen

RECIPE_PATH = Path(__file__).resolve().parents[1] / "workflows" / "pixal3d_lamp_shade_api.json"
with RECIPE_PATH.open(encoding="utf-8") as recipe_file:
    RECIPE = json.load(recipe_file)

MODEL_FIELDS = {
    "UNETLoader": "unet_name",
    "VAELoader": "vae_name",
    "CLIPVisionLoader": "clip_name",
    "LoadMoGeModel": "model_name",
    "LoadBackgroundRemovalModel": "bg_removal_name",
}
MODEL_INPUTS = {
    name: (field, tuple(
        node["inputs"][field] for node in RECIPE.values() if node["class_type"] == name
    ))
    for name, field in MODEL_FIELDS.items()
}
RECIPE_NODES = tuple(sorted({node["class_type"] for node in RECIPE.values()}))


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
        name for name in RECIPE_NODES if name not in object_info
    ]
    models = {}
    for node_name, (field, expected) in MODEL_INPUTS.items():
        options = loader_options(object_info.get(node_name, {}), field)
        by_name = {}
        for option in options:
            name = option.replace("\\", "/").rsplit("/", 1)[-1]
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
