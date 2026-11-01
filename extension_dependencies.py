"""Inspect data-only workflow dependencies and fetch trusted, pinned resources."""
from __future__ import annotations

import copy
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import threading
import urllib.error
import urllib.parse
import urllib.request
import uuid

from workflow_extensions import ExtensionError, ExtensionStore, MAX_ARCHIVE, comfy_input_fields, inspect_package, require, scalar

WEIGHT_SUFFIXES = (".safetensors", ".ckpt", ".pt", ".pth", ".bin", ".gguf")
MODEL_FIELDS = {
    "ckpt_name": "checkpoints", "checkpoint": "checkpoints", "checkpoint_name": "checkpoints",
    "lora_name": "loras", "lora": "loras", "vae_name": "vae",
    "unet_name": "diffusion_models", "diffusion_model": "diffusion_models",
    "clip_name": "text_encoders", "clip_name1": "text_encoders", "clip_name2": "text_encoders", "clip_name3": "text_encoders",
    "control_net_name": "controlnet", "upscale_model": "upscale_models",
}
OFFICIAL_EXTRAS = {
    "checkpoints/sam3.1_multiplex_fp16.safetensors": "Comfy-Org/sam3.1/resolve/main/checkpoints/sam3.1_multiplex_fp16.safetensors",
    "diffusion_models/seedvr2_3b_int8_convrot.safetensors": "Comfy-Org/SeedVR2/resolve/main/diffusion_models/seedvr2_3b_int8_convrot.safetensors",
    "latent_upscale_models/minimax_h3_latent_upscaler_3d_conv_v1_fp16.safetensors": "LBH-123-AI/Minimax_h3_latent_Upscaler/resolve/main/minimax_h3_latent_upscaler_3d_conv_v1/minimax_h3_latent_upscaler_3d_conv_v1_fp16.safetensors",
    "loras/Krea2-四视图QuadView_krea2_v1.safetensors": "Alissonerdx/CharacterSheet/resolve/main/QuadView_krea2_v1.safetensors",
    "loras/krea2_identity_edit_v2.safetensors": "conradlocke/krea2-identity-edit/resolve/main/krea2_identity_edit_v2.safetensors",
}


def canonical_sources():
    root = Path(__file__).resolve().parent / "models"
    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    licenses = {row["path"]: row for row in json.loads((root / "licenses.json").read_text(encoding="utf-8"))["files"]}
    core = set(manifest["profiles"]["core-h3"]["files"])
    sources = {}
    for row in manifest["files"]:
        path = row["path"]
        remote = "Comfy-Org/MiniMax-H3/resolve/main/" + path if path in core else OFFICIAL_EXTRAS.get(path)
        if remote:
            license_row = licenses.get(path, {})
            sources[path] = {**row, "url": "https://huggingface.co/" + urllib.parse.quote(remote, safe="/"),
                             "license": license_row.get("license", "未知"), "licenseUrl": license_row.get("licenseUrl", ""),
                             "verification": "sha256" if row.get("sha256") else "size-only"}
    return sources


def _safe_model_name(value):
    if not isinstance(value, str) or not value or len(value) > 1024:
        return False
    parts = value.replace("\\", "/").split("/")
    return not any(c in value for c in ":\x00\r\n") and all(part not in {"", ".", ".."} for part in parts)


def _choices(info, field):
    for section in comfy_input_fields(info):
        spec = section.get(field)
        if isinstance(spec, (list, tuple)) and spec and isinstance(spec[0], list):
            return [v for v in spec[0] if isinstance(v, str)]
    return None


def _category(class_type, field, name):
    if field in MODEL_FIELDS:
        return MODEL_FIELDS[field]
    if field.startswith("lora_name_"):
        return "loras"
    if field == "model_name":
        # These exact classes are used by the workbench/core ComfyUI; custom
        # class-name resemblance cannot establish a model-folder contract.
        return {"UpscaleModelLoader": "upscale_models", "MinimaxH3LatentUpscaler3D": "latent_upscale_models"}.get(class_type, "unknown")
    return "unknown"


