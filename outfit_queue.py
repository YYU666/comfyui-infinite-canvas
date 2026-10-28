from __future__ import annotations

import copy
import struct

CURRENT_INPUT = "__H3_OUTFIT_CURRENT__"
PANEL_INPUT = "__H3_OUTFIT_PANEL_{panel_id}__"


def validate_plan(value):
    if not isinstance(value, dict) or value.get("kind") != "outfit":
        raise ValueError("换装队列缺少有效阶段计划。")
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
        if not isinstance(panel.get("hd"), dict) or not panel["hd"]:
            raise ValueError(f"面板 {panel_id} 缺少高清工作流。")
        panel_ids.add(panel_id)
        normalized_panels.append({
            "id": panel_id,
            "label": str(panel.get("label") or panel_id),
            "preserve": bool(panel.get("preserve")),
            "single": copy.deepcopy(panel["single"]),
            "hd": copy.deepcopy(panel["hd"]),
        })
    selected = value.get("selectedPanel")
    if selected is not None and selected not in panel_ids:
        raise ValueError("换装阶段计划包含未知单视图。")
    stitch = value.get("stitch")
    if selected is None and (not isinstance(stitch, dict) or not stitch):
        raise ValueError("完整换装缺少最终合成工作流。")
    return {
        "kind": "outfit",
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
    if phase == "single" and max(width, height) < 1000:
        state["phase"] = "hd"
        return {
            "planState": state, "comfyPromptId": None, "outputs": None, "history": None,
            "status": "running", "stage": f"低于 1K · 独立高清 {index + 1}/{count} · {panel['label']}",
            "progress": index * 90 / count + 45 / count,
        }
    patch = _next_panel_or_stitch(job, state)
    patch["planState"] = state
    if patch["status"] != "done":
        patch.update({"comfyPromptId": None, "outputs": None, "history": None})
    return patch
