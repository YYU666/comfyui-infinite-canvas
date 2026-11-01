from __future__ import annotations

import copy
import struct

CURRENT_INPUT = "__H3_OUTFIT_CURRENT__"
PANEL_INPUT = "__H3_OUTFIT_PANEL_{panel_id}__"
SHEET_PANEL_INPUT = "__H3_CHARACTER_SHEET_PANEL_{panel_id}__"
SHEET_PANELS = ("front_portrait", "three_quarter_portrait", "back_body", "front_body")


def _sheet_inputs(workflow):
    return [node.get("inputs", {}).get("image") for node in workflow.values() if node.get("class_type") == "LoadImage"]


def _sheet_save(workflow, prefix):
    if not isinstance(workflow, dict) or not workflow or any(
        not isinstance(node, dict) or not isinstance(node.get("inputs"), dict) or not isinstance(node.get("class_type"), str)
        for node in workflow.values()
    ):
        raise ValueError("角色表阶段缺少有效工作流。")
    saves = [node for node in workflow.values() if node.get("class_type") == "SaveImage"]
    if len(saves) != 1 or saves[0].get("inputs", {}).get("filename_prefix") != prefix:
        raise ValueError("角色表阶段必须保存唯一且匹配的输出。")


def _validate_sheet_plan(value):
    panels = value.get("panels")
    if not isinstance(panels, list) or [p.get("id") if isinstance(p, dict) else None for p in panels] != list(SHEET_PANELS):
        raise ValueError("角色表必须依次生成正面头像、45°头像、背面身体、正面身体。")
    if value.get("memoryPolicy", "preserve") != "preserve":
        raise ValueError("角色表仅支持 preserve 内存策略。")
    normalized = []
    for panel in panels:
        panel_id = panel["id"]
        dependencies = ["front_portrait"] if panel_id == "three_quarter_portrait" else []
        if panel.get("dependsOn") != dependencies:
            raise ValueError("角色表阶段依赖无效。")
        workflow = panel.get("single")
        _sheet_save(workflow, f"image/H3_CharacterSheetPanel_{panel_id}")
        placeholders = [name for name in _sheet_inputs(workflow) if isinstance(name, str) and name.startswith("__H3_CHARACTER_SHEET_PANEL_")]
        expected = [SHEET_PANEL_INPUT.format(panel_id=key) for key in dependencies]
        if placeholders != expected or (dependencies and _sheet_inputs(workflow) != expected):
            raise ValueError("45°头像必须仅加载已保存的正面头像。")
        normalized.append({"id": panel_id, "label": str(panel.get("label") or panel_id), "dependsOn": dependencies, "single": copy.deepcopy(workflow)})
    stitch = value.get("stitch")
    _sheet_save(stitch, "image/H3_CharacterSheet")
    classes = [node.get("class_type") for node in stitch.values()]
    if sorted(classes) != sorted(["LoadImage"] * 4 + ["ImageStitch"] * 3 + ["SaveImage"]):
        raise ValueError("角色表最终阶段只能加载四张图片并拼接保存。")
    stitch_inputs = _sheet_inputs(stitch)
    if any(not isinstance(name, str) for name in stitch_inputs) or sorted(stitch_inputs) != sorted(SHEET_PANEL_INPUT.format(panel_id=key) for key in SHEET_PANELS):
        raise ValueError("角色表拼接必须引用全部四张阶段图片。")
    return {"kind": "characterSheet", "memoryPolicy": "preserve", "panels": normalized, "stitch": copy.deepcopy(stitch)}


