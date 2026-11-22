"""Data-only character sheet packages; flattened for inspection, executed serially."""
from __future__ import annotations

import copy
import re

from outfit_queue import SHEET_PANELS, SHEET_STABLE_PANELS, SHEET_PREP_PANELS, SHEET_PANEL_INPUT, validate_plan
from workflow_extensions import ExtensionError, require, validate_workflow

STAGES = (*SHEET_PANELS, "stitch")
STAGES_V2 = (*SHEET_PREP_PANELS, "stitch")
LABELS = dict(zip(SHEET_PANELS, ("正面头像", "45°头像", "背面身体", "正面身体")))
BACK_ALTERNATIVE = "back_body_without_back"


def _namespace(graph, prefix):
    names = {key: prefix + "__" + key for key in graph}
    return {names[key]: {"class_type": node["class_type"], "inputs": {
        field: [names[value[0]], value[1]] if isinstance(value, list) else copy.deepcopy(value)
        for field, value in node["inputs"].items()}} for key, node in graph.items()}


def _unnamespace(graph, prefix):
    names = {key: key[len(prefix) + 2:] for key in graph}
    return {names[key]: {"class_type": node["class_type"], "inputs": {
        field: [names[value[0]], value[1]] if isinstance(value, list) else copy.deepcopy(value)
        for field, value in node["inputs"].items()}} for key, node in graph.items()}


def _shared_back_parameter(key, field, workflow):
    if key.startswith(BACK_ALTERNATIVE + "__") and not re.search(r"prompt|text|caption|instruction|positive|negative", field, re.I):
        main = "back_body__" + key[len(BACK_ALTERNATIVE) + 2:]
        if main in workflow and workflow[main]["class_type"] == workflow[key]["class_type"] and field in workflow[main]["inputs"] and not isinstance(workflow[main]["inputs"][field], list):
            require(workflow[main]["inputs"][field] == workflow[key]["inputs"][field], "背面有无参考分支的模型和采样设置必须一致。")
            return main
    return key


def checked_plan(plan):
    require(isinstance(plan, dict) and plan.get("kind") == "characterSheet", "分享仅支持四视图分阶段图片计划。")
    try:
        normalized = validate_plan(plan)
    except (ValueError, TypeError, KeyError) as exc:
        raise ExtensionError("四视图阶段计划无效：" + str(exc)) from exc
    for graph in [p["single"] for p in normalized["panels"]] + [p["withoutBackSingle"] for p in normalized["panels"] if "withoutBackSingle" in p] + [normalized["stitch"]]:
        validate_workflow(graph)
        require(all(n["class_type"] != "PreviewImage" for n in graph.values()), "分阶段工作流仅允许声明的保存输出。")
    if normalized.get("referenceMode") in ("identityBody", "identityBack", "identityBodyBack") or normalized.get("fidelityMode") == "sourceAnchored":
        return normalized  # Roles were validated independently of filename equality.
    sources = []
    for panel in normalized["panels"]:
        if not panel["dependsOn"]:
            images = [n["inputs"].get("image") for n in panel["single"].values() if n["class_type"] == "LoadImage"]
            require(len(images) == 1 and isinstance(images[0], str) and images[0], "四视图的独立阶段必须引用同一张原始参考图。")
            sources.extend(images)
    require(len(set(sources)) == 1, "四视图的独立阶段必须引用同一张原始参考图。")
    return normalized


