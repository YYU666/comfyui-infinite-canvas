"""Local model inventory, usage tracking, lock protection and controlled updates."""
from __future__ import annotations

import copy
import datetime as dt
import hashlib
import io
import json
import os
import shutil
import threading
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

from PIL import Image, ImageOps

from extension_dependencies import _ModelRedirect
from model_sources import locked_sources, model_license
from workbench_lifecycle import APP_VERSION, atomic_write_json, utc_now

ALLOWED_MODEL_EXTENSIONS = frozenset({".safetensors", ".ckpt", ".pt", ".pth", ".bin", ".onnx", ".gguf"})
PREVIEW_IMAGE_EXTENSIONS = (".png", ".jpg", ".jpeg", ".webp")
SCAN_SUBDIRS = (
    "checkpoints",
    "diffusion_models",
    "loras",
    "text_encoders",
    "vae",
    "latent_upscale_models",
    "upscale_models",
    "clip",
    "clip_vision",
    "unet",
    "controlnet",
)
HIGH_USAGE_THRESHOLD = 10
USAGE_WINDOW_DAYS = 30
MAX_USAGE_EVENTS = 200
MAX_DOWNLOAD_REDIRECTS_ENV = "_H3_TEST_ALLOW_LOCALHOST"
WORKFLOW_MODEL_KEYS = frozenset({
    "ckpt_name", "checkpoint", "checkpoint_name",
    "lora_name", "lora",
    "vae_name",
    "unet_name", "diffusion_model",
    "clip_name", "clip_name1", "clip_name2", "clip_name3",
    "control_net_name",
    "upscale_model",
    "model_name",
    "sam_model",
    "bg_removal_name",
})

GROUP_BY_CATEGORY = {
    "diffusion_models": "扩散主模型",
    "checkpoints": "整合与分割模型",
    "text_encoders": "文本与多模态编码器",
    "vae": "VAE 解码器",
    "loras": "LoRA 与角色风格",
    "latent_upscale_models": "高清与放大模型",
    "upscale_models": "高清与放大模型",
    "clip": "文本与多模态编码器",
    "clip_vision": "视觉编码器",
    "unet": "扩散主模型",
    "controlnet": "控制网辅助",
}

CATALOG_FILES = (
    "manifest.json",
    "h3-image-sources.json",
    "flux3-klein.json",
    "character-upgrades.json",
)


class ModelManagerError(Exception):
    """Domain error mapped to structured HTTP error responses."""

    def __init__(self, message: str, *, status: int = 400, code: str = "BAD_REQUEST", details: dict | None = None):
        super().__init__(message)
        self.message = message
        self.status = status
        self.code = code
        self.details = dict(details or {})


def normalize_model_relpath(raw_path: str) -> str:
    """Validate and normalize a relative model path under the models root."""
    if not isinstance(raw_path, str):
        raise ModelManagerError("模型路径必须是字符串。", status=400, code="INVALID_MODEL_PATH")
    cleaned = raw_path.replace("\\", "/").strip()
    while cleaned.startswith("./"):
        cleaned = cleaned[2:]
    if not cleaned or len(cleaned) > 512:
        raise ModelManagerError("模型路径为空或过长。", status=400, code="INVALID_MODEL_PATH")
    if cleaned.startswith("/") or ":" in cleaned or any(ch in cleaned for ch in "\x00\r\n?*<>|\""):
        raise ModelManagerError("模型路径包含不允许的字符或绝对路径。", status=400, code="INVALID_MODEL_PATH")
    parts = [part for part in cleaned.split("/") if part != ""]
    if len(parts) < 2 or any(part in {".", ".."} for part in parts):
        raise ModelManagerError("模型路径必须位于模型分类子目录中。", status=400, code="INVALID_MODEL_PATH")
    normalized = "/".join(parts)
    if Path(normalized).suffix.lower() not in ALLOWED_MODEL_EXTENSIONS:
        raise ModelManagerError("仅支持模型权重文件扩展名。", status=400, code="INVALID_MODEL_PATH")
    return normalized


def _parse_iso(value: str | None) -> dt.datetime | None:
    if not value or not isinstance(value, str):
        return None
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = dt.datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return parsed.astimezone(dt.timezone.utc)


