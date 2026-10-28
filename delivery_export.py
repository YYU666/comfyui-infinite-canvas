from __future__ import annotations

import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import tempfile
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path

import imageio_ffmpeg
from PIL import Image, ImageDraw, ImageFont

from project_store import StoreError, validate_name
from workbench_lifecycle import utc_now

IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}


def _code(value, prefix):
    match = re.search(r"(\d+)$", str(value or ""))
    if match:
        return f"{prefix}{int(match.group(1)):02d}"
    cleaned = re.sub(r"[^A-Za-z0-9_-]", "", str(value or "")).upper()
    return cleaned or prefix


def _source(store, project_id, relative):
    try:
        return store.asset_file(project_id, relative)
    except StoreError as error:
        raise StoreError("EXPORT_ASSET_INVALID", "导出素材路径无效。", details={"asset": relative}) from error


def _download_comfy_output(output, target):
    if not isinstance(output, dict):
        raise StoreError("EXPORT_ASSET_MISSING", "外部结果缺少 ComfyUI 输出信息。")
    filename = output.get("filename")
    subfolder = str(output.get("subfolder") or "").replace("\\", "/")
    kind = output.get("type", "output")
    if (not isinstance(filename, str) or Path(filename).name != filename
            or Path(filename).suffix.lower() not in {*IMAGE_EXTENSIONS, ".mp4", ".mov", ".webm"}
            or ".." in Path(subfolder).parts or kind not in {"input", "output", "temp"}):
        raise StoreError("EXPORT_ASSET_INVALID", "ComfyUI 输出路径无效。")
    query = urllib.parse.urlencode({"filename": filename, "subfolder": subfolder, "type": kind})
    base = os.environ.get("H3_COMFY_URL", "http://127.0.0.1:8188").rstrip("/")
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(f".{target.name}.download")
    try:
        with urllib.request.urlopen(f"{base}/view?{query}", timeout=60) as response, temporary.open("wb") as destination:
            size = 0
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > 2 * 1024 * 1024 * 1024:
                    raise StoreError("EXPORT_ASSET_INVALID", "外部结果超过 2 GB 导出限制。")
                destination.write(chunk)
        os.replace(temporary, target)
        return target
    except (OSError, urllib.error.URLError, TimeoutError) as error:
        raise StoreError("EXPORT_ASSET_MISSING", "无法读取 ComfyUI 外部结果，请确认输出仍在原位置。", details={"filename": filename, "error": str(error)}) from error
    finally:
        temporary.unlink(missing_ok=True)


