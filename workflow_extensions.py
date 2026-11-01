"""Data-only H3PACK imports, immutable storage and image workflow preparation."""
from __future__ import annotations

import copy
import hashlib
import io
import json
import math
import os
from pathlib import Path
import re
import stat
import struct
import threading
import uuid
import zipfile
import zlib
from workbench_lifecycle import APP_VERSION

MAX_ARCHIVE = 64 * 1024 * 1024
MAX_FILE = 32 * 1024 * 1024
MAX_EXPANDED = 128 * 1024 * 1024
IDENTIFIER = re.compile(r"^[A-Za-z0-9_.-]+$")
NODE_ID = re.compile(r"^[a-z0-9]+(?:[._-][a-z0-9]+)*$")
FORBIDDEN = {"__proto__", "prototype", "constructor"}


class ExtensionError(ValueError):
    def __init__(self, message, code="EXTENSION_INVALID", status=400):
        super().__init__(message)
        self.message, self.code, self.status = message, code, status


def require(condition, message, code="EXTENSION_INVALID"):
    if not condition:
        raise ExtensionError(message, code)


def identifier(value):
    return isinstance(value, str) and 0 < len(value) <= 256 and bool(IDENTIFIER.fullmatch(value)) and value not in FORBIDDEN


def display_fields(value):
    for field in ("name", "label", "title", "description"):
        if field in value:
            require(isinstance(value[field], str) and len(value[field]) <= 65536, f"显示字段 {field} 必须是字符串且不能过长。")


def safe_path(value):
    require(isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/-]*", value)
            and all(p not in {"", ".", ".."} for p in value.rstrip("/").split("/")), "包内路径不安全。", "PACKAGE_UNSAFE")
    return value


def read_json(data, label="JSON"):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result and key not in FORBIDDEN, f"{label} 含重复或不安全字段。")
            result[key] = value
        return result
    try:
        result = json.loads(data.decode("utf-8-sig"), object_pairs_hook=pairs,
                            parse_constant=lambda _: (_ for _ in ()).throw(ValueError("non-finite")))
        require(isinstance(result, dict), f"{label} 必须是 JSON 对象。")
        return result
    except (UnicodeError, ValueError, RecursionError) as exc:
        if isinstance(exc, ExtensionError):
            raise
        raise ExtensionError(f"{label} 不是有效 UTF-8 JSON。") from exc


def scalar(value, schema, label):
    kind = schema.get("type")
    require(isinstance(kind, str), f"参数 {label} 类型无效。")
    valid = {"string": isinstance(value, str), "boolean": type(value) is bool,
             "integer": type(value) is int,
             "number": type(value) is int or type(value) is float and math.isfinite(value)}.get(kind, False)
    require(valid, f"参数 {label} 类型不匹配。")
    if type(value) is int:
        require(abs(value) <= 9007199254740991, f"参数 {label} 整数超出浏览器安全精度范围。")
    if "enum" in schema:
        require(any(value == v and (type(value) is type(v) or kind == "number" and type(value) in (int, float) and type(v) in (int, float)) for v in schema["enum"]), f"参数 {label} 不在允许值中。")
    if kind in {"integer", "number"}:
        require(value >= schema.get("minimum", -math.inf) and value <= schema.get("maximum", math.inf), f"参数 {label} 超出范围。")
    if kind == "string":
        require(len(value) <= 1024 * 1024, f"参数 {label} 过长。")