def unpack_stages(definition, workflow):
    execution = definition.get("execution")
    fields = {"kind", "version", "stages", "referenceMode"} if isinstance(execution, dict) and execution.get("version") in (4, 5) else {"kind", "version", "stages"}
    require(isinstance(execution, dict) and set(execution) == fields
            and execution["kind"] == "characterSheet" and type(execution["version"]) is int and execution["version"] in (1, 2, 3, 4, 5),
            "分阶段执行定义不受支持。", "EXTENSION_UNSUPPORTED")
    stages = execution["stages"]
    version = execution["version"]
    if version == 4:
        require(execution["referenceMode"] in ("identityBack", "identityBodyBack"), "背面参考角色模式无效。")
    if version == 5:
        require(execution["referenceMode"] in ("identity", "identityBody", "identityBack", "identityBodyBack"), "原始身份锚定角色模式无效。")
    has_back = version in (4, 5) and execution["referenceMode"] in ("identityBack", "identityBodyBack")
    expected_stages = STAGES if version == 1 else STAGES_V2
    if version >= 2:
        has_prep = isinstance(stages, list) and stages and isinstance(stages[0], dict) and stages[0].get("id") == "portrait_reference"
        require(version != 5 or not has_prep, "原始身份锚定不允许独立预处理阶段。")
        expected_stages = STAGES_V2 if has_prep else (*SHEET_STABLE_PANELS, "stitch")
    require(isinstance(stages, list) and len(stages) == len(expected_stages), "四视图阶段数量无效。")
    graphs, seen = {}, set()
    for stage, expected in zip(stages, expected_stages):
        fields = {"id", "nodeIds"} if version == 1 else {"id", "nodeIds", "label", "dependsOn"}
        if version >= 3:
            fields = fields | {"inputRoles"}
        if has_back and expected == "back_body":
            fields = fields | {"withoutBackNodeIds"}
        require(isinstance(stage, dict) and set(stage) == fields and stage["id"] == expected, "四视图阶段顺序无效。")
        if version >= 2:
            dependencies = {"front_portrait": ["portrait_reference"], "three_quarter_portrait": ["front_portrait"], "back_body": ["front_body"], "stitch": list(SHEET_PANELS)}.get(expected, [])
            if version >= 2:
                if expected == "front_portrait" and not has_prep:
                    dependencies = []
                if expected == "front_body" and (version == 3 or version in (4, 5) and execution["referenceMode"] in ("identityBody", "identityBodyBack")):
                    dependencies = ["front_portrait"]
            require(stage["dependsOn"] == dependencies and isinstance(stage["label"], str) and 0 < len(stage["label"]) <= 65536, "四视图阶段依赖或标签无效。")
        ids = stage["nodeIds"]
        require(isinstance(ids, list) and ids and all(isinstance(k, str) and k in workflow and k.startswith(expected + "__") for k in ids), "阶段包含未知或未命名空间隔离的节点。")
        require(len(set(ids)) == len(ids) and not seen.intersection(ids), "阶段节点重复。")
        seen.update(ids)
        graph = {k: copy.deepcopy(workflow[k]) for k in ids}
        validate_workflow(graph)  # Connections must stay within this stage.
        if version >= 2:
            names = {key: key[len(expected) + 2:] for key in graph}
            graph = {names[key]: {"class_type": node["class_type"], "inputs": {
                field: [names[value[0]], value[1]] if isinstance(value, list) else copy.deepcopy(value)
                for field, value in node["inputs"].items()}} for key, node in graph.items()}
            validate_workflow(graph)
        graphs[expected] = graph
        if has_back and expected == "back_body":
            alternate_ids = stage["withoutBackNodeIds"]
            require(isinstance(alternate_ids, list) and alternate_ids and all(isinstance(k, str) and k in workflow and k.startswith(BACK_ALTERNATIVE + "__") for k in alternate_ids), "无背面参考分支必须使用独立命名空间。")
            require(len(set(alternate_ids)) == len(alternate_ids) and not seen.intersection(alternate_ids), "无背面参考分支节点重复。")
            seen.update(alternate_ids)
            alternative = {key: copy.deepcopy(workflow[key]) for key in alternate_ids}
            validate_workflow(alternative)
            graphs[BACK_ALTERNATIVE] = _unnamespace(alternative, BACK_ALTERNATIVE)
    require(seen == set(workflow), "存在未归属阶段的节点。")
    if version >= 2:
        plan = {"kind": "characterSheet", "memoryPolicy": "preserve", "panels": [
            {"id": stage["id"], "label": stage["label"], "dependsOn": stage["dependsOn"], "single": graphs[stage["id"]]}
            for stage in stages[:-1]], "stitch": graphs["stitch"]}
        if version >= 3:
            plan["referenceMode"] = "identityBody" if version == 3 else execution["referenceMode"]
            if version == 5:
                plan["fidelityMode"] = "sourceAnchored"
            for stage in stages:
                roles = stage["inputRoles"]
                require(isinstance(roles, dict) and all(key in stage["nodeIds"] and role in (("identity", "body", "back") if has_back else ("identity", "body")) for key, role in roles.items()), "阶段参考角色无效。")
            require(not stages[-1]["inputRoles"], "最终拼接不能加载外部参考图。")
            for panel, stage in zip(plan["panels"], stages):
                panel["inputRoles"] = {key[len(stage["id"]) + 2:]: role for key, role in stage["inputRoles"].items()}
            if has_back:
                next(panel for panel in plan["panels"] if panel["id"] == "back_body")["withoutBackSingle"] = graphs[BACK_ALTERNATIVE]
        return checked_plan(plan)
    return checked_plan({"kind": "characterSheet", "memoryPolicy": "preserve", "panels": [
        {"id": key, "label": LABELS[key], "dependsOn": ["front_portrait"] if key == "three_quarter_portrait" else [], "single": graphs[key]}
        for key in SHEET_PANELS], "stitch": graphs["stitch"]})