def _friendly_title(filename: str) -> str:
    stem = Path(filename).stem
    replacements = {
        "minimax_h3_fl2va_pruned_int8_convrot": "MiniMax H3 首尾帧视频主模型 (INT8)",
        "minimax_h3_ref2va_pruned_int8_convrot": "MiniMax H3 全能参考视频主模型 (INT8)",
        "minimax_h3_image_pruned_int8_convrot": "MiniMax H3-Image 文生图与编辑 (INT8)",
        "minimax_h3_video_vae_int8_convrot": "MiniMax H3 视频 VAE (INT8)",
        "minimax_h3_video_vae_fp16": "MiniMax H3 视频 VAE (FP16)",
        "minimax_h3_audio_vae_fp32": "MiniMax H3 音频 VAE (FP32)",
        "minimax_h3_image_vae_fp16": "MiniMax H3-Image 图像 VAE (FP16)",
        "minimax_h3_latent_upscaler_3d_conv_v1_fp16": "H3 3D Latent 视频放大模型 (FP16)",
        "qwen3vl_32b_minimax_h3_int8_convrot": "Qwen3-VL 32B 多模态编码器 (INT8)",
        "qwen3vl_32b_minimax_h3_nvfp4_awq": "Qwen3-VL 32B 角色替换编码器 (NVFP4)",
        "qwen_image_2.1_int8_convrot": "千问 Image 2.1 标准主模型 (INT8)",
        "qwen_image_2.1_turbo_int8_convrot": "千问 Image 2.1 Turbo 主模型 (INT8)",
        "seedvr2_3b_int8_convrot": "SeedVR2 3B 高清放大模型 (INT8)",
        "seedvr2_7b_int8_convrot": "SeedVR2 7B 高清放大模型 (INT8)",
        "flux3-image-klein-int8-convrot": "FLUX 3 Image Klein 主模型 (INT8)",
        "krea2_identity_edit_v2": "Krea2 身份编辑 V2 LoRA",
        "h3_character_swap_v1.5": "H3 角色替换 v1.5 LoRA",
        "sam3.1_multiplex_fp16": "SAM 3.1 分割与遮罩模型 (FP16)",
        "pixal3d_int8_convrot": "Pixal3D 图生 3D 主模型 (INT8)",
        "trellis_2_shape_vae_bf16": "Trellis 2 形状 VAE (BF16)",
        "trellis_2_texture_vae_bf16": "Trellis 2 贴图 VAE (BF16)",
        "dino_v3_L_naf_fp32": "DINOv3 视觉编码器 (FP32)",
        "wan_2.1_vae": "Wan 2.1 视频 VAE",
        "krea2RealVae_v10": "Krea2 写实 VAE v1.0",
        "flux2-vae": "FLUX.2 图像 VAE",
        "flux2-vae_small": "FLUX.2 轻量图像 VAE",
        "qwen_image_vae": "千问 Image 图像 VAE",
        "qwen_image_2.1_vae_bf16": "千问 2.1 图像 VAE (BF16)",
        "qwen_2.5_vl_7b_fp8_scaled": "Qwen 2.5 VL 7B 文本编码器 (FP8)",
        "qwen3vl_4b_fp8_scaled": "Qwen3-VL 4B 文本编码器 (FP8)",
        "qwen3vl_4b_int8_convrot": "Qwen3-VL 4B 文本编码器 (INT8)",
        "qwen3.5_9b_flux3_prompt_upsampler_int8_convrot": "Qwen3.5 9B 提示词增强编码器 (INT8)",
        "clip_vision_h": "CLIP Vision H 视觉编码器",
        "MiniMax-H3-FL2VA-Q3_K_M": "MiniMax H3 首尾帧视频 (GGUF Q3)",
        "MiniMax-H3-Ref2VA-Q3_K_M": "MiniMax H3 全能参考视频 (GGUF Q3)",
    }
    return replacements.get(stem, stem.replace("_", " "))


def load_catalog(repo_root: Path) -> dict[str, dict]:
    """Load unified model metadata from repository models manifests without network calls."""
    models_dir = Path(repo_root) / "models"
    entries: dict[str, dict] = {}

    def ensure_entry(raw_path: str) -> dict:
        rel = normalize_model_relpath(raw_path)
        category = rel.split("/", 1)[0]
        item = entries.get(rel)
        if item is None:
            name = rel.rsplit("/", 1)[-1]
            lic = model_license(rel)
            item = {
                "path": rel,
                "name": name,
                "title": _friendly_title(name),
                "category": category,
                "group": GROUP_BY_CATEGORY.get(category, "其他模型"),
                "expectedBytes": None,
                "expectedSha256": None,
                "url": None,
                "hasDownloadUrl": False,
                "license": lic.get("license") or "许可待核实",
                "licenseUrl": lic.get("licenseUrl"),
                "restrictions": lic.get("restrictions") or lic.get("restriction"),
                "bundles": [],
                "source": "catalog",
            }
            entries[rel] = item
        return item

    for filename in CATALOG_FILES:
        file_path = models_dir / filename
        if not file_path.is_file():
            continue
        doc = json.loads(file_path.read_text(encoding="utf-8"))
        bundle_tags = []
        if filename == "manifest.json":
            profiles = doc.get("profiles") or {}
            core_files = set(profiles.get("core-h3", {}).get("files") or [])
        else:
            core_files = set()
        if filename == "flux3-klein.json":
            bundle_tags = ["flux3-klein"]
        elif filename == "character-upgrades.json":
            bundle_tags = ["character-upgrades"]
        elif filename == "h3-image-sources.json":
            bundle_tags = ["h3-image"]
        for row in doc.get("files") or []:
            item = ensure_entry(row["path"])
            if isinstance(row.get("bytes"), int) and row["bytes"] > 0:
                item["expectedBytes"] = row["bytes"]
            if isinstance(row.get("sha256"), str) and row["sha256"].strip():
                item["expectedSha256"] = row["sha256"].strip().lower()
            tags = list(bundle_tags)
            if item["path"] in core_files:
                tags.append("core-h3")
            for tag in tags:
                if tag not in item["bundles"]:
                    item["bundles"].append(tag)

    for rel, pinned in locked_sources().items():
        item = ensure_entry(rel)
        item["expectedBytes"] = pinned["bytes"]
        item["expectedSha256"] = pinned["sha256"]
        item["url"] = pinned["url"]
        item["hasDownloadUrl"] = True
        if pinned.get("license"):
            item["license"] = pinned["license"]
        if pinned.get("licenseUrl"):
            item["licenseUrl"] = pinned["licenseUrl"]

    return entries


