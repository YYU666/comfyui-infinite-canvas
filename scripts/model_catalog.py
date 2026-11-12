"""List workbench model bundles and check what is already on disk. Never downloads."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
MODELS = ROOT / "models"

if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from extension_dependencies import canonical_sources
from verify_workbench import file_sha256, safe_relative


def _load_json(name: str) -> dict:
    return json.loads((MODELS / name).read_text(encoding="utf-8"))


def catalog_files() -> dict[str, dict]:
    files: dict[str, dict] = {}
    for name in ("manifest.json", "h3-image-sources.json", "flux3-klein.json", "character-upgrades.json"):
        for row in _load_json(name)["files"]:
            current = files.setdefault(row["path"], {"path": row["path"], "bytes": row["bytes"], "sha256": row.get("sha256")})
            if current["bytes"] != row["bytes"]:
                raise ValueError(f"清单字节不一致：{row['path']}")
            if row.get("sha256"):
                current["sha256"] = row["sha256"]
            if row.get("source"):
                current["source"] = row["source"]
    for path, source in canonical_sources().items():
        item = files.setdefault(path, {"path": path, "bytes": source["bytes"], "sha256": source.get("sha256")})
        item["url"] = source["url"]
        item["license"] = source.get("license")
        if source.get("sha256"):
            item["sha256"] = source["sha256"]
    return files


BUNDLES = {
    "none": {
        "title": "最小（无扩散模型）",
        "description": "只使用已安装的画布与 ComfyUI 节点／前端，不下载权重。",
        "files": [],
    },
    "core-h3": {
        "title": "视频核心",
        "description": "H3 文生视频、全能参考视频与首尾帧的最小配置。",
        "files": list(_load_json("manifest.json")["profiles"]["core-h3"]["files"]),
    },
    "h3-image": {
        "title": "H3-Image 完整三份",
        "description": "MiniMax H3-Image 文生图与多图编辑；若已有同哈希 32B INT8 编码器请改用 h3-image-incremental。",
        "files": [
            "diffusion_models/minimax_h3_image_pruned_int8_convrot.safetensors",
            "text_encoders/qwen3vl_32b_minimax_h3_int8_convrot.safetensors",
            "vae/minimax_h3_image_vae_fp16.safetensors",
        ],
    },
    "h3-image-incremental": {
        "title": "H3-Image 增量（复用已有 32B INT8 编码器）",
        "description": "在已安装 core-h3 或同哈希编码器时，只需新增图片主模型与图片 VAE。",
        "files": [
            "diffusion_models/minimax_h3_image_pruned_int8_convrot.safetensors",
            "vae/minimax_h3_image_vae_fp16.safetensors",
        ],
    },
    "qwen21": {
        "title": "千问 2.1 标准",
        "description": "图生图标准版及依赖同一套权重的局部修复／默认四视图。",
        "files": [
            "diffusion_models/qwen_image_2.1_int8_convrot.safetensors",
            "text_encoders/qwen3vl_8b_int8_convrot.safetensors",
            "vae/qwen_image_2.1_vae_bf16.safetensors",
        ],
    },
    "qwen21-turbo": {
        "title": "千问 2.1 Turbo 主模型（另需标准编码器与 VAE）",
        "description": "在 qwen21 之外增加 Turbo 主模型。",
        "files": ["diffusion_models/qwen_image_2.1_turbo_int8_convrot.safetensors"],
    },
    "image-upscale-3b": {
        "title": "图片高清 SeedVR2 3B",
        "description": "画布默认图片高清档。",
        "files": [
            "diffusion_models/seedvr2_3b_int8_convrot.safetensors",
            "vae/seedvr2_ema_vae_fp16.safetensors",
        ],
    },
    "klein": {
        "title": "FLUX 3 Image Klein",
        "description": "可选文生图／多参考编辑。权重许可需在官方仓库接受后下载。",
        "files": [row["path"] for row in _load_json("flux3-klein.json")["files"]],
    },
    "character-swap-extras": {
        "title": "角色替换额外文件（假定已有 core-h3 中可复用的三项）",
        "description": "不能只用核心七项；编码器与视频 VAE 必须是 NVFP4 与 FP16 这两份。",
        "files": [
            "text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
            "vae/minimax_h3_video_vae_fp16.safetensors",
            "loras/h3_character_swap_v1.5.safetensors",
            "checkpoints/sam3.1_multiplex_fp16.safetensors",
        ],
    },
    "video-upscale-extras": {
        "title": "视频高清二采额外文件（假定已有角色替换所需文件）",
        "description": "在替换套装之外再增加 768p 4-step Turbo 与 Latent 放大模型。",
        "files": [
            "loras/minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors",
            "latent_upscale_models/minimax_h3_latent_upscaler_3d_conv_v1_fp16.safetensors",
        ],
    },
    "full": {
        "title": "完整 33 项（不建议作为默认）",
        "description": "旧综合清单。不含 H3-Image 新文件、Klein 与四视图升级项；Muse V3.0 FP8 来源未解决。",
        "files": [row["path"] for row in _load_json("manifest.json")["files"]],
    },
}


def bundle_records(bundle_id: str, files: dict[str, dict] | None = None) -> dict:
    if bundle_id not in BUNDLES:
        raise ValueError(f"未知套装：{bundle_id}")
    files = catalog_files() if files is None else files
    spec = BUNDLES[bundle_id]
    items = []
    for path in spec["files"]:
        if path not in files:
            raise ValueError(f"套装 {bundle_id} 引用了未知文件：{path}")
        items.append(dict(files[path]))
    total = sum(item["bytes"] for item in items)
    downloadable = all(item.get("url") for item in items) if items else True
    return {
        "id": bundle_id,
        "title": spec["title"],
        "description": spec["description"],
        "fileCount": len(items),
        "totalBytes": total,
        "totalGiB": round(total / 1024 ** 3, 3),
        "officialDownload": downloadable,
        "files": items,
    }


def list_bundles(bundle_id: str | None = None) -> dict:
    files = catalog_files()
    ids = [bundle_id] if bundle_id else list(BUNDLES)
    bundles = [bundle_records(name, files) for name in ids]
    return {"bundles": bundles}


def format_table(payload: dict) -> str:
    lines = []
    for bundle in payload["bundles"]:
        flag = "可走已登记官方直链" if bundle["officialDownload"] else "含尚未登记官方直链的文件，不能一键自动下载"
        lines.append(f"{bundle['id']}  {bundle['title']}  {bundle['totalGiB']} GiB（{bundle['totalBytes']} 字节）  {bundle['fileCount']} 个文件  {flag}")
        lines.append(f"  {bundle['description']}")
        for item in bundle["files"]:
            source = "官方直链" if item.get("url") else "见 SOURCES.md 或独立说明"
            digest = "sha256" if item.get("sha256") else "仅字节"
            lines.append(f"  - {item['path']}  {item['bytes']} 字节  {digest}  {source}")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def status(comfy_root: Path, bundle_id: str | None = None, model_root: Path | None = None) -> dict:
    root = comfy_root.resolve()
    models_dir = model_root.resolve() if model_root else root / "ComfyUI" / "models"
    payload = list_bundles(bundle_id)
    for bundle in payload["bundles"]:
        installed = missing = mismatched = 0
        details = []
        for item in bundle["files"]:
            path = models_dir / safe_relative(item["path"])
            if not path.is_file():
                state = "missing"
                missing += 1
            elif path.stat().st_size != item["bytes"]:
                state = "size-mismatch"
                mismatched += 1
            elif item.get("sha256") and file_sha256(path) != item["sha256"]:
                state = "hash-mismatch"
                mismatched += 1
            else:
                state = "installed"
                installed += 1
            details.append({**item, "status": state, "pathOnDisk": str(path)})
        bundle["status"] = {
            "modelRoot": str(models_dir),
            "installed": installed,
            "missing": missing,
            "mismatched": mismatched,
            "files": details,
        }
    return payload


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="列出或检查 Refmuse 画布模型套装；默认不会下载任何权重。")
    commands = parser.add_subparsers(dest="command", required=True)
    listing = commands.add_parser("list", help="列出套装、文件与体积，不访问网络")
    listing.add_argument("--bundle")
    listing.add_argument("--format", choices=("table", "json"), default="table")
    checking = commands.add_parser("status", help="检查本机已安装哪些套装文件，不下载")
    checking.add_argument("--comfy-root", type=Path, required=True)
    checking.add_argument("--model-root", type=Path)
    checking.add_argument("--bundle")
    checking.add_argument("--format", choices=("table", "json"), default="table")
    download = commands.add_parser("download", help="按需下载尚未实现；本命令会拒绝执行，以免在无确认流程时拉权重")
    download.add_argument("--bundle", required=True)
    download.add_argument("--comfy-root", type=Path, required=True)
    download.add_argument("--confirm-download", help="必须与 --bundle 完全一致才视为用户已确认；即使一致，本版本仍不会下载")
    args = parser.parse_args(argv)
    if args.command == "download":
        if args.confirm_download != args.bundle:
            print("未下载：缺少与套装 ID 一致的 --confirm-download。请先用 list 向用户说明体积，得到明确同意后再安装。", file=sys.stderr)
            return 2
        print("未下载：自动下载尚未在本版本开放。请在用户确认后，用已整理的本地目录运行 install.py --models-only --models-source <目录> --profile <套装>，或等待后续提供的确认下载命令。", file=sys.stderr)
        return 2
    payload = list_bundles(args.bundle) if args.command == "list" else status(args.comfy_root, args.bundle, args.model_root)
    if args.format == "json":
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        text = format_table(payload)
        if args.command == "status":
            extra = []
            for bundle in payload["bundles"]:
                st = bundle["status"]
                extra.append(f"{bundle['id']} 已安装 {st['installed']}／缺失 {st['missing']}／不符 {st['mismatched']}")
            text = text + "\n".join(extra) + "\n"
        print(text, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