def validate_plan(value):
    if isinstance(value, dict) and value.get("kind") == "characterSheet":
        return _validate_sheet_plan(value)
    if not isinstance(value, dict) or value.get("kind") != "outfit":
        raise ValueError("换装队列缺少有效阶段计划。")
    upscale_policy = value.get("upscalePolicy", "auto")
    if upscale_policy not in ("auto", "off", "seedvr2_7b"):
        raise ValueError("未知的换装高清策略。")
    panels = value.get("panels")
    if not isinstance(panels, list) or not 1 <= len(panels) <= 4:
        raise ValueError("换装阶段计划必须包含 1–4 个面板。")
    panel_ids = set()
    normalized_panels = []
    for panel in panels:
        if not isinstance(panel, dict):
            raise ValueError("换装面板计划格式无效。")
        panel_id = panel.get("id")
        if not isinstance(panel_id, str) or not panel_id or panel_id in panel_ids:
            raise ValueError("换装面板 ID 缺失或重复。")
        if not isinstance(panel.get("single"), dict) or not panel["single"]:
            raise ValueError(f"面板 {panel_id} 缺少单图工作流。")
        if upscale_policy != "off" and (not isinstance(panel.get("hd"), dict) or not panel["hd"]):
            raise ValueError(f"面板 {panel_id} 缺少高清工作流。")
        panel_ids.add(panel_id)
        normalized_panels.append({
            "id": panel_id,
            "label": str(panel.get("label") or panel_id),
            "preserve": bool(panel.get("preserve")),
            "single": copy.deepcopy(panel["single"]),
            "hd": copy.deepcopy(panel.get("hd")) if upscale_policy != "off" else None,
        })
    selected = value.get("selectedPanel")
    if selected is not None and selected not in panel_ids:
        raise ValueError("换装阶段计划包含未知单视图。")
    stitch = value.get("stitch")
    if selected is None and (not isinstance(stitch, dict) or not stitch):
        raise ValueError("完整换装缺少最终合成工作流。")
    return {
        "kind": "outfit",
        "upscalePolicy": upscale_policy,
        "selectedPanel": selected,
        "panels": normalized_panels,
        "stitch": copy.deepcopy(stitch) if isinstance(stitch, dict) else None,
    }


def initial_state():
    return {"panelIndex": 0, "phase": "single", "images": {}, "currentInput": None, "promptIds": []}


def _replace(value, replacements):
    if isinstance(value, str):
        return replacements.get(value, value)
    if isinstance(value, list):
        return [_replace(item, replacements) for item in value]
    if isinstance(value, dict):
        return {key: _replace(item, replacements) for key, item in value.items()}
    return value


def stage_workflow(job):
    plan = job["plan"]
    state = job["planState"]
    phase = state["phase"]
    if plan["kind"] == "characterSheet":
        if phase == "stitch":
            required, workflow = SHEET_PANELS, plan["stitch"]
        elif phase == "single":
            panel = plan["panels"][state["panelIndex"]]
            required, workflow = panel["dependsOn"], panel["single"]
        else:
            raise ValueError(f"未知角色表阶段：{phase}")
        if any(not state["images"].get(key) for key in required):
            raise ValueError("角色表阶段依赖图片尚未保存。")
        replacements = {SHEET_PANEL_INPUT.format(panel_id=key): state["images"][key] for key in required}
        return _replace(copy.deepcopy(workflow), replacements)
    if phase == "stitch":
        replacements = {PANEL_INPUT.format(panel_id=key): name for key, name in state["images"].items()}
        return _replace(copy.deepcopy(plan["stitch"]), replacements)
    panel = plan["panels"][state["panelIndex"]]
    if phase == "single":
        return copy.deepcopy(panel["single"])
    if phase == "hd":
        return _replace(copy.deepcopy(panel["hd"]), {CURRENT_INPUT: state["currentInput"]})
    raise ValueError(f"未知换装阶段：{phase}")


def _find_output(outputs, prefix):
    for output in (outputs or {}).values():
        if not isinstance(output, dict):
            continue
        for value in output.values():
            if not isinstance(value, list):
                continue
            for file in value:
                if isinstance(file, dict) and str(file.get("filename", "")).startswith(prefix):
                    return file
    raise ValueError(f"阶段已结束，但没有找到 {prefix} 输出图片。")


def _dimensions(file, content):
    metadata = file.get("metadata") or {}
    width, height = metadata.get("width"), metadata.get("height")
    if width and height:
        return int(width), int(height)
    if content.startswith(b"\x89PNG\r\n\x1a\n") and len(content) >= 24:
        return struct.unpack(">II", content[16:24])
    raise ValueError("无法读取换装单图尺寸，已停止而不是猜测是否高清。")


