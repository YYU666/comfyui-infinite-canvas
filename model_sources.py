"""Reviewed author/official-distributor sources; never resolve moving HF refs at runtime."""
from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
import re
from urllib.parse import quote, urlsplit


def validate_source(source):
    repo, revision = source.get("repository", ""), source.get("revision", "")
    filename = source.get("filename", "")
    target = source.get("path", "")
    for value in (filename, target):
        if not isinstance(value, str) or not value or any(part in ("", ".", "..") for part in value.split("/")) or any(c in value for c in '\\:\x00\r\n?*<>|"'):
            raise ValueError("模型文件或目标路径无效。")
        if not value.lower().endswith((".safetensors", ".gguf")):
            raise ValueError("自动下载仅支持 safetensors 或 GGUF 权重；辅助文件须按作者说明手动安装。")
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo):
        raise ValueError("模型缺少已核实的官方仓库。")
    if not re.fullmatch(r"[a-f0-9]{40}", revision):
        raise ValueError("模型必须固定 Hugging Face commit revision，不能使用 main 或 tag。")
    if not filename or any(p in ("", ".", "..") for p in filename.split("/")) or any(c in filename for c in "\\:\x00\r\n"):
        raise ValueError("模型源文件路径无效。")
    if not re.fullmatch(r"[a-f0-9]{64}", source.get("sha256", "")):
        raise ValueError("模型缺少已核实的 SHA-256，禁止仅按大小下载。")
    if type(source.get("bytes")) is not int or source["bytes"] <= 0:
        raise ValueError("模型文件大小无效。")
    expected = f"https://huggingface.co/{repo}/resolve/{revision}/{quote(filename, safe='/')}"
    if source.get("url", expected) != expected or urlsplit(expected).hostname != "huggingface.co":
        raise ValueError("模型下载地址不匹配已固定的官方来源。")
    return {**source, "url": expected, "verification": "sha256"}


def locked_sources():
    document = json.loads((Path(__file__).parent / "models/official-sources.lock.json").read_text(encoding="utf-8"))
    if document.get("schemaVersion") != 1:
        raise ValueError("模型来源锁版本无效。")
    result = {}
    for row in document["files"]:
        source = validate_source(row)
        if source["path"] in result:
            raise ValueError("模型来源锁包含重复文件。")
        result[source["path"]] = source
    return result


@lru_cache(maxsize=1)
def _license_records():
    root = Path(__file__).parent / 'models'
    records = {row['path']: row for row in json.loads((root / 'licenses.json').read_text(encoding='utf-8'))['files']}
    for row in locked_sources().values():
        records.setdefault(row['path'], row)
    notices = json.loads((root / 'license-notices.json').read_text(encoding='utf-8'))
    h3_image = json.loads((root / 'h3-image-sources.json').read_text(encoding='utf-8'))
    for row in h3_image['files']:
        records[row['path']] = {**row, **notices['h3Image']}
    klein = json.loads((root / 'flux3-klein.json').read_text(encoding='utf-8'))
    for row in klein['files']:
        records[row['path']] = {**row, 'license': klein['license']['name'], 'licenseUrl': klein['license']['url']}
    for row in records.values():
        if 'H3' in row.get('license', ''):
            notice = notices['h3Image' if 'H3-Image' in row['license'] else 'h3Video']
            row.update({key: notice[key] for key in ('restriction', 'excludedTerritories')})
            row['territoryLicenseUrl'] = notice['licenseUrl']
            if row['license'].startswith(('MiniMax H3', 'MiniMax-H3')):
                row['licenseUrl'] = notice['licenseUrl']
    return records


def model_license(path):
    row = _license_records().get(path.replace('\\', '/'), {})
    return {key: row[key] for key in ('license', 'licenseUrl', 'restrictions', 'restriction', 'excludedTerritories', 'territoryLicenseUrl') if key in row} or {'license': '许可待核实', 'restrictions': '精确权重的许可尚未核实，请查作者原文。'}