def dependency_report(bundle, payload, object_info, sources=None):
    require(isinstance(payload, dict) and set(payload) <= {"nodeDefinitionId", "parameters"}, "依赖检查请求字段无效。")
    require(isinstance(object_info, dict), "ComfyUI 节点信息无效。", "COMFY_UNAVAILABLE")
    chosen = next((n for n in bundle["nodes"] if n["definition"]["nodeDefinitionId"] == payload.get("nodeDefinitionId")), None)
    require(chosen is not None, "节点定义不存在。")
    definition, workflow = chosen["definition"], copy.deepcopy(chosen["workflow"])
    parameters = payload.get("parameters", {})
    properties = definition["parameters"]["properties"]
    require(isinstance(parameters, dict) and set(parameters) <= set(properties), "包含未知工作流参数。")
    values = {}
    for key, spec in properties.items():
        require(key in parameters or "default" in spec, f"缺少参数 {key}。")
        values[key] = parameters.get(key, spec.get("default"))
        scalar(values[key], spec, key)
    bindings = {}
    for binding in definition["bindings"]:
        if binding["sourceKind"] == "parameter":
            target = (binding["nodeId"], binding["input"])
            bindings[target] = binding["sourceId"]
            workflow[target[0]]["inputs"][target[1]] = values[binding["sourceId"]]
    sources = canonical_sources() if sources is None else sources
    models = []
    for node_id, node in workflow.items():
        node_info = object_info.get(node["class_type"], {})
        for field, name in node["inputs"].items():
            if not isinstance(name, str) or name.strip().lower() in {"", "none", "null", "disabled"}:
                continue
            if not name.lower().endswith(WEIGHT_SUFFIXES) and field not in MODEL_FIELDS and field != "model_name":
                continue
            # Filename strings are dependencies only when they are model fields or loader enums.
            choices = _choices(node_info, field)
            category = _category(node["class_type"], field, name)
            if category == "unknown" and choices is None and not any(word in field.lower() for word in ("model", "lora", "vae", "clip", "unet", "encoder", "checkpoint", "weight")):
                continue
            if not _safe_model_name(name):
                status = "unknown"
            else:
                status = "installed" if choices is not None and name in choices else "missing" if choices is not None else "unknown"
            parameter_id = bindings.get((node_id, field))
            parameter_schema = properties.get(parameter_id, {})
            candidates = []
            if parameter_id:
                for value in choices or []:
                    if value == name or not _safe_model_name(value) or not value.lower().endswith(WEIGHT_SUFFIXES):
                        continue
                    try:
                        scalar(value, parameter_schema, parameter_id)
                    except ExtensionError:
                        continue
                    candidates.append({"name": value, "compatibility": "loader-option", "reason": "本机同一加载器可选；架构、量化和效果需自行确认"})
            path = category + "/" + name.replace("\\", "/")
            source = sources.get(path) if _safe_model_name(name) else None
            models.append({"id": node_id + ":" + field, "nodeId": node_id, "inputName": field,
                           "parameterId": parameter_id, "name": name, "category": category, "status": status,
                           "installedEvidence": "loader-enumeration" if status == "installed" else None,
                           "candidates": candidates[:1000], "candidatesTruncated": len(candidates) > 1000,
                           "download": source if status != "installed" else None})
    classes = [{"classType": value, "installed": value in object_info} for value in sorted({node["class_type"] for node in workflow.values()})]
    missing = sum(row["status"] != "installed" for row in models)
    missing_nodes = sum(not row["installed"] for row in classes)
    lines = [f"{row['category']}: {row['name']}" for row in models]
    lines += ["ComfyUI 节点: " + ", ".join(row["classType"] for row in classes)]
    return {"models": models, "comfyNodes": classes, "summary": "\n".join(lines),
            "ready": not missing and not missing_nodes, "missingModels": missing, "missingNodes": missing_nodes}


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ExtensionError("目录下载发生了不允许的跳转。", "CATALOG_FETCH_FAILED", 502)