def internal_inputs(definition, workflow):
    plan = unpack_stages(definition, workflow)
    ports = definition.get("inputs")
    if definition["execution"]["version"] >= 3:
        port_ids = ["image_identity"] + (["image_body"] if plan["referenceMode"] in ("identityBody", "identityBodyBack") else []) + (["image_back"] if plan["referenceMode"] in ("identityBack", "identityBodyBack") else [])
        require(isinstance(ports, list) and len(ports) == len(port_ids) and all(isinstance(p, dict) for p in ports), "参考图节点端口数量无效。")
        for port, key in zip(ports, port_ids):
            required = key == "image_identity"
            require(set(port) <= {"id", "type", "required", "label", "fallback"} and port.get("id") == key and port.get("type") == "image" and port.get("required") is required and port.get("fallback") == ("image_identity" if key == "image_body" else None), "参考图端口或回退定义无效。")
        role_bindings = {(p["id"] + "__" + key, "image"): "image_" + role for p in plan["panels"] for key, role in p["inputRoles"].items()}
        bindings = definition.get("bindings")
        require(isinstance(bindings, list), "双参考图输入绑定无效。")
        actual = {}
        for binding in bindings:
            if isinstance(binding, dict) and binding.get("sourceKind") == "input":
                require(isinstance(binding.get("nodeId"), str) and isinstance(binding.get("input"), str), "双参考图输入绑定无效。")
                actual[(binding["nodeId"], binding["input"])] = binding.get("sourceId")
        require(actual == role_bindings, "双参考图端口必须与声明角色一致。")
        if plan["referenceMode"] in ("identityBack", "identityBodyBack"):
            parameters = {(b.get("nodeId"), b.get("input")): b.get("sourceId") for b in bindings if isinstance(b, dict) and b.get("sourceKind") == "parameter" and isinstance(b.get("nodeId"), str) and isinstance(b.get("input"), str)}
            for key, node in workflow.items():
                if key.startswith(BACK_ALTERNATIVE + "__"):
                    for field, value in node["inputs"].items():
                        if isinstance(value, list) or node["class_type"] in ("LoadImage", "SaveImage"):
                            continue
                        main = _shared_back_parameter(key, field, workflow)
                        if main != key:
                            require(parameters.get((key, field)) is not None and parameters.get((key, field)) == parameters.get((main, field)), "背面两个分支必须共享模型和采样参数绑定。")
    else:
        require(isinstance(ports, list) and len(ports) == 1 and isinstance(ports[0], dict),
                "四视图分阶段节点必须只有一个原始参考图输入端口。")
    allowed = {SHEET_PANEL_INPUT.format(panel_id=p["id"]) for p in plan["panels"]}
    internal = {(key, "image") for key, node in workflow.items()
                if node["class_type"] == "LoadImage" and node["inputs"].get("image") in allowed}
    # Only the final stitch output is a public canvas output.
    final = {key for key, node in plan["stitch"].items() if node["class_type"] == "SaveImage"}
    if definition["execution"]["version"] >= 2:
        final = {"stitch__" + key for key in final}
    outputs = definition.get("outputs")
    require(isinstance(outputs, list) and len(outputs) == 1 and isinstance(outputs[0], dict)
            and isinstance(outputs[0].get("nodeId"), str) and outputs[0]["nodeId"] in final,
            "分阶段节点只能声明最终拼接输出。")
    return internal