def _sha256(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def _thumbnail(source, poster, target):
    if source.suffix.lower() in IMAGE_EXTENSIONS:
        with Image.open(source) as image:
            image.convert("RGB").save(target, "JPEG", quality=90)
        return
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    command = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y"]
    if poster:
        command += ["-i", str(poster)]
    else:
        command += ["-ss", "0.5", "-i", str(source)]
    command += ["-frames:v", "1", "-vf", "scale=640:-2", str(target)]
    try:
        subprocess.run(command, check=True, capture_output=True, timeout=30)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        detail = error.stderr.decode("utf-8", errors="replace")[-500:] if isinstance(error, subprocess.CalledProcessError) else "缩略图生成超时"
        raise StoreError("EXPORT_THUMBNAIL_FAILED", "无法生成联系表缩略图。", details={"file": source.name, "error": detail}) from error


def _font(size):
    for path in (Path("C:/Windows/Fonts/msyh.ttc"), Path("C:/Windows/Fonts/arial.ttf")):
        if path.is_file():
            return ImageFont.truetype(str(path), size)
    return ImageFont.load_default(size=size)


def _contact_sheet(rows, target, project_name):
    columns, thumb_w, thumb_h, label_h, gap = 4, 320, 180, 42, 16
    count = len(rows)
    width = gap + columns * (thumb_w + gap)
    height = 76 + math.ceil(count / columns) * (thumb_h + label_h + gap)
    sheet = Image.new("RGB", (width, height), "#15181d")
    draw = ImageDraw.Draw(sheet)
    draw.text((gap, 18), f"{project_name} · {count} 条选中成片", fill="#f4f6f8", font=_font(24))
    for index, row in enumerate(rows):
        x = gap + (index % columns) * (thumb_w + gap)
        y = 68 + (index // columns) * (thumb_h + label_h + gap)
        with Image.open(row["thumbnail"]) as image:
            image = image.convert("RGB")
            image.thumbnail((thumb_w, thumb_h))
            frame = Image.new("RGB", (thumb_w, thumb_h), "#282d34")
            frame.paste(image, ((thumb_w - image.width) // 2, (thumb_h - image.height) // 2))
            sheet.paste(frame, (x, y))
        draw.text((x + 4, y + thumb_h + 8), f"{row['code']}   评级 {row['rating']}/5", fill="#e7ebef", font=_font(18))
    jpg = target / "contact-sheet.jpg"
    pdf = target / "contact-sheet.pdf"
    sheet.save(jpg, "JPEG", quality=90, optimize=True)
    sheet.save(pdf, "PDF", resolution=150.0)
    return jpg, pdf


def export_delivery(store, project_id, take_ids=None, now=None):
    document = store.get(project_id)
    project_dir = store._project_path(project_id).parent
    requested = set(take_ids) if take_ids is not None else None
    selected = []
    for shot in document["shots"]:
        for take in shot["takes"]:
            if (requested is None and take["selected"]) or (requested is not None and take["id"] in requested):
                selected.append((shot, take))
    if requested is not None and len(selected) != len(requested):
        found = {take["id"] for _, take in selected}
        raise StoreError("EXPORT_TAKE_NOT_FOUND", "部分选中 Take 不存在。", details={"missing": sorted(requested - found)})
    if not selected:
        raise StoreError("EXPORT_EMPTY", "没有可导出的选中成片。")

    prepared = []
    used_paths = set()
    for shot, take in selected:
        shot_code = _code(shot["number"] or shot["id"], "S")
        take_code = _code(take["id"], "T")
        code = f"{shot_code}_{take_code}"
        try:
            source = _source(store, project_id, take["asset"])
        except StoreError:
            output = take.get("recipe", {}).get("output")
            if not output:
                raise
            extension = Path(str(output.get("filename") or "")).suffix.lower()
            if not extension:
                raise StoreError("EXPORT_ASSET_INVALID", "外部结果缺少有效扩展名。")
            source = _download_comfy_output(output, project_dir / "outputs" / shot_code / f"{code}{extension}")
        poster = _source(store, project_id, take["poster"]) if take.get("poster") else None
        relative = f"{shot_code}/{code}{source.suffix.lower()}"
        if relative in used_paths:
            raise StoreError("EXPORT_NAME_CONFLICT", "镜头或 Take 编号会产生重名文件。", details={"path": relative})
        used_paths.add(relative)
        prepared.append({"shot": shot, "take": take, "source": source, "poster": poster, "code": code, "relative": relative})

    date = (now or datetime.now()).strftime("%Y%m%d")
    target = project_dir / "exports" / f"{validate_name(document['name'])}-{date}"
    target.mkdir(parents=True, exist_ok=True)
    manifest = {
        "schemaVersion": 1,
        "project": {"id": document["id"], "name": document["name"], "revision": document["revision"]},
        "exportedAt": utc_now(),
        "contactSheet": {"jpg": "contact-sheet.jpg", "pdf": "contact-sheet.pdf"},
        "items": [],
    }
    with tempfile.TemporaryDirectory(prefix=".thumbnails-", dir=target) as temporary:
        temporary = Path(temporary)
        contact_rows = []
        for item in prepared:
            shot, take, source = item["shot"], item["take"], item["source"]
            destination = target / item["relative"]
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)
            thumbnail = temporary / f"{item['code']}.jpg"
            _thumbnail(source, item["poster"], thumbnail)
            contact_rows.append({"code": item["code"], "rating": take["rating"], "thumbnail": thumbnail})
            references = {
                "characterId": shot["characterId"], "outfitId": shot["outfitId"], "locationId": shot["locationId"],
                "recipeRefs": (take["recipe"].get("refs") or []),
            }
            manifest["items"].append({
                "shotId": shot["id"], "takeId": take["id"], "file": item["relative"],
                "prompt": shot["prompt"], "seed": shot["params"]["seed"], "references": references,
                "rating": take["rating"], "selected": take["selected"], "recipe": take["recipe"],
                "source": {"asset": take["asset"], "bytes": destination.stat().st_size, "sha256": _sha256(destination)},
            })
        jpg, pdf = _contact_sheet(contact_rows, target, document["name"])
    manifest_path = target / "manifest.json"
    temporary_manifest = manifest_path.with_suffix(".json.tmp")
    temporary_manifest.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary_manifest.replace(manifest_path)
    return {"path": str(target), "count": len(prepared), "manifest": str(manifest_path), "contactSheet": {"jpg": str(jpg), "pdf": str(pdf)}}