def _next_panel_or_stitch(job, state):
    plan = job["plan"]
    count = len(plan["panels"])
    index = state["panelIndex"]
    if index + 1 < count:
        state["panelIndex"] = index + 1
        state["phase"] = "single"
        state["currentInput"] = None
        panel = plan["panels"][index + 1]
        return {
            "status": "running", "stage": f"{'保留原图' if panel['preserve'] else '千问独立换装'} {index + 2}/{count} · {panel['label']}",
            "progress": (index + 1) * 90 / count,
        }
    if plan.get("selectedPanel") is not None:
        return {"status": "done", "stage": "生成完成", "progress": 100}
    state["phase"] = "stitch"
    state["currentInput"] = None
    return {"status": "running", "stage": "四张单图已就绪 · 正在按母图原版面合成", "progress": 94}


def stage_transfer(job, adapter):
    """Transfer the finished stage outside the manager lock; return its next persisted state."""
    plan = job["plan"]
    if plan["kind"] == "characterSheet":
        return _sheet_stage_transfer(job, adapter)
    state = copy.deepcopy(job["planState"])
    phase = state["phase"]
    if phase == "stitch":
        return {"status": "done", "stage": "生成完成", "progress": 100}
    panel = plan["panels"][state["panelIndex"]]
    panel_id = panel["id"]
    prefix = f"H3_OutfitSingle_{panel_id}_" if phase == "single" else f"H3_OutfitHD_{panel_id}_"
    file = _find_output(job.get("outputs"), prefix)
    content = adapter.download(file)
    width, height = _dimensions(file, content)
    uploaded = adapter.upload_image(file["filename"], content)
    adapter.free()
    state["images"][panel_id] = uploaded
    state["currentInput"] = uploaded
    count = len(plan["panels"])
    index = state["panelIndex"]
    upscale_policy = plan.get("upscalePolicy", "auto")
    needs_hd = upscale_policy == "seedvr2_7b" or (upscale_policy == "auto" and max(width, height) < 1000)
    if phase == "single" and needs_hd:
        state["phase"] = "hd"
        return {
            "planState": state, "comfyPromptId": None, "outputs": None, "history": None,
            "status": "running", "stage": f"{'SeedVR2 7B' if upscale_policy == 'seedvr2_7b' else '低于 1K'} · 独立高清 {index + 1}/{count} · {panel['label']}",
            "progress": index * 90 / count + 45 / count,
        }
    patch = _next_panel_or_stitch(job, state)
    patch["planState"] = state
    if patch["status"] != "done":
        patch.update({"comfyPromptId": None, "outputs": None, "history": None})
    return patch


def sheet_stage_label(state, plan):
    if state["phase"] == "stitch":
        return "四张单图已保存 · 正在拼接角色表"
    panel = plan["panels"][state["panelIndex"]]
    return f"角色表独立出图 {state['panelIndex'] + 1}/4 · {panel['label']}"


def _sheet_stage_transfer(job, adapter):
    state = copy.deepcopy(job["planState"])
    final = state["phase"] == "stitch"
    panel_id = SHEET_PANELS[state["panelIndex"]]
    prefix = "H3_CharacterSheet_" if final else f"H3_CharacterSheetPanel_{panel_id}_"
    file = _find_output(job.get("outputs"), prefix)
    content = adapter.download(file)
    expected = (2304, 4096) if final else (1152, 2048)
    if _dimensions(file, content) != expected:
        raise ValueError(f"角色表阶段输出尺寸必须为 {expected[0]} × {expected[1]}。")
    if final:
        return {"status": "done", "stage": "生成完成", "progress": 100}
    uploaded = adapter.upload_image(file["filename"], content)
    if not isinstance(uploaded, str) or not uploaded:
        raise ValueError("角色表阶段图片上传未返回有效文件名。")
    # Persist both the original Comfy output identity and its reloadable input.
    # Keep model weights/cache resident; unlike outfit HD transitions, no free().
    state["images"][panel_id] = uploaded
    state.setdefault("panelOutputs", {})[panel_id] = copy.deepcopy(file)
    if state["panelIndex"] == len(SHEET_PANELS) - 1:
        state["phase"] = "stitch"
        progress = 94
    else:
        state["panelIndex"] += 1
        progress = state["panelIndex"] * 90 / len(SHEET_PANELS)
    return {"planState": state, "comfyPromptId": None, "outputs": None, "history": None,
            "status": "running", "stage": sheet_stage_label(state, job["plan"]), "progress": progress}