def flatten_plan(plan):
    plan = checked_plan(plan)
    order = tuple(p["id"] for p in plan["panels"])
    fidelity = plan.get("fidelityMode") == "sourceAnchored"
    dual = plan.get("referenceMode") in ("identityBody", "identityBack", "identityBodyBack") or fidelity
    back_reference = plan.get("referenceMode") in ("identityBack", "identityBodyBack")
    require(order in (SHEET_PANELS, SHEET_STABLE_PANELS, SHEET_PREP_PANELS) or dual, "分享需要旧版四阶段或新版含头像参考预处理的完整计划。")
    version = 5 if fidelity else 4 if back_reference else 3 if dual else 2 if order in (SHEET_STABLE_PANELS, SHEET_PREP_PANELS) else 1
    external_roles = {}
    workflow, stages = {}, []
    for stage_id, graph in [(p["id"], p["single"]) for p in plan["panels"]] + [("stitch", plan["stitch"])]:
        names = {key: stage_id + "__" + key for key in graph}
        for key, node in graph.items():
            workflow[names[key]] = {"class_type": node["class_type"], "inputs": {
                field: [names[value[0]], value[1]] if isinstance(value, list) else copy.deepcopy(value)
                for field, value in node["inputs"].items()}}
        stage = {"id": stage_id, "nodeIds": list(names.values())}
        if version >= 2:
            panel = next((p for p in plan["panels"] if p["id"] == stage_id), None)
            stage.update(label=panel["label"] if panel else "最终拼接", dependsOn=copy.deepcopy(panel["dependsOn"]) if panel else list(SHEET_PANELS))
            if dual:
                stage["inputRoles"] = {names[key]: role for key, role in panel["inputRoles"].items()} if panel else {}
                external_roles.update(stage["inputRoles"])
            if back_reference and stage_id == "back_body":
                alternative = _namespace(panel["withoutBackSingle"], BACK_ALTERNATIVE)
                workflow.update(alternative)
                stage["withoutBackNodeIds"] = list(alternative)
        stages.append(stage)
    definition = {"nodeDefinitionSchemaVersion": "0.1", "nodeDefinitionId": "workflow", "name": "四视图分阶段工作流",
                  "inputs": [{"id": "image_source", "type": "image", "required": True}], "outputs": [], "bindings": [],
                  "parameters": {"type": "object", "additionalProperties": False, "properties": {}},
                  "execution": {"kind": "characterSheet", "version": version, "stages": stages}}
    if dual:
        definition["inputs"] = [{"id": "image_identity", "type": "image", "required": True, "label": "正面头像／身份参考"}]
        if plan["referenceMode"] in ("identityBody", "identityBodyBack"):
            definition["inputs"].append({"id": "image_body", "type": "image", "required": False, "fallback": "image_identity", "label": "身材与服装参考（可选）"})
        if back_reference:
            definition["inputs"].append({"id": "image_back", "type": "image", "required": False, "label": "背面服装与结构参考（可选）"})
        if back_reference or fidelity:
            definition["execution"]["referenceMode"] = plan["referenceMode"]
    placeholders = {SHEET_PANEL_INPUT.format(panel_id=k) for k in order}
    for key, node in workflow.items():
        if key.startswith("stitch__") and node["class_type"] == "SaveImage":
            definition["outputs"].append({"id": "image_sheet", "type": "image", "nodeId": key})
        for field, value in node["inputs"].items():
            if isinstance(value, list) or node["class_type"] == "SaveImage" and field == "filename_prefix":
                continue
            if node["class_type"] == "LoadImage" and field == "image":
                if value not in placeholders:
                    node["inputs"][field] = "input.png"
                    definition["bindings"].append({"sourceKind": "input", "sourceId": "image_" + external_roles[key] if dual else "image_source", "nodeId": key, "input": field})
                continue
            param = "node_" + (_shared_back_parameter(key, field, workflow) if back_reference else key) + "__" + field
            require(len(param) <= 256, "阶段参数名称过长。")
            definition["parameters"]["properties"][param] = {"type": {str: "string", bool: "boolean", int: "integer", float: "number"}[type(value)], "default": value}
            definition["bindings"].append({"sourceKind": "parameter", "sourceId": param, "nodeId": key, "input": field})
    return {"definition": definition, "workflow": workflow}