def classify_usage(record: dict, *, now: dt.datetime | None = None) -> tuple[str, int]:
    """Return (tier, usage30d) for a model record based on the last 30 days."""
    current = (now or dt.datetime.now(dt.timezone.utc)).astimezone(dt.timezone.utc)
    cutoff = current - dt.timedelta(days=USAGE_WINDOW_DAYS)
    events = record.get("usageEvents") or []
    usage30d = 0
    for ts in events:
        parsed = _parse_iso(ts)
        if parsed is not None and parsed >= cutoff:
            usage30d += 1
    if usage30d == 0 and record.get("lastUsedAt"):
        last = _parse_iso(record.get("lastUsedAt"))
        if last is not None and last >= cutoff:
            usage30d = max(1, int(record.get("usageCount") or 1))
    if usage30d >= HIGH_USAGE_THRESHOLD:
        return "high", usage30d
    if usage30d >= 1:
        return "normal", usage30d
    return "idle", 0


class ModelManager:
    """Thread-safe manager for local model locks, usage metrics, cleanup, and pinned downloads."""

    def __init__(
        self,
        repo_root: Path,
        models_dir: Path,
        state_path: Path,
        *,
        active_jobs_check=None,
        workbench_version: str = APP_VERSION,
        comfy_root: Path | None = None,
        preview_cache_dir: Path | None = None,
        opener=None,
    ):
        self.repo_root = Path(repo_root).resolve()
        self.models_dir = Path(models_dir)
        self.state_path = Path(state_path)
        self.preview_cache_dir = Path(preview_cache_dir) if preview_cache_dir else (self.state_path.parent / "model-previews")
        self.active_jobs_check = active_jobs_check or (lambda: False)
        self.workbench_version = workbench_version or APP_VERSION
        self.comfy_root = Path(comfy_root).resolve() if comfy_root else None
        self.opener = opener or urllib.request.build_opener(_ModelRedirect()).open
        self._lock = threading.RLock()
        self._catalog = load_catalog(self.repo_root)
        self._state = self._load_state()
        self._downloads: dict[str, dict] = {}
        self._cancel_events: dict[str, threading.Event] = {}

    def set_models_dir(self, models_dir: Path, comfy_root: Path | None = None) -> None:
        with self._lock:
            self.models_dir = Path(models_dir)
            if comfy_root is not None:
                self.comfy_root = Path(comfy_root).resolve()

    def _load_state(self) -> dict:
        if self.state_path.is_file():
            try:
                data = json.loads(self.state_path.read_text(encoding="utf-8"))
                if isinstance(data, dict) and isinstance(data.get("models"), dict):
                    return {"formatVersion": 1, "models": dict(data["models"])}
            except (OSError, ValueError):
                pass
        return {"formatVersion": 1, "models": {}}

    def _save_state_locked(self) -> None:
        atomic_write_json(self.state_path, self._state)

    def _record_locked(self, rel_path: str) -> dict:
        models = self._state.setdefault("models", {})
        rec = models.get(rel_path)
        if not isinstance(rec, dict):
            rec = {
                "locked": False,
                "lockedAt": None,
                "lockedBytes": None,
                "lockedSha256": None,
                "usageCount": 0,
                "usageEvents": [],
                "lastUsedAt": None,
                "installedSha256": None,
                "verifiedAt": None,
            }
            models[rel_path] = rec
        return rec

    def _resolve_target_path(self, rel_path: str) -> Path:
        normalized = normalize_model_relpath(rel_path)
        root = self.models_dir.resolve()
        candidate = (root / normalized).resolve()
        try:
            common = os.path.commonpath([str(root), str(candidate)])
        except ValueError as exc:
            raise ModelManagerError("模型路径超出模型根目录。", status=400, code="INVALID_MODEL_PATH") from exc
        if os.path.normcase(common) != os.path.normcase(str(root)):
            raise ModelManagerError("模型路径超出模型根目录。", status=400, code="INVALID_MODEL_PATH")
        raw_path = self.models_dir / normalized
        for parent in (raw_path, *raw_path.parents):
            if parent.is_symlink():
                raise ModelManagerError("禁止通过符号链接访问模型文件。", status=400, code="INVALID_MODEL_PATH")
            if parent == self.models_dir:
                break
        return raw_path

    def _is_safe_model_subpath(self, candidate_path: Path) -> bool:
        try:
            root = self.models_dir.resolve()
            resolved = candidate_path.resolve()
            common = os.path.commonpath([str(root), str(resolved)])
        except (OSError, ValueError):
            return False
        if os.path.normcase(common) != os.path.normcase(str(root)):
            return False
        for parent in (candidate_path, *candidate_path.parents):
            if parent.is_symlink():
                return False
            if parent == self.models_dir:
                break
        return True

    def _scan_sidecar_previews_locked(self) -> dict[tuple[str, str], Path]:
        previews: dict[tuple[str, str], tuple[tuple[int, int], Path]] = {}
        if not self.models_dir.is_dir():
            return {}
        ext_rank = {ext: idx for idx, ext in enumerate(PREVIEW_IMAGE_EXTENSIONS)}
        for subdir_name in SCAN_SUBDIRS:
            subdir = self.models_dir / subdir_name
            if not subdir.is_dir() or subdir.is_symlink():
                continue
            for file_path in subdir.rglob("*"):
                if file_path.is_symlink() or not file_path.is_file():
                    continue
                ext = file_path.suffix.lower()
                if ext not in ext_rank or not self._is_safe_model_subpath(file_path):
                    continue
                try:
                    rel = file_path.relative_to(self.models_dir).as_posix()
                except ValueError:
                    continue
                parent_key = Path(rel).parent.as_posix().casefold()
                stem = file_path.stem.strip().casefold()
                candidates = [((0, ext_rank[ext]), (parent_key, stem))]
                if stem.endswith(".preview") and len(stem) > 8:
                    candidates.append(((1, ext_rank[ext]), (parent_key, stem[:-8].strip())))
                for rank, key in candidates:
                    prev = previews.get(key)
                    if prev is None or rank < prev[0]:
                        previews[key] = (rank, file_path)
        return {key: pair[1] for key, pair in previews.items()}

    def _find_sidecar_preview_locked(self, rel_path: str) -> Path | None:
        parent_rel = Path(rel_path).parent
        parent_dir = self.models_dir / parent_rel
        if not parent_dir.is_dir() or not self._is_safe_model_subpath(parent_dir):
            return None
        target_stem = Path(rel_path).stem.strip().casefold()
        ext_rank = {ext: idx for idx, ext in enumerate(PREVIEW_IMAGE_EXTENSIONS)}
        best: tuple[tuple[int, int], Path] | None = None
        for file_path in parent_dir.iterdir():
            if file_path.is_symlink() or not file_path.is_file():
                continue
            ext = file_path.suffix.lower()
            if ext not in ext_rank or not self._is_safe_model_subpath(file_path):
                continue
            stem = file_path.stem.strip().casefold()
            if stem == target_stem:
                rank = (0, ext_rank[ext])
            elif stem.endswith(".preview") and stem[:-8].strip() == target_stem:
                rank = (1, ext_rank[ext])
            else:
                continue
            if best is None or rank < best[0]:
                best = (rank, file_path)
        return best[1] if best else None

    def get_preview_thumbnail(self, rel_path: str) -> tuple[bytes, str]:
        normalized = normalize_model_relpath(rel_path)
        self._resolve_target_path(normalized)
        with self._lock:
            img_path = self._find_sidecar_preview_locked(normalized)
        if img_path is None or not img_path.is_file() or img_path.is_symlink() or not self._is_safe_model_subpath(img_path):
            raise ModelManagerError("该模型暂无本地封面图。", status=404, code="PREVIEW_NOT_FOUND")
        stat = img_path.stat()
        cache_key = hashlib.sha256(f"{img_path}|{stat.st_mtime_ns}|{stat.st_size}".encode("utf-8")).hexdigest()[:24]
        cache_file = self.preview_cache_dir / f"{cache_key}.jpg"
        if cache_file.is_file():
            try:
                return cache_file.read_bytes(), "image/jpeg"
            except OSError:
                pass
        with Image.open(img_path) as raw_img:
            img = ImageOps.exif_transpose(raw_img)
            img.thumbnail((640, 640), Image.Resampling.LANCZOS)
            if img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info):
                rgba = img.convert("RGBA")
                bg = Image.new("RGB", rgba.size, (12, 12, 14))
                bg.paste(rgba, mask=rgba.split()[3])
                rgb = bg
            else:
                rgb = img.convert("RGB")
            buf = io.BytesIO()
            rgb.save(buf, format="JPEG", quality=82, optimize=True)
            payload = buf.getvalue()
        try:
            self.preview_cache_dir.mkdir(parents=True, exist_ok=True)
            tmp_file = self.preview_cache_dir / f".{cache_key}.{uuid.uuid4().hex[:8]}.part"
            tmp_file.write_bytes(payload)
            os.replace(tmp_file, cache_file)
        except OSError:
            pass
        return payload, "image/jpeg"

    def _discover_installed_paths_locked(self) -> set[str]:
        discovered: set[str] = set()
        if not self.models_dir.is_dir():
            return discovered
        for subdir_name in SCAN_SUBDIRS:
            subdir = self.models_dir / subdir_name
            if not subdir.is_dir() or subdir.is_symlink():
                continue
            for file_path in subdir.rglob("*"):
                if file_path.is_symlink() or not file_path.is_file():
                    continue
                if file_path.suffix.lower() not in ALLOWED_MODEL_EXTENSIONS:
                    continue
                try:
                    rel = file_path.relative_to(self.models_dir).as_posix()
                    discovered.add(normalize_model_relpath(rel))
                except (ValueError, ModelManagerError):
                    continue
        return discovered

    def _build_item_locked(
        self,
        rel_path: str,
        *,
        installed_on_disk: set[str],
        now: dt.datetime,
        sidecar_previews: dict[tuple[str, str], Path] | None = None,
    ) -> dict:
        meta = self._catalog.get(rel_path)
        if meta is None:
            category = rel_path.split("/", 1)[0]
            name = rel_path.rsplit("/", 1)[-1]
            lic = model_license(rel_path)
            meta = {
                "path": rel_path,
                "name": name,
                "title": _friendly_title(name),
                "category": category,
                "group": GROUP_BY_CATEGORY.get(category, "其他模型"),
                "expectedBytes": None,
                "expectedSha256": None,
                "url": None,
                "hasDownloadUrl": False,
                "license": lic.get("license") or "本地自定义权重",
                "licenseUrl": lic.get("licenseUrl"),
                "restrictions": lic.get("restrictions") or lic.get("restriction"),
                "bundles": [],
                "source": "local",
            }
        rec = self._state.get("models", {}).get(rel_path, {})
        file_path = self.models_dir / rel_path
        installed = rel_path in installed_on_disk or (file_path.is_file() and not file_path.is_symlink())
        actual_bytes = 0
        if installed:
            try:
                actual_bytes = file_path.stat().st_size
            except OSError:
                installed = False
                actual_bytes = 0

        locked = bool(rec.get("locked"))
        installed_sha = rec.get("installedSha256") if installed else None
        expected_sha = meta["expectedSha256"]
        expected_bytes = meta["expectedBytes"]
        locked_sha = rec.get("lockedSha256")

        update_available = False
        if installed:
            if expected_sha and installed_sha and installed_sha.lower() != expected_sha.lower():
                update_available = True
            elif expected_bytes and actual_bytes != expected_bytes:
                update_available = True
            elif locked and locked_sha and expected_sha and locked_sha.lower() != expected_sha.lower():
                update_available = True

        download_state = copy.deepcopy(self._downloads.get(rel_path))
        if download_state and download_state.get("phase") in {"downloading", "verifying"}:
            status = download_state["phase"]
        elif not installed:
            status = "not_installed"
        elif update_available:
            status = "update_available"
        else:
            status = "installed"

        usage_tier, usage30d = classify_usage(rec, now=now)
        if not installed:
            recommendation = "available" if meta["hasDownloadUrl"] else "manual"
        elif locked and update_available:
            recommendation = "locked_update_held"
        elif locked:
            recommendation = "keep_locked"
        elif update_available and usage_tier in {"high", "normal"}:
            recommendation = "recommend_update"
        elif usage_tier == "idle":
            recommendation = "recommend_cleanup"
        else:
            recommendation = "keep"

        if sidecar_previews is not None:
            has_local_preview = (Path(rel_path).parent.as_posix().casefold(), Path(rel_path).stem.strip().casefold()) in sidecar_previews
        else:
            has_local_preview = self._find_sidecar_preview_locked(rel_path) is not None

        return {
            "path": rel_path,
            "name": meta["name"],
            "title": meta["title"],
            "category": meta["category"],
            "group": meta["group"],
            "source": meta["source"],
            "bundles": list(meta["bundles"]),
            "license": meta["license"],
            "licenseUrl": meta.get("licenseUrl"),
            "restrictions": meta.get("restrictions"),
            "hasDownloadUrl": bool(meta["hasDownloadUrl"]),
            "hasLocalPreview": has_local_preview,
            "previewUrl": f"/api/models/preview?path={urllib.parse.quote(rel_path, safe='/')}" if has_local_preview else None,
            "installed": installed,
            "actualBytes": actual_bytes,
            "expectedBytes": expected_bytes,
            "expectedSha256": expected_sha,
            "installedSha256": installed_sha,
            "verifiedAt": rec.get("verifiedAt"),
            "locked": locked,
            "lockedAt": rec.get("lockedAt"),
            "lockedBytes": rec.get("lockedBytes"),
            "lockedSha256": locked_sha,
            "usageCount": int(rec.get("usageCount") or 0),
            "usage30d": usage30d,
            "lastUsedAt": rec.get("lastUsedAt"),
            "usageTier": usage_tier,
            "updateAvailable": update_available,
            "status": status,
            "recommendation": recommendation,
            "download": download_state,
        }

    def snapshot(self, *, now: dt.datetime | None = None) -> dict:
        current = (now or dt.datetime.now(dt.timezone.utc)).astimezone(dt.timezone.utc)
        with self._lock:
            installed_on_disk = self._discover_installed_paths_locked()
            sidecar_previews = self._scan_sidecar_previews_locked()
            all_paths = sorted(set(self._catalog) | installed_on_disk)
            items = [
                self._build_item_locked(
                    rel,
                    installed_on_disk=installed_on_disk,
                    sidecar_previews=sidecar_previews,
                    now=current,
                )
                for rel in all_paths
            ]

        installed_items = [item for item in items if item["installed"]]
        idle_reclaimable = [item for item in installed_items if item["usageTier"] == "idle" and not item["locked"]]
        disk_free = 0
        try:
            target = self.models_dir if self.models_dir.exists() else self.repo_root
            disk_free = shutil.disk_usage(target).free
        except OSError:
            disk_free = 0

        summary = {
            "totalCatalogCount": len(items),
            "totalInstalledCount": len(installed_items),
            "totalInstalledBytes": sum(item["actualBytes"] for item in installed_items),
            "lockedCount": sum(1 for item in installed_items if item["locked"]),
            "highCount": sum(1 for item in installed_items if item["usageTier"] == "high"),
            "normalCount": sum(1 for item in installed_items if item["usageTier"] == "normal"),
            "idleCount": sum(1 for item in installed_items if item["usageTier"] == "idle"),
            "idleReclaimableCount": len(idle_reclaimable),
            "idleReclaimableBytes": sum(item["actualBytes"] for item in idle_reclaimable),
            "updateAvailableCount": sum(1 for item in installed_items if item["updateAvailable"]),
            "activeDownloadsCount": sum(1 for item in items if item["status"] in {"downloading", "verifying"}),
            "modelsDir": str(self.models_dir),
            "diskFreeBytes": disk_free,
        }
        return {
            "ok": True,
            "generatedAt": utc_now(),
            "summary": summary,
            "runtimePolicy": {
                "workbenchVersion": self.workbench_version,
                "comfyUpdateMode": "pinned_release",
                "comfyPolicySummary": "ComfyUI 本体与自定义节点随官方认证画布版本统一升级并锁定兼容版本，此处仅安全管理与按使用率清理/更新模型权重。",
            },
            "models": items,
        }

    def record_usage(self, paths: list[str] | tuple[str, ...], *, timestamp: dt.datetime | None = None) -> list[str]:
        """Record usage for one or more model relative paths or unique basenames."""
        ts = (timestamp or dt.datetime.now(dt.timezone.utc)).astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z")
        with self._lock:
            installed_on_disk = self._discover_installed_paths_locked()
            known_paths = set(self._catalog) | installed_on_disk
            by_name: dict[str, list[str]] = {}
            for rel in known_paths:
                by_name.setdefault(rel.rsplit("/", 1)[-1].casefold(), []).append(rel)

            recorded: list[str] = []
            seen: set[str] = set()
            for raw in paths or ():
                if not isinstance(raw, str) or not raw.strip():
                    continue
                cleaned = raw.strip().replace("\\", "/")
                matched_rel = None
                if "/" in cleaned:
                    try:
                        cand = normalize_model_relpath(cleaned)
                        if cand in known_paths:
                            matched_rel = cand
                    except ModelManagerError:
                        matched_rel = None
                if matched_rel is None:
                    base = cleaned.rsplit("/", 1)[-1].casefold()
                    hits = by_name.get(base, [])
                    if len(hits) == 1:
                        matched_rel = hits[0]
                    elif len(hits) > 1:
                        for hit in hits:
                            if cleaned.casefold() in hit.casefold():
                                matched_rel = hit
                                break
                if not matched_rel or matched_rel in seen:
                    continue
                seen.add(matched_rel)
                rec = self._record_locked(matched_rel)
                rec["usageCount"] = int(rec.get("usageCount") or 0) + 1
                events = list(rec.get("usageEvents") or [])
                events.append(ts)
                rec["usageEvents"] = events[-MAX_USAGE_EVENTS:]
                rec["lastUsedAt"] = ts
                recorded.append(matched_rel)

            if recorded:
                self._save_state_locked()
            return recorded

    def record_workflow_usage(self, workflow: dict | None, *, timestamp: dt.datetime | None = None) -> list[str]:
        """Extract referenced model filenames from a ComfyUI prompt graph and record usage."""
        if not isinstance(workflow, dict):
            return []
        candidates: list[str] = []
        for node in workflow.values():
            if not isinstance(node, dict):
                continue
            inputs = node.get("inputs")
            if not isinstance(inputs, dict):
                continue
            for key, value in inputs.items():
                if not isinstance(value, str) or not value.strip():
                    continue
                low_key = str(key).lower()
                if (
                    low_key in WORKFLOW_MODEL_KEYS
                    or low_key.endswith("_name")
                    or Path(value).suffix.lower() in ALLOWED_MODEL_EXTENSIONS
                ):
                    candidates.append(value.strip())
        return self.record_usage(candidates, timestamp=timestamp)

    def set_lock(self, rel_path: str, locked: bool) -> dict:
        if not isinstance(locked, bool):
            raise ModelManagerError("locked 字段必须是布尔值。", status=400, code="BAD_REQUEST")
        normalized = normalize_model_relpath(rel_path)
        target = self._resolve_target_path(normalized)
        with self._lock:
            installed_on_disk = self._discover_installed_paths_locked()
            if normalized not in self._catalog and normalized not in installed_on_disk:
                raise ModelManagerError("未找到指定的模型记录。", status=404, code="MODEL_NOT_FOUND")
            rec = self._record_locked(normalized)
            rec["locked"] = locked
            if locked:
                rec["lockedAt"] = utc_now()
                if target.is_file() and not target.is_symlink():
                    rec["lockedBytes"] = target.stat().st_size
                    rec["lockedSha256"] = rec.get("installedSha256")
            else:
                rec["lockedAt"] = None
            self._save_state_locked()
            now = dt.datetime.now(dt.timezone.utc)
            item = self._build_item_locked(normalized, installed_on_disk=installed_on_disk, now=now)
        return {"ok": True, "model": item, "snapshot": self.snapshot(now=now)}

    def lock_all_installed(self) -> dict:
        with self._lock:
            installed_on_disk = self._discover_installed_paths_locked()
            locked_now = 0
            timestamp = utc_now()
            for rel in sorted(installed_on_disk):
                rec = self._record_locked(rel)
                if not rec.get("locked"):
                    locked_now += 1
                rec["locked"] = True
                rec["lockedAt"] = rec.get("lockedAt") or timestamp
                try:
                    rec["lockedBytes"] = (self.models_dir / rel).stat().st_size
                except OSError:
                    pass
                rec["lockedSha256"] = rec.get("installedSha256")
            self._save_state_locked()
        snap = self.snapshot()
        return {"ok": True, "newlyLockedCount": locked_now, **snap}

    def verify_model(self, rel_path: str) -> dict:
        normalized = normalize_model_relpath(rel_path)
        target = self._resolve_target_path(normalized)
        if not target.is_file():
            raise ModelManagerError("目标模型文件尚未下载。", status=404, code="MODEL_NOT_FOUND")
        hasher = hashlib.sha256()
        with target.open("rb") as handle:
            for chunk in iter(lambda: handle.read(4 * 1024 * 1024), b""):
                hasher.update(chunk)
        digest = hasher.hexdigest()
        actual_bytes = target.stat().st_size
        with self._lock:
            rec = self._record_locked(normalized)
            rec["installedSha256"] = digest
            rec["verifiedAt"] = utc_now()
            self._save_state_locked()
            meta = self._catalog.get(normalized, {})
        expected_sha = meta.get("expectedSha256")
        matched = (digest == expected_sha) if expected_sha else True
        return {
            "ok": True,
            "path": normalized,
            "sha256": digest,
            "expectedSha256": expected_sha,
            "matched": matched,
            "actualBytes": actual_bytes,
            "snapshot": self.snapshot(),
        }

    def delete_model(self, rel_path: str) -> dict:
        normalized = normalize_model_relpath(rel_path)
        target = self._resolve_target_path(normalized)
        with self._lock:
            rec = self._state.get("models", {}).get(normalized, {})
            if rec.get("locked"):
                raise ModelManagerError("该模型已锁定保护，请先解锁后再删除。", status=409, code="MODEL_LOCKED")
            active_dl = self._downloads.get(normalized)
            if active_dl and active_dl.get("phase") in {"downloading", "verifying"}:
                raise ModelManagerError("该模型正在下载，请先取消后再操作。", status=409, code="MODEL_DOWNLOADING")
            if self.active_jobs_check():
                raise ModelManagerError("当前有生成任务正在运行，请等待完成或取消后再删除模型。", status=409, code="MODEL_IN_USE")
            if not target.is_file():
                raise ModelManagerError("本地不存在该模型文件。", status=404, code="MODEL_NOT_FOUND")
            freed_bytes = target.stat().st_size
            target.unlink()
            if normalized in self._state.get("models", {}):
                self._state["models"][normalized]["installedSha256"] = None
                self._state["models"][normalized]["verifiedAt"] = None
                self._save_state_locked()
        return {"ok": True, "path": normalized, "freedBytes": freed_bytes, "snapshot": self.snapshot()}

    def start_download(self, rel_path: str, *, allow_http_for_tests: bool = False) -> dict:
        normalized = normalize_model_relpath(rel_path)
        target = self._resolve_target_path(normalized)
        with self._lock:
            meta = self._catalog.get(normalized)
            if not meta or not meta.get("url"):
                raise ModelManagerError("该模型暂无官方固定下载地址，请按作者页说明手动安装。", status=400, code="MODEL_SOURCE_UNAVAILABLE")
            rec = self._state.get("models", {}).get(normalized, {})
            if rec.get("locked"):
                raise ModelManagerError("该模型已锁定当前版本；如需更新请先解锁。", status=409, code="MODEL_LOCKED")
            active_dl = self._downloads.get(normalized)
            if active_dl and active_dl.get("phase") in {"downloading", "verifying"}:
                raise ModelManagerError("该模型正在下载中。", status=409, code="MODEL_DOWNLOADING")
            if self.active_jobs_check():
                raise ModelManagerError("当前有生成任务正在运行，请等待完成或取消后再更新模型。", status=409, code="MODEL_IN_USE")

            url = str(meta["url"])
            parsed = urllib.parse.urlsplit(url)
            if not allow_http_for_tests and parsed.scheme != "https":
                raise ModelManagerError("仅允许从受信任的 HTTPS 官方来源下载模型。", status=400, code="MODEL_SOURCE_UNSAFE")

            expected_bytes = int(meta.get("expectedBytes") or 0)
            target.parent.mkdir(parents=True, exist_ok=True)
            if expected_bytes > 0:
                free = shutil.disk_usage(target.parent).free
                if free < expected_bytes + 16 * 1024 * 1024:
                    raise ModelManagerError("模型目标磁盘剩余空间不足，请先清理空间。", status=409, code="MODEL_DISK_FULL")

            cancel_event = threading.Event()
            self._cancel_events[normalized] = cancel_event
            progress = {
                "path": normalized,
                "phase": "downloading",
                "bytesDownloaded": 0,
                "totalBytes": expected_bytes,
                "percent": 0,
                "error": "",
                "startedAt": utc_now(),
            }
            self._downloads[normalized] = progress

            worker = threading.Thread(
                target=self._run_download,
                args=(normalized, target, url, expected_bytes, meta.get("expectedSha256"), cancel_event),
                daemon=True,
            )
            worker.start()
        return {"ok": True, "path": normalized, "download": copy.deepcopy(progress)}

    def cancel_download(self, rel_path: str) -> dict:
        normalized = normalize_model_relpath(rel_path)
        with self._lock:
            event = self._cancel_events.get(normalized)
            active = self._downloads.get(normalized)
            if not event or not active or active.get("phase") not in {"downloading", "verifying"}:
                raise ModelManagerError("该模型当前没有进行中的下载任务。", status=404, code="DOWNLOAD_NOT_FOUND")
            event.set()
            active["phase"] = "cancelled"
        return {"ok": True, "path": normalized}

    def _run_download(
        self,
        rel_path: str,
        target: Path,
        url: str,
        expected_bytes: int,
        expected_sha256: str | None,
        cancel_event: threading.Event,
    ) -> None:
        temp_path = target.parent / f".h3-model-{uuid.uuid4().hex}.part"
        hasher = hashlib.sha256()
        count = 0
        try:
            with self.opener(url, timeout=60) as response, temp_path.open("xb") as stream:
                header_len = response.headers.get("Content-Length") if getattr(response, "headers", None) else None
                total_hint = expected_bytes or (int(header_len) if header_len and str(header_len).isdigit() else 0)
                while True:
                    if cancel_event.is_set():
                        raise ModelManagerError("已取消模型下载。", status=499, code="DOWNLOAD_CANCELLED")
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    count += len(chunk)
                    if expected_bytes > 0 and count > expected_bytes:
                        raise ModelManagerError("下载字节数超出模型清单声明大小，已中止。", status=502, code="MODEL_SIZE_MISMATCH")
                    stream.write(chunk)
                    hasher.update(chunk)
                    pct = int(min(99, (count * 100) // total_hint)) if total_hint > 0 else 0
                    with self._lock:
                        dl = self._downloads.get(rel_path)
                        if dl is not None:
                            dl.update({"bytesDownloaded": count, "totalBytes": total_hint, "percent": pct})
                stream.flush()
                os.fsync(stream.fileno())

            if cancel_event.is_set():
                raise ModelManagerError("已取消模型下载。", status=499, code="DOWNLOAD_CANCELLED")

            with self._lock:
                dl = self._downloads.get(rel_path)
                if dl is not None:
                    dl["phase"] = "verifying"

            if expected_bytes > 0 and count != expected_bytes:
                raise ModelManagerError("模型大小与清单不一致，未替换本地文件。", status=502, code="MODEL_SIZE_MISMATCH")
            digest = hasher.hexdigest()
            if expected_sha256 and digest != expected_sha256.lower():
                raise ModelManagerError("模型 SHA-256 校验失败，已丢弃损坏文件。", status=502, code="MODEL_HASH_MISMATCH")

            # Check symlink safety right before replace
            self._resolve_target_path(rel_path)
            os.replace(temp_path, target)

            with self._lock:
                rec = self._record_locked(rel_path)
                rec["installedSha256"] = digest
                rec["verifiedAt"] = utc_now()
                self._save_state_locked()
                self._downloads[rel_path] = {
                    "path": rel_path,
                    "phase": "completed",
                    "bytesDownloaded": count,
                    "totalBytes": count,
                    "percent": 100,
                    "error": "",
                    "completedAt": utc_now(),
                }
        except ModelManagerError as exc:
            with self._lock:
                self._downloads[rel_path] = {
                    "path": rel_path,
                    "phase": "cancelled" if exc.code == "DOWNLOAD_CANCELLED" else "error",
                    "bytesDownloaded": count,
                    "totalBytes": expected_bytes,
                    "percent": 0,
                    "error": exc.message,
                }
        except Exception as exc:
            with self._lock:
                self._downloads[rel_path] = {
                    "path": rel_path,
                    "phase": "error",
                    "bytesDownloaded": count,
                    "totalBytes": expected_bytes,
                    "percent": 0,
                    "error": f"下载失败：{exc}",
                }
        finally:
            temp_path.unlink(missing_ok=True)
            with self._lock:
                self._cancel_events.pop(rel_path, None)
