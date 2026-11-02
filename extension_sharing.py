"""Build reviewable, data-only node shares without media or private defaults."""
from __future__ import annotations

import base64
import binascii
import copy
import io
import json
import re
import zipfile

from PIL import Image, UnidentifiedImageError

from workflow_extensions import ExtensionError, comfy_input_fields, convert_api_json, inspect_package, require, scalar, validate_definition


def _text(value, label, maximum=4096):
    require(isinstance(value, str) and value.strip() and len(value) <= maximum, f"{label}不能为空或过长。")
    return value.strip()


def _thumbnail(value):
    """Only an explicitly selected, bounded raster cover may leave the canvas."""
    prefix = "data:image/jpeg;base64,"
    limit = 128 * 1024
    require(isinstance(value, str) and value.startswith(prefix) and len(value) <= len(prefix) + 4 * ((limit + 2) // 3),
            "封面必须是 128 KiB 以内的 JPEG 缩略图。")
    try:
        content = base64.b64decode(value[len(prefix):], validate=True)
        require(0 < len(content) <= limit, "封面大小超过 128 KiB。")
        with Image.open(io.BytesIO(content)) as source:
            require(source.format == "JPEG" and 0 < source.width <= 512 and 0 < source.height <= 512,
                    "封面必须是长边不超过 512 像素的 JPEG。")
            source.load()
            # Copy pixels to a fresh image: discard EXIF/GPS/comments/ICC/trailing bytes.
            pixels = Image.new("RGB", source.size)
            pixels.paste(source.convert("RGB"))
        for quality in (85, 75, 60, 40):
            output = io.BytesIO()
            pixels.save(output, format="JPEG", quality=quality, optimize=True)
            if output.tell() <= limit:
                return prefix + base64.b64encode(output.getvalue()).decode("ascii")
    except (binascii.Error, OSError, UnidentifiedImageError, Image.DecompressionBombError) as exc:
        raise ExtensionError("封面图片损坏，请重新选择或取消封面。") from exc
    raise ExtensionError("封面压缩后仍超过大小限制，请取消封面后分享。")


def _sanitize(workflow, include_prompts, object_info, staged=False):
    clean = {}
    cleared = set()
    for node_id, node in workflow.items():
        fields = copy.deepcopy(node["inputs"])
        for key, value in fields.items():
            if not isinstance(value, str):
                continue
            require(not re.search(r"data:(?:image|video|audio)/|^(?:iVBORw0KGgo|/9j/)[A-Za-z0-9+/=\s]{32,}|\bBearer\s+[A-Za-z0-9_.-]{16,}|\bsk-[A-Za-z0-9_-]{20,}", value, re.I),
                    f"字段 {node_id}/{key} 含嵌入媒体或凭据，请先移除。")
            if re.search(r"(?:api.?key|password|secret|access.?token|authorization|cookie)", key, re.I):
                require(not value, "工作流含凭据字段，请先移除后再分享。")
            required, optional = comfy_input_fields(object_info.get(node["class_type"], {}))
            spec = required.get(key, optional.get(key, []))
            enum = isinstance(spec, (tuple, list)) and spec and isinstance(spec[0], list)
            weight = value.lower().endswith((".safetensors", ".ckpt", ".pt", ".pth", ".bin", ".gguf"))
            if node["class_type"] == "LoadImage" and key == "image":
                if not (staged and value.startswith("__H3_CHARACTER_SHEET_PANEL_")):
                    fields[key] = "input.png"
            elif node["class_type"] == "SaveImage" and key == "filename_prefix":
                if not staged:
                    fields[key] = "H3/extensions/shared"
            elif not include_prompts and not enum and not weight and re.search(r"(?:text|prompt|caption|instruction|description|positive|negative|message)", key, re.I):
                fields[key] = ""
                cleared.add((node_id, key))
            else:
                require(not re.search(r"(?:^[A-Za-z]:[\\/]|^[/\\]|file://|https?://[^\s]*[?&](?:token|key|signature)=)", value, re.I),
                        f"字段 {node_id}/{key} 含本地路径或带凭据的链接，请先移除。")
        clean[node_id] = {"class_type": node["class_type"], "inputs": fields}
    return clean, cleared


def _archive(files):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, value in files.items():
            content = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, sort_keys=True)
            info = zipfile.ZipInfo(name, (2020, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, content.encode("utf-8"))
    return buffer.getvalue()


def share_extension(store, payload, object_info):
    from extension_dependencies import dependency_report

    allowed = {"workflow", "plan", "digest", "nodeDefinitionId", "parameters", "name", "packageId", "version", "description", "license", "includePrompts", "thumbnail"}
    require(isinstance(payload, dict) and set(payload) <= allowed, "分享请求字段无效。")
    require(sum(key in payload for key in ("workflow", "plan", "digest")) == 1, "请选择一个工作流来源。")
    require(type(payload.get("includePrompts", False)) is bool, "提示词分享选项无效。")
    thumbnail = _thumbnail(payload["thumbnail"]) if "thumbnail" in payload else None
    name = _text(payload.get("name"), "节点名称", 120)
    package_id = _text(payload.get("packageId"), "包身份", 160)
    version = _text(payload.get("version"), "版本", 80)
    description = _text(payload.get("description") or "从本地画布分享的 ComfyUI 工作流。", "说明")
    license_id = payload.get("license", "UNSPECIFIED")
    require(license_id in ("UNSPECIFIED", "MIT", "Apache-2.0", "CC0-1.0", "CC-BY-4.0"), "请选择支持的工作流许可。")
    if "plan" in payload:
        from extension_stages import flatten_plan
        require(not any(k in payload for k in ("nodeDefinitionId", "parameters")), "原始阶段计划不能同时指定包参数。")
        chosen = flatten_plan(payload["plan"])
    elif "workflow" in payload:
        require(not any(k in payload for k in ("nodeDefinitionId", "parameters")), "原始工作流不能同时指定包参数。")
        bundle = inspect_package(convert_api_json(json.dumps(payload["workflow"]).encode(), "shared.json"))
        chosen = bundle["nodes"][0]
    else:
        bundle = store.get(payload["digest"])
        chosen = next((n for n in bundle["nodes"] if n["definition"]["nodeDefinitionId"] == payload.get("nodeDefinitionId")), None)
        require(chosen is not None, "分享的节点定义不存在。")
    definition, workflow = copy.deepcopy(chosen["definition"]), copy.deepcopy(chosen["workflow"])
    staged = "execution" in definition
    require(not staged or payload.get("includePrompts") is True,
            "四视图的固定视角提示词属于阶段工作流，请勾选包含提示词并预览确认文字后分享。")
    properties = definition["parameters"]["properties"]
    parameters = payload.get("parameters", {})
    require(isinstance(parameters, dict) and set(parameters) <= set(properties), "分享参数无效。")
    for binding in definition["bindings"]:
        if binding["sourceKind"] == "parameter":
            key = binding["sourceId"]
            value = parameters.get(key, properties[key].get("default"))
            scalar(value, properties[key], key)
            workflow[binding["nodeId"]]["inputs"][binding["input"]] = value
    workflow, cleared = _sanitize(workflow, payload.get("includePrompts", False), object_info, staged)
    # Rebuild descriptions from the public contract; imported metadata may contain private paths.
    definition["name"] = name
    definition["description"] = description
    for port in definition["inputs"]:
        for key in list(port):
            if key not in {"id", "type", "required", "list"}:
                port.pop(key)
    for output in definition["outputs"]:
        for key in list(output):
            if key not in {"id", "type", "nodeId", "list"}:
                output.pop(key)
    definition["parameters"].pop("title", None)
    definition["parameters"].pop("description", None)
    for binding in definition["bindings"]:
        if binding["sourceKind"] == "parameter":
            field = properties[binding["sourceId"]]
            field["default"] = workflow[binding["nodeId"]]["inputs"][binding["input"]]
            field["title"] = f'{binding["nodeId"]} · {binding["input"]}'
            field.pop("description", None)
            if (binding["nodeId"], binding["input"]) in cleared:
                field.pop("enum", None)
    validate_definition(definition, workflow, definition["nodeDefinitionId"])
    # Strip any unknown package/definition members and example attachments, retaining only executable data contracts.
    definition = {k: definition[k] for k in ("nodeDefinitionSchemaVersion", "nodeDefinitionId", "name", "description", "inputs", "outputs", "bindings", "parameters", "execution") if k in definition}
    manifest = {"manifestSchemaVersion": "0.1", "packageId": package_id, "version": version,
                "type": "workflow", "publisherId": package_id.split("/")[0], "name": name,
                "summary": description[:200], "description": description, "source": {"kind": "direct-upload"},
                "compatibility": {"extensionApiVersion": "0.1"},
                "dependencies": {"comfyNodes": [], "models": [], "python": []},
                "permissions": {"network": [], "externalServices": [], "fileAccess": [], "background": False},
                "licenses": {"workflow": license_id}, "verification": {"environments": [], "examples": []},
                "nodes": [{"nodeDefinitionId": definition["nodeDefinitionId"], "definition": "nodes/workflow.json", "workflow": "workflows/workflow.json"}]}
    if staged:
        manifest["compatibility"]["workbenchVersion"] = ">=1.0.2"
    if thumbnail:
        manifest["preview"] = thumbnail
    report = dependency_report({"manifest": manifest, "nodes": [{"definition": definition, "workflow": workflow}]},
                               {"nodeDefinitionId": definition["nodeDefinitionId"], "parameters": {}}, object_info)
    manifest["dependencies"]["comfyNodes"] = [{"classType": n["classType"]} for n in report["comfyNodes"]]
    manifest["dependencies"]["models"] = [{k: m[k] for k in ("nodeId", "inputName", "name", "category") if k in m} for m in report["models"]]
    lines = [f"# {name}", "", description, "", "## 自动解析的工作流依赖", "", "### 模型 / LoRA"]
    lines.extend(f'- {m["category"]}: {m["name"]} ({m["nodeId"]}/{m["inputName"]})' for m in report["models"])
    if not report["models"]:
        lines.append("- 未识别到显式模型加载字段；自定义节点的隐式下载需要作者补充。")
    lines.extend(["", "### ComfyUI 节点类", *[f'- {n["classType"]}' for n in report["comfyNodes"]], "", "### 使用说明",
                  "导入画布后连接所有图片输入，检查模型依赖及参数，再点击运行。模型与自定义节点不包含在包中。",
                  "未执行生成兼容性验证；模型和节点的许可独立于工作流。",
                  "包含用户确认的文字参数。" if payload.get("includePrompts") else "提示词默认已清空，请在运行前填写。"])
    files = {"manifest.json": manifest, "nodes/workflow.json": definition, "workflows/workflow.json": workflow,
             "README.md": "\n".join(lines) + "\n", "LICENSE": "UNSPECIFIED: no redistribution license was inferred.\n" if license_id == "UNSPECIFIED" else f"SPDX-License-Identifier: {license_id}\nSelected by the uploader for the workflow only. Model and node licenses are independent.\n"}
    result = store.import_bytes(_archive(files), "shared.h3pack")
    result["dependencyReport"] = report
    return result