def validate_workflow(workflow):
    require(isinstance(workflow, dict) and 0 < len(workflow) <= 2000, "ComfyUI 工作流为空或节点过多。")
    require(not ("nodes" in workflow and "links" in workflow), "这是 ComfyUI 界面工作流，请在 ComfyUI 导出 API JSON 后导入。", "WORKFLOW_UI_FORMAT")
    for node_id, node in workflow.items():
        require(identifier(node_id) and isinstance(node, dict), "工作流节点身份无效。")
        require(isinstance(node.get("class_type"), str) and bool(re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", node["class_type"])), f"节点 {node_id} class_type 无效。")
        require(isinstance(node.get("inputs"), dict), f"节点 {node_id} 缺少 inputs。")
        for field, value in node["inputs"].items():
            require(identifier(field), f"节点 {node_id} 字段无效。")
            if isinstance(value, list):
                require(len(value) == 2 and isinstance(value[0], str) and value[0] in workflow and type(value[1]) is int and value[1] >= 0, f"节点 {node_id}/{field} 连接无效；暂不支持列表常量。")
            else:
                require(type(value) in (str, int, float, bool) and (not isinstance(value, float) or math.isfinite(value)), f"节点 {node_id}/{field} 暂不支持复杂字段。")
                if type(value) is int:
                    require(abs(value) <= 9007199254740991, f"节点 {node_id}/{field} 整数超出浏览器安全精度范围。")


def validate_definition(definition, workflow, expected_id):
    validate_workflow(workflow)
    internal = set()
    if "execution" in definition:
        from extension_stages import internal_inputs
        internal = internal_inputs(definition, workflow)
    display_fields(definition)
    require(definition.get("nodeDefinitionSchemaVersion") == "0.1" and definition.get("nodeDefinitionId") == expected_id, "节点定义身份或协议版本不一致。")
    require(isinstance(definition.get("name"), str) and definition["name"].strip(), "节点缺少名称。")
    for field in ("inputs", "bindings", "outputs"):
        require(isinstance(definition.get(field), list), f"节点缺少 {field}。")
    inputs = {}
    for port in definition["inputs"]:
        require(isinstance(port, dict) and identifier(port.get("id")) and port["id"] not in inputs, "输入端口身份无效或重复。")
        display_fields(port)
        require(port.get("type") == "image" and port.get("list", False) is False, "首版仅支持单张图像输入端口；可声明多个端口。", "EXTENSION_UNSUPPORTED")
        require(port.get("required", True) is True, "首版不支持可选图像端口。", "EXTENSION_UNSUPPORTED")
        inputs[port["id"]] = port
    schema = definition.get("parameters")
    require(isinstance(schema, dict) and schema.get("type") == "object" and isinstance(schema.get("properties"), dict), "参数 JSON Schema 无效。")
    display_fields(schema)
    require(set(schema) <= {"type", "properties", "required", "additionalProperties", "title", "description"} and schema.get("additionalProperties", False) is False, "暂不支持此参数对象约束。", "EXTENSION_UNSUPPORTED")
    properties = schema["properties"]
    required = schema.get("required", [])
    require(isinstance(required, list) and all(isinstance(k, str) and k in properties for k in required), "参数 required 无效。")
    for key, spec in properties.items():
        require(identifier(key) and isinstance(spec, dict), "参数定义无效。")
        display_fields(spec)
        require(set(spec) <= {"type", "default", "enum", "minimum", "maximum", "title", "description"} and isinstance(spec.get("type"), str) and spec["type"] in {"string", "number", "integer", "boolean"}, f"参数 {key} 含不支持的约束或类型。", "EXTENSION_UNSUPPORTED")
        for bound in ("minimum", "maximum"):
            if bound in spec:
                require(spec["type"] in {"number", "integer"} and (type(spec[bound]) is int or type(spec[bound]) is float and math.isfinite(spec[bound])), f"参数 {key} 范围无效。")
        require(spec.get("minimum", -math.inf) <= spec.get("maximum", math.inf), f"参数 {key} 范围无效。")
        if "enum" in spec:
            require(isinstance(spec["enum"], list) and spec["enum"], f"参数 {key} enum 无效。")
            for value in spec["enum"]:
                scalar(value, {k: v for k, v in spec.items() if k != "enum"}, key)
        if "default" in spec:
            scalar(spec["default"], spec, key)
    targets, sources = set(), set()
    for binding in definition["bindings"]:
        require(isinstance(binding, dict) and set(binding) == {"sourceKind", "sourceId", "nodeId", "input"}, "绑定格式无效或含不支持的转换。")
        kind, source, node_id, field = (binding[k] for k in ("sourceKind", "sourceId", "nodeId", "input"))
        require(all(isinstance(v, str) for v in (kind, source, node_id, field)), "绑定字段必须是字符串。")
        require(kind in {"input", "parameter"} and source in (inputs if kind == "input" else properties), "绑定来源不存在。")
        require(node_id in workflow and field in workflow[node_id]["inputs"], "绑定目标字段不存在。")
        require((node_id, field) not in targets and not isinstance(workflow[node_id]["inputs"][field], list), "绑定字段重复或覆盖工作流连接。")
        require((node_id, field) not in internal, "阶段内部图片不能绑定外部输入或参数。")
        require(not (workflow[node_id]["class_type"] == "SaveImage" and field == "filename_prefix"), "输出文件名前缀由工作台安全生成。")
        if kind == "input":
            require(workflow[node_id]["class_type"] == "LoadImage" and field == "image", "首版图像端口必须绑定 LoadImage.image。", "EXTENSION_UNSUPPORTED")
        else:
            require(not (workflow[node_id]["class_type"] == "LoadImage" and field == "image"), "LoadImage.image 必须绑定画布图像端口，不能绑定参数。")
        targets.add((node_id, field))
        sources.add((kind, source))
    require(all(("input", k) in sources for k in inputs) and all(("parameter", k) in sources for k in properties), "存在未绑定的输入或参数。")
    require(all((node_id, "image") in targets | internal for node_id, node in workflow.items() if node["class_type"] == "LoadImage"), "所有 LoadImage 必须绑定画布图像端口。")
    output_ids = set()
    require(definition["outputs"], "节点必须声明图像输出。")
    for output in definition["outputs"]:
        require(isinstance(output, dict) and identifier(output.get("id")) and output["id"] not in output_ids, "输出身份无效或重复。")
        display_fields(output)
        require(output.get("type") == "image" and output.get("list", False) is False and isinstance(output.get("nodeId"), str) and output["nodeId"] in workflow and workflow[output["nodeId"]]["class_type"] in {"SaveImage", "PreviewImage"}, "首版输出必须是 SaveImage 或 PreviewImage 图像。", "EXTENSION_UNSUPPORTED")
        output_ids.add(output["id"])


def inspect_package(data):
    require(0 < len(data) <= MAX_ARCHIVE, "导入文件为空或超过 64 MiB。", "PACKAGE_UNSAFE")
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            infos = archive.infolist()
            require(0 < len(infos) <= 256, "包文件数量超过限制。", "PACKAGE_UNSAFE")
            names, contents, total = set(), {}, 0
            for item in infos:
                safe_path(item.orig_filename)
                require(item.orig_filename == item.filename, "包内文件名被隐式转换。", "PACKAGE_UNSAFE")
                safe_path(item.filename)
                folded = item.filename.casefold()
                require(folded not in names, "包内路径重复或大小写冲突。", "PACKAGE_UNSAFE")
                names.add(folded)
                mode = stat.S_IFMT(item.external_attr >> 16)
                require(not item.flag_bits & 1 and item.compress_type in (0, 8) and mode in (0, stat.S_IFREG, stat.S_IFDIR), "包包含加密、链接或非常规文件。", "PACKAGE_UNSAFE")
                require(not (mode == stat.S_IFDIR and not item.is_dir()), "包目录类型无效。", "PACKAGE_UNSAFE")
                total += item.file_size
                require(item.file_size <= MAX_FILE and total <= MAX_EXPANDED and not (item.file_size > 1024 * 1024 and item.file_size / max(1, item.compress_size) > 500), "包展开体积或压缩比超过限制。", "PACKAGE_UNSAFE")
                if item.is_dir():
                    continue
                # Read in memory only: no archive member is ever extracted or executed.
                with archive.open(item) as stream:
                    content = stream.read(MAX_FILE + 1)
                require(len(content) == item.file_size, "包内文件长度无效。", "PACKAGE_UNSAFE")
                contents[item.filename] = content
    except (zipfile.BadZipFile, RuntimeError, OSError, NotImplementedError, EOFError, zlib.error, struct.error, UnicodeError) as exc:
        raise ExtensionError("ZIP 内容损坏或 CRC 校验失败。", "PACKAGE_INVALID") from exc
    require(all(name in contents for name in ("manifest.json", "README.md", "LICENSE")), "包必须包含 manifest.json、README.md 和 LICENSE。")
    manifest = read_json(contents["manifest.json"], "manifest")
    require(manifest.get("manifestSchemaVersion") == "0.1", "仅支持 manifest 0.1。")
    require(isinstance(manifest.get("packageId"), str) and re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?/[a-z0-9]+(?:[._-][a-z0-9]+)*", manifest["packageId"]), "packageId 无效。")
    require(isinstance(manifest.get("version"), str) and re.fullmatch(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?", manifest["version"]), "version 必须是 SemVer。")
    require(isinstance(manifest.get("type"), str) and manifest["type"] in {"workflow", "subgraph"}, "包类型无效。")
    for field in ("publisherId", "name", "summary", "description"):
        require(isinstance(manifest.get(field), str) and manifest[field].strip(), f"manifest 缺少 {field}。")
    for field in ("source", "compatibility", "dependencies", "permissions", "licenses", "verification"):
        require(isinstance(manifest.get(field), dict), f"manifest 缺少 {field}。")
    require(manifest["compatibility"].get("extensionApiVersion") == "0.1", "扩展协议不兼容。")
    validate_compatibility(manifest["compatibility"])
    require(isinstance(manifest.get("nodes"), list) and 0 < len(manifest["nodes"]) <= 100, "包必须包含 1–100 个节点。")
    nodes, ids = [], set()
    for entry in manifest["nodes"]:
        require(isinstance(entry, dict) and isinstance(entry.get("nodeDefinitionId"), str) and NODE_ID.fullmatch(entry["nodeDefinitionId"]) and entry["nodeDefinitionId"] not in ids, "节点定义身份无效或重复。")
        ids.add(entry["nodeDefinitionId"])
        for field in ("definition", "workflow"):
            safe_path(entry.get(field))
            require(entry[field] in contents, f"缺少 {field} 文件。")
        definition = read_json(contents[entry["definition"]], "definition")
        workflow = read_json(contents[entry["workflow"]], "workflow")
        if "execution" in definition:
            require(manifest["compatibility"].get("workbenchVersion") == ">=1.0.2", "分阶段扩展必须声明工作台版本 >=1.0.2。")
        validate_definition(definition, workflow, entry["nodeDefinitionId"])
        nodes.append({"definition": definition, "workflow": workflow})
    return {"digest": hashlib.sha256(data).hexdigest(), "manifest": manifest, "nodes": nodes}


def convert_api_json(data, filename="workflow.json"):
    workflow = read_json(data, "ComfyUI API JSON")
    validate_workflow(workflow)
    definition = {"nodeDefinitionSchemaVersion": "0.1", "nodeDefinitionId": "workflow", "name": Path(filename).stem[:120] or "ComfyUI 工作流", "inputs": [], "outputs": [], "bindings": [], "parameters": {"type": "object", "additionalProperties": False, "properties": {}}}
    for node_id, node in workflow.items():
        title = node.get("_meta", {}).get("title", node_id) if isinstance(node.get("_meta"), dict) else node_id
        if node["class_type"] == "LoadImage":
            port_id = f"image_{node_id}"
            definition["inputs"].append({"id": port_id, "type": "image", "required": True, "list": False, "description": str(title)[:120]})
            definition["bindings"].append({"sourceKind": "input", "sourceId": port_id, "nodeId": node_id, "input": "image"})
            node["inputs"]["image"] = "input.png"
        if node["class_type"] in {"SaveImage", "PreviewImage"}:
            definition["outputs"].append({"id": f"image_{node_id}", "type": "image", "nodeId": node_id})
        for field, value in node["inputs"].items():
            if isinstance(value, list) or (node["class_type"] == "LoadImage" and field == "image"):
                continue
            if node["class_type"] == "SaveImage" and field == "filename_prefix":
                node["inputs"][field] = "H3/extensions/workflow"
                continue
            key = f"node_{node_id}__{field}"
            require(key not in definition["parameters"]["properties"], "参数自动命名冲突，请使用 .h3pack 定义。")
            kind = {str: "string", bool: "boolean", int: "integer", float: "number"}[type(value)]
            definition["parameters"]["properties"][key] = {"type": kind, "default": value, "title": f"{title} · {field}"}
            definition["bindings"].append({"sourceKind": "parameter", "sourceId": key, "nodeId": node_id, "input": field})
    short_hash = hashlib.sha256(data).hexdigest()[:16]
    manifest = {"manifestSchemaVersion": "0.1", "packageId": f"local/workflow-{short_hash}", "version": "0.1.0", "type": "workflow", "publisherId": "local", "name": definition["name"], "summary": "本地导入的 ComfyUI API 工作流", "description": "由工作台转换；发布前请核实工作流与依赖授权。", "source": {"kind": "direct-upload"}, "compatibility": {"extensionApiVersion": "0.1"}, "dependencies": {"comfyNodes": [], "models": [], "python": []}, "permissions": {"network": [], "externalServices": [], "fileAccess": [], "background": False}, "licenses": {"workflow": "UNSPECIFIED"}, "verification": {"environments": [], "examples": []}, "nodes": [{"nodeDefinitionId": "workflow", "definition": "nodes/workflow.json", "workflow": "workflows/workflow.json"}]}
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, value in {"manifest.json": manifest, "nodes/workflow.json": definition, "workflows/workflow.json": workflow, "README.md": "Imported ComfyUI API workflow. Review dependencies and license before publishing.\n", "LICENSE": "UNSPECIFIED: no redistribution license was inferred.\n"}.items():
            content = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, sort_keys=True)
            info = zipfile.ZipInfo(name, (2020, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, content.encode("utf-8"))
    return buffer.getvalue()


class ExtensionStore:
    def __init__(self, root):
        self.root = Path(root)
        self._lock = threading.RLock()

    def _path(self, digest):
        require(isinstance(digest, str) and re.fullmatch(r"[0-9a-f]{64}", digest), "扩展 digest 无效。")
        path = self.root / (digest + ".h3pack")
        self._regular_path(path)
        return path

    @staticmethod
    def _regular_path(path):
        for candidate in (path, *path.parents):
            try:
                info = candidate.lstat()
            except FileNotFoundError:
                continue
            require(not stat.S_ISLNK(info.st_mode) and not getattr(info, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400), "扩展存储不允许符号链接或重解析目录。", "PACKAGE_UNSAFE")

    def import_bytes(self, data, filename="workflow.json"):
        require(0 < len(data) <= MAX_ARCHIVE, "导入文件为空或超过 64 MiB。", "PACKAGE_UNSAFE")
        package = data if data.startswith(b"PK") else convert_api_json(data, filename)
        result = inspect_package(package)
        with self._lock:
            self._regular_path(self.root)
            self.root.mkdir(parents=True, exist_ok=True)
            target = self._path(result["digest"])
            if target.exists():
                require(target.read_bytes() == package, "已安装包内容与 digest 不一致。", "DIGEST_MISMATCH")
                return result
            temporary = self.root / ("." + uuid.uuid4().hex + ".tmp")
            try:
                with temporary.open("xb") as stream:
                    stream.write(package)
                    stream.flush()
                    os.fsync(stream.fileno())
                # Link publishes a complete file atomically and cannot replace an existing digest.
                try:
                    os.link(temporary, target)
                except FileExistsError:
                    require(target.read_bytes() == package, "扩展 digest 冲突。", "DIGEST_MISMATCH")
            finally:
                temporary.unlink(missing_ok=True)
        return result

    def download(self, digest):
        try:
            data = self._path(digest).read_bytes()
        except FileNotFoundError as exc:
            raise ExtensionError("扩展包未安装，请重新导入对应版本。", "EXTENSION_NOT_FOUND", 404) from exc
        require(hashlib.sha256(data).hexdigest() == digest, "已安装扩展内容被更改。", "DIGEST_MISMATCH")
        return data

    def get(self, digest):
        return inspect_package(self.download(digest))

    def list(self):
        self._regular_path(self.root)
        items = []
        for path in sorted(self.root.glob("*.h3pack")):
            package = self.get(path.stem)
            manifest = package["manifest"]
            items.append({"digest": package["digest"], **{k: manifest[k] for k in ("packageId", "version", "name")}, "nodes": [{"nodeDefinitionId": n["definition"]["nodeDefinitionId"], "name": n["definition"]["name"]} for n in package["nodes"]]})
        return {"items": items}

    def prepare(self, digest, payload, object_info):
        require(isinstance(payload, dict) and set(payload) <= {"nodeDefinitionId", "inputs", "parameters"}, "prepare 请求字段无效。")
        package = self.get(digest)
        chosen = next((n for n in package["nodes"] if n["definition"]["nodeDefinitionId"] == payload.get("nodeDefinitionId")), None)
        require(chosen is not None, "节点定义不存在。")
        definition, workflow = chosen["definition"], copy.deepcopy(chosen["workflow"])
        inputs, parameters = payload.get("inputs", {}), payload.get("parameters", {})
        require(isinstance(inputs, dict) and isinstance(parameters, dict), "inputs 和 parameters 必须是对象。")
        require(set(inputs) == {p["id"] for p in definition["inputs"]}, "图像输入缺失或包含未知端口。")
        for value in inputs.values():
            require(isinstance(value, str) and value and len(value) < 1024 and not any(c in value for c in "\\:\x00\r\n") and not value.startswith("/") and all(p not in {"", ".", ".."} for p in value.split("/")), "ComfyUI 图像文件名不安全。")
        properties = definition["parameters"]["properties"]
        require(set(parameters) <= set(properties), "包含未知参数。")
        values = {}
        for key, spec in properties.items():
            require(key in parameters or "default" in spec, f"缺少参数 {key}。")
            value = parameters[key] if key in parameters else spec["default"]
            scalar(value, spec, key)
            values[key] = value
        for binding in definition["bindings"]:
            workflow[binding["nodeId"]]["inputs"][binding["input"]] = (inputs if binding["sourceKind"] == "input" else values)[binding["sourceId"]]
        if "execution" in definition:
            from extension_stages import unpack_stages
            plan = unpack_stages(definition, workflow)
            for graph in [p["single"] for p in plan["panels"]] + [plan["stitch"]]:
                validate_comfy(graph, object_info)
            return {"plan": plan, "outputs": [{k: output[k] for k in ("id", "type", "nodeId")} for output in definition["outputs"]], "digest": digest}
        for node_id, node in workflow.items():
            if node["class_type"] == "SaveImage":
                node["inputs"]["filename_prefix"] = f"H3/extensions/{digest[:16]}/{node_id}"
        validate_comfy(workflow, object_info)
        return {"workflow": workflow, "outputs": [{k: output[k] for k in ("id", "type", "nodeId")} for output in definition["outputs"]], "digest": digest}


def validate_compatibility(compatibility):
    value = compatibility.get("workbenchVersion")
    if value is None:
        return
    require(isinstance(value, str) and value.strip(), "工作台版本范围无效。")
    current = tuple(int(p) for p in APP_VERSION.split("."))
    for clause in value.split():
        match = re.fullmatch(r"(>=|<=|>|<|=)?(0|[1-9][0-9]*)(?:\.(0|[1-9][0-9]*))?(?:\.(0|[1-9][0-9]*))?", clause)
        require(match is not None, "暂不支持此工作台版本范围，请使用空格分隔的 >=、< 或精确版本。", "EXTENSION_UNSUPPORTED")
        op = match[1] or "="
        version = tuple(int(p or 0) for p in match.groups()[1:])
        valid = {"=": current == version, ">=": current >= version, "<=": current <= version, ">": current > version, "<": current < version}[op]
        require(valid, "扩展要求不同工作台版本：" + value, "INCOMPATIBLE_WORKBENCH")


def comfy_input_fields(metadata):
    """Expand the official V3 autogrow template into its declared dotted fields."""
    fields = metadata.get("input", {})
    required, optional = dict(fields.get("required", {})), dict(fields.get("optional", {}))
    for section in (required, optional):
        for key, spec in list(section.items()):
            if not isinstance(spec, (list, tuple)) or not spec or spec[0] != "COMFY_AUTOGROW_V3":
                continue
            require(len(spec) > 1 and isinstance(spec[1], dict), "ComfyUI 动态输入定义无效。")
            template = spec[1].get("template", {})
            require(isinstance(template, dict), "ComfyUI 动态输入模板无效。")
            names = template.get("names")
            if names is None:
                maximum, prefix = template.get("max"), template.get("prefix")
                require(type(maximum) is int and 0 < maximum <= 100 and isinstance(prefix, str), "ComfyUI 动态输入名称范围无效。")
                names = [prefix + str(index) for index in range(maximum)]
            require(isinstance(names, list) and 0 < len(names) <= 100 and all(identifier(n) for n in names) and len(set(names)) == len(names), "ComfyUI 动态输入名称无效。")
            minimum = template.get("min", 0)
            require(type(minimum) is int and 0 <= minimum <= len(names), "ComfyUI 动态输入最小数量无效。")
            inputs = template.get("input", {})
            require(isinstance(inputs, dict), "ComfyUI 动态输入类型无效。")
            typed = [(kind, value) for kind in ("required", "optional") for value in inputs.get(kind, {}).values()]
            require(len(typed) == 1, "暂不支持此 ComfyUI 动态输入模板。", "EXTENSION_UNSUPPORTED")
            kind, inner = typed[0]
            del section[key]
            for index, name in enumerate(names):
                target = required if kind == "required" and index < minimum else optional
                qualified = key + "." + name
                require(qualified not in required and qualified not in optional, "ComfyUI 动态输入字段重复。")
                target[qualified] = inner
    for section in (required, optional):
        for key, spec in list(section.items()):
            if not isinstance(spec, (list, tuple)) or not spec or spec[0] != "COMBO":
                continue
            config = spec[1] if len(spec) > 1 and isinstance(spec[1], dict) else {}
            require(config.get("multiselect", False) is False, "暂不支持 ComfyUI 多选 COMBO 输入。", "EXTENSION_UNSUPPORTED")
            options = config.get("options")
            require(isinstance(options, list) and all(type(v) in (str, int, float, bool) for v in options), "ComfyUI COMBO 选项无效。")
            section[key] = [options, config]
    return required, optional


def validate_comfy(workflow, object_info):
    require(isinstance(object_info, dict) and object_info, "ComfyUI 节点信息不可用。", "COMFY_UNAVAILABLE")
    missing = sorted({node["class_type"] for node in workflow.values()} - set(object_info))
    require(not missing, "ComfyUI 缺少节点：" + ", ".join(missing), "COMFY_NODES_MISSING")
    for node_id, node in workflow.items():
        metadata = object_info[node["class_type"]]
        required, optional = comfy_input_fields(metadata)
        require(set(required) <= set(node["inputs"]), f"节点 {node_id} 缺少必填字段。")
        for field, value in node["inputs"].items():
            spec = required.get(field, optional.get(field))
            require(isinstance(spec, (list, tuple)) and spec, f"ComfyUI 节点 {node_id} 不支持字段 {field}。")
            expected = spec[0]
            if isinstance(value, list):
                source = workflow[value[0]]
                outputs = object_info[source["class_type"]].get("output", [])
                require(value[1] < len(outputs), f"节点 {node_id}/{field} 引用不存在的输出。")
                require(not isinstance(expected, list) and (expected == "*" or outputs[value[1]] == "*" or expected == outputs[value[1]]), f"节点 {node_id}/{field} 连接类型不匹配。")
            elif isinstance(expected, list):
                # LoadImage filenames come from the upload API and may not yet appear in cached enums.
                if not (node["class_type"] == "LoadImage" and field == "image"):
                    require(value in expected, f"节点 {node_id}/{field} 的模型或选项未安装：{str(value)[:160]}", "COMFY_VALUE_MISSING")
            else:
                kind = {"INT": "integer", "FLOAT": "number", "STRING": "string", "BOOLEAN": "boolean"}.get(expected)
                require(kind is not None, f"节点 {node_id}/{field} 需要工作流连接。")
                constraints = spec[1] if len(spec) > 1 and isinstance(spec[1], dict) else {}
                scalar(value, {"type": kind, **({"minimum": constraints["min"]} if "min" in constraints else {}), **({"maximum": constraints["max"]} if "max" in constraints else {})}, f"{node_id}/{field}")