class _ModelRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        parsed = urllib.parse.urlsplit(newurl)
        host = (parsed.hostname or "").lower()
        allowed = host == "huggingface.co" or host.endswith(".huggingface.co") or host.endswith(".hf.co") or host.endswith(".xethub.hf.co")
        require(parsed.scheme == "https" and parsed.port in (None, 443) and not parsed.username and not parsed.password and allowed,
                "模型下载跳转到不受信任的来源。", "DOWNLOAD_SOURCE_BLOCKED")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def catalog_import(store, payload, opener=None):
    require(isinstance(payload, dict) and set(payload) == {"packageId", "version", "digest"}, "目录导入请求字段无效。")
    package_id, version, digest = (payload[key] for key in ("packageId", "version", "digest"))
    require(isinstance(package_id, str) and re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,99}/[a-z0-9][a-z0-9._-]{0,99}", package_id), "目录包名称无效。")
    require(isinstance(version, str) and re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?", version) and len(version) <= 100, "目录版本无效。")
    digest = digest.removeprefix("sha256:") if isinstance(digest, str) else ""
    require(re.fullmatch(r"[a-f0-9]{64}", digest), "目录摘要无效。")
    url = f"https://refmuse.cn/api/open/items/{package_id}/versions/{urllib.parse.quote(version, safe='')}/download"
    opener = opener or urllib.request.build_opener(_NoRedirect()).open
    try:
        with opener(url, timeout=30) as response:
            data = response.read(MAX_ARCHIVE + 1)
        require(0 < len(data) <= MAX_ARCHIVE, "目录包超过 64 MiB。", "PACKAGE_UNSAFE")
        require(hashlib.sha256(data).hexdigest() == digest, "目录包内容与选定摘要不一致。", "DIGEST_MISMATCH")
        bundle = inspect_package(data)
        require(bundle["manifest"]["packageId"] == package_id and bundle["manifest"]["version"] == version, "目录包身份或版本不一致。", "PACKAGE_IDENTITY_MISMATCH")
        return store.import_bytes(data, package_id.split("/")[1] + ".h3pack")
    except (OSError, urllib.error.URLError) as exc:
        raise ExtensionError("无法下载 Refmuse 节点包，请稍后重试。", "CATALOG_FETCH_FAILED", 502) from exc


class ModelDownloads:
    """One bounded, explicit download job at a time; never accepts caller URLs/paths."""
    def __init__(self, comfy_root, sources=None, opener=None):
        self.root = Path(comfy_root) / "ComfyUI" / "models" if comfy_root else None
        self.sources = canonical_sources() if sources is None else sources
        self.opener = opener or urllib.request.build_opener(_ModelRedirect()).open
        self.jobs = {}
        self.lock = threading.RLock()

    def get(self, job_id):
        with self.lock:
            job = self.jobs.get(job_id)
            if job is None:
                raise ExtensionError("下载任务不存在或服务已经重启。", "DOWNLOAD_JOB_NOT_FOUND", 404)
            return copy.deepcopy(job)

    def start(self, report, model_ids):
        require(self.root is not None and (self.root.parent / "main.py").is_file(), "ComfyUI 模型目录未配置。", "MODEL_ROOT_UNAVAILABLE")
        require(isinstance(model_ids, list) and model_ids and len(model_ids) <= 100 and all(isinstance(v, str) for v in model_ids), "请选择要补齐的模型。")
        selected = {row["id"]: row for row in report["models"]}
        require(len(set(model_ids)) == len(model_ids) and set(model_ids) <= set(selected), "包含未知或重复模型。")
        sources = {}
        for model_id in model_ids:
            row = selected[model_id]
            source = row.get("download")
            require(source is not None and source.get("path") in self.sources, "所选模型没有已核实的官方下载来源。", "MODEL_SOURCE_UNKNOWN")
            trusted = self.sources[source["path"]]
            sources[trusted["path"]] = trusted
        fingerprint = hashlib.sha256(json.dumps(sorted(sources)).encode()).hexdigest()
        with self.lock:
            for job in self.jobs.values():
                if job["status"] in ("queued", "running"):
                    if job["requestKey"] == fingerprint:
                        return copy.deepcopy(job)
                    raise ExtensionError("已有模型下载任务，请等待完成。", "DOWNLOAD_BUSY", 409)
            while len(self.jobs) >= 64:
                del self.jobs[next(iter(self.jobs))]
            job_id = uuid.uuid4().hex
            job = {"jobId": job_id, "status": "queued", "requestKey": fingerprint, "completed": 0,
                   "total": len(sources), "downloadedBytes": 0, "totalBytes": sum(s["bytes"] for s in sources.values()),
                   "currentModel": "", "error": "", "files": []}
            self.jobs[job_id] = job
            threading.Thread(target=self._run, args=(job_id, list(sources.values())), daemon=True).start()
            return copy.deepcopy(job)

    def _update(self, job_id, **fields):
        with self.lock:
            self.jobs[job_id].update(fields)

    def _run(self, job_id, sources):
        downloaded = 0
        try:
            self._update(job_id, status="running")
            for index, source in enumerate(sources):
                path = source["path"]
                require(_safe_model_name(path) and "/" in path, "模型目标路径无效。", "MODEL_PATH_UNSAFE")
                target = self.root / path
                ExtensionStore._regular_path(target)
                target.parent.mkdir(parents=True, exist_ok=True)
                require(not target.exists(), "目标模型文件已存在，未覆盖。请先检查该文件。", "MODEL_ALREADY_EXISTS")
                require(shutil.disk_usage(target.parent).free >= source["bytes"] + 16 * 1024 * 1024, "模型目标磁盘剩余空间不足。", "MODEL_DISK_FULL")
                self._update(job_id, currentModel=path)
                temp = target.parent / (".h3-model-" + uuid.uuid4().hex + ".part")
                try:
                    hasher, count = hashlib.sha256(), 0
                    with self.opener(source["url"], timeout=60) as response, temp.open("xb") as stream:
                        while True:
                            chunk = response.read(1024 * 1024)
                            if not chunk:
                                break
                            count += len(chunk)
                            require(count <= source["bytes"], "模型文件超出清单大小，已中止。", "MODEL_SIZE_MISMATCH")
                            stream.write(chunk)
                            hasher.update(chunk)
                            self._update(job_id, downloadedBytes=downloaded + count)
                        stream.flush()
                        os.fsync(stream.fileno())
                    require(count == source["bytes"], "模型大小与清单不一致。", "MODEL_SIZE_MISMATCH")
                    require(not source.get("sha256") or hasher.hexdigest() == source["sha256"], "模型 SHA256 校验失败。", "MODEL_HASH_MISMATCH")
                    ExtensionStore._regular_path(target)
                    os.link(temp, target)
                finally:
                    temp.unlink(missing_ok=True)
                downloaded += count
                with self.lock:
                    self.jobs[job_id]["files"].append({"path": path, "verification": "sha256" if source.get("sha256") else "size-only"})
                self._update(job_id, completed=index + 1, downloadedBytes=downloaded)
            self._update(job_id, status="completed", currentModel="")
        except Exception as exc:
            message = exc.message if isinstance(exc, ExtensionError) else "模型下载失败，已保存的模型保留；请检查网络、磁盘和目录权限。"
            self._update(job_id, status="failed", error=message)
