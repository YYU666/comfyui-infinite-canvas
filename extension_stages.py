"""Data-only character sheet packages; flattened for inspection, executed serially."""
from __future__ import annotations

import copy

from outfit_queue import SHEET_PANELS, SHEET_PANEL_INPUT, validate_plan
from workflow_extensions import ExtensionError, require, validate_workflow

STAGES = (*SHEET_PANELS, "stitch")
LABELS = dict(zip(SHEET_PANELS, ("正面头像", "45°头像", "背面身体", "正面身体")))


def checked_plan(plan):
    require(isinstance(plan, dict) and plan.get("kind") == "characterSheet", "分享仅支持四视图分阶段图片计划。")
    try:
        normalized = validate_plan(plan)
    except (ValueError, TypeError, KeyError) as exc:
        raise ExtensionError("四视图阶段计划无效：" + str(exc)) from exc
    for graph in [p["single"] for p in normalized["panels"]] + [normalized["stitch"]]:
        validate_workflow(graph)
        require(all(n["class_type"] != "PreviewImage" for n in graph.values()), "分阶段工作流仅允许声明的保存输出。")
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
    require(isinstance(execution, dict) and set(execution) == {"kind", "version", "stages"}
            and execution["kind"] == "characterSheet" and type(execution["version"]) is int and execution["version"] == 1,
            "分阶段执行定义不受支持。", "EXTENSION_UNSUPPORTED")
    stages = execution["stages"]
    require(isinstance(stages, list) and len(stages) == 5, "四视图必须包含四个生成阶段和拼接阶段。")
    graphs, seen = {}, set()
    for stage, expected in zip(stages, STAGES):
        require(isinstance(stage, dict) and set(stage) == {"id", "nodeIds"} and stage["id"] == expected, "四视图阶段顺序无效。")
        ids = stage["nodeIds"]
        require(isinstance(ids, list) and ids and all(isinstance(k, str) and k in workflow and k.startswith(expected + "__") for k in ids), "阶段包含未知或未命名空间隔离的节点。")
        require(len(set(ids)) == len(ids) and not seen.intersection(ids), "阶段节点重复。")
        seen.update(ids)
        graph = {k: copy.deepcopy(workflow[k]) for k in ids}
        validate_workflow(graph)  # Connections must stay within this stage.
        graphs[expected] = graph
    require(seen == set(workflow), "存在未归属阶段的节点。")
    return checked_plan({"kind": "characterSheet", "memoryPolicy": "preserve", "panels": [
        {"id": key, "label": LABELS[key], "dependsOn": ["front_portrait"] if key == "three_quarter_portrait" else [], "single": graphs[key]}
        for key in SHEET_PANELS], "stitch": graphs["stitch"]})


def internal_inputs(definition, workflow):
    plan = unpack_stages(definition, workflow)
    ports = definition.get("inputs")
    require(isinstance(ports, list) and len(ports) == 1 and isinstance(ports[0], dict),
            "四视图分阶段节点必须只有一个原始参考图输入端口。")
    allowed = {SHEET_PANEL_INPUT.format(panel_id=k) for k in SHEET_PANELS}
    internal = {(key, "image") for key, node in workflow.items()
                if node["class_type"] == "LoadImage" and node["inputs"].get("image") in allowed}
    # Only the final stitch output is a public canvas output.
    final = {key for key, node in plan["stitch"].items() if node["class_type"] == "SaveImage"}
    outputs = definition.get("outputs")
    require(isinstance(outputs, list) and len(outputs) == 1 and isinstance(outputs[0], dict)
            and isinstance(outputs[0].get("nodeId"), str) and outputs[0]["nodeId"] in final,
            "分阶段节点只能声明最终拼接输出。")
    return internal


def flatten_plan(plan):
    plan = checked_plan(plan)
    workflow, stages = {}, []
    for stage_id, graph in [(p["id"], p["single"]) for p in plan["panels"]] + [("stitch", plan["stitch"])]:
        names = {key: stage_id + "__" + key for key in graph}
        for key, node in graph.items():
            workflow[names[key]] = {"class_type": node["class_type"], "inputs": {
                field: [names[value[0]], value[1]] if isinstance(value, list) else copy.deepcopy(value)
                for field, value in node["inputs"].items()}}
        stages.append({"id": stage_id, "nodeIds": list(names.values())})
    definition = {"nodeDefinitionSchemaVersion": "0.1", "nodeDefinitionId": "workflow", "name": "四视图分阶段工作流",
                  "inputs": [{"id": "image_source", "type": "image", "required": True}], "outputs": [], "bindings": [],
                  "parameters": {"type": "object", "additionalProperties": False, "properties": {}},
                  "execution": {"kind": "characterSheet", "version": 1, "stages": stages}}
    placeholders = {SHEET_PANEL_INPUT.format(panel_id=k) for k in SHEET_PANELS}
    for key, node in workflow.items():
        if key.startswith("stitch__") and node["class_type"] == "SaveImage":
            definition["outputs"].append({"id": "image_sheet", "type": "image", "nodeId": key})
        for field, value in node["inputs"].items():
            if isinstance(value, list) or node["class_type"] == "SaveImage" and field == "filename_prefix":
                continue
            if node["class_type"] == "LoadImage" and field == "image":
                if value not in placeholders:
                    node["inputs"][field] = "input.png"
                    definition["bindings"].append({"sourceKind": "input", "sourceId": "image_source", "nodeId": key, "input": field})
                continue
            param = "node_" + key + "__" + field
            require(len(param) <= 256, "阶段参数名称过长。")
            definition["parameters"]["properties"][param] = {"type": {str: "string", bool: "boolean", int: "integer", float: "number"}[type(value)], "default": value}
            definition["bindings"].append({"sourceKind": "parameter", "sourceId": param, "nodeId": key, "input": field})
    return {"definition": definition, "workflow": workflow}
