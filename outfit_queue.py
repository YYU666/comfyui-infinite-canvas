from __future__ import annotations

import copy
import struct

CURRENT_INPUT = "__H3_OUTFIT_CURRENT__"
PANEL_INPUT = "__H3_OUTFIT_PANEL_{panel_id}__"
SHEET_PANEL_INPUT = "__H3_CHARACTER_SHEET_PANEL_{panel_id}__"
SHEET_PANELS = ("front_portrait", "three_quarter_portrait", "back_body", "front_body")
SHEET_STABLE_PANELS = ("front_portrait", "three_quarter_portrait", "front_body", "back_body")
SHEET_PREP_PANELS = ("portrait_reference",) + SHEET_STABLE_PANELS


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


def _validate_portrait_reference(workflow):
    if set(workflow) != {"source", "crop", "pad", "save"}:
        raise ValueError("头像参考预处理只能加载、裁切、等比适配和保存。")
    source = workflow["source"]
    filename = source["inputs"].get("image")
    if source["class_type"] != "LoadImage" or set(source["inputs"]) != {"image"} or not isinstance(filename, str) or not filename or filename.startswith("__H3_") or any(c in filename for c in ":\x00") or any(part in {"", ".", ".."} for part in filename.replace("\\", "/").split("/")):
        raise ValueError("头像参考必须加载有效的原始图片。")
    crop = workflow["crop"]
    args = crop["inputs"]
    if crop["class_type"] != "ImageCrop" or set(args) != {"image", "x", "y", "width", "height"} or args["image"] != ["source", 0]:
        raise ValueError("头像参考裁切来源无效。")
    if any(type(args[k]) is not int for k in ("x", "y", "width", "height")) or args["x"] < 0 or args["y"] < 0 or args["width"] < 1 or args["height"] < 1 or args["x"] + args["width"] > 16384 or args["y"] + args["height"] > 16384:
        raise ValueError("头像参考裁切范围无效。")
    if workflow["pad"] != {"class_type": "ResizeAndPadImage", "inputs": {"image": ["crop", 0], "target_width": 1152, "target_height": 2048, "padding_color": "white", "interpolation": "lanczos"}}:
        raise ValueError("头像参考必须等比适配为 1152 × 2048。")
    if workflow["save"]["class_type"] != "SaveImage" or workflow["save"]["inputs"] != {"images": ["pad", 0], "filename_prefix": "image/H3_CharacterSheetPanel_portrait_reference"}:
        raise ValueError("头像参考保存引用无效。")


def _validate_identity_frame(workflow, panel_id):
    source = "portrait_crop" if "portrait_crop" in workflow else "source"
    expected = {"class_type": "ImageScale", "inputs": {"image": [source, 0], "upscale_method": "lanczos", "width": 1152, "height": 2048, "crop": "center"}}
    if workflow.get("portrait_reference") != expected:
        raise ValueError("身份参考必须按 1152 × 2048 中心覆盖取景，不能白边填充。")
    if source == "portrait_crop":
        crop = workflow[source]
        args = crop["inputs"]
        if crop["class_type"] != "ImageCrop" or set(args) != {"image", "x", "y", "width", "height"} or args["image"] != ["source", 0]:
            raise ValueError("身份参考裁切来源无效。")
        if any(type(args[k]) is not int for k in ("x", "y", "width", "height")) or args["x"] < 0 or args["y"] < 0 or args["width"] < 1 or args["height"] < 1 or args["x"] + args["width"] > 16384 or args["y"] + args["height"] > 16384:
            raise ValueError("身份参考裁切范围无效。")
    encoder = workflow.get(panel_id + "_encode", {}).get("inputs", {})
    if panel_id == "front_portrait":
        valid = encoder.get("images.image_1") == ["portrait_reference", 0] and "images.image_2" not in encoder
    else:
        valid = encoder.get("images.image_1") == ["angle_source", 0] and encoder.get("images.image_2") == ["portrait_reference", 0] and workflow.get("angle_source") == {"class_type": "LoadImage", "inputs": {"image": SHEET_PANEL_INPUT.format(panel_id="front_portrait")}}
    if not valid:
        raise ValueError("头像生成必须保持原始身份参考及已保存正面参考的明确顺序。")


def without_back_plan(value):
    """Select the explicit no-back branch; never substitute a front image as rear."""
    plan = copy.deepcopy(value)
    has_body = plan.get("referenceMode") == "identityBodyBack"
    back = next(panel for panel in plan["panels"] if panel["id"] == "back_body")
    back["single"] = back.pop("withoutBackSingle")
    if has_body:
        plan["referenceMode"] = "identityBody"
        back["inputRoles"] = {}
    elif plan.get("fidelityMode") == "sourceAnchored":
        plan["referenceMode"] = "identity"
        back["inputRoles"] = {}
    else:
        plan.pop("referenceMode", None)
        for panel in plan["panels"]:
            panel.pop("inputRoles", None)
    return plan


def _validate_sheet_plan(value):
    panels = value.get("panels")
    order = tuple(p.get("id") if isinstance(p, dict) else None for p in panels) if isinstance(panels, list) else ()
    if order not in (SHEET_PANELS, SHEET_STABLE_PANELS, SHEET_PREP_PANELS):
        raise ValueError("角色表阶段顺序无效。")
    fidelity = value.get("fidelityMode") == "sourceAnchored"
    if "fidelityMode" in value and not fidelity:
        raise ValueError("角色表身份保真模式无效。")
    if fidelity and (order != SHEET_STABLE_PANELS or value.get("referenceMode") not in ("identity", "identityBody", "identityBack", "identityBodyBack")):
        raise ValueError("原始身份锚定需要明确参考角色和四个生成阶段。")
    dual = value.get("referenceMode") in ("identityBody", "identityBack", "identityBodyBack") or fidelity
    body_reference = value.get("referenceMode") in ("identityBody", "identityBodyBack")
    back_reference = value.get("referenceMode") in ("identityBack", "identityBodyBack")
    if ("referenceMode" in value and not dual) or (dual and order not in (SHEET_STABLE_PANELS, SHEET_PREP_PANELS)):
        raise ValueError("角色表参考图角色模式无效。")
    if value.get("memoryPolicy", "preserve") != "preserve":
        raise ValueError("角色表仅支持 preserve 内存策略。")
    normalized = []
    for panel in panels:
        panel_id = panel["id"]
        dependencies = ["front_portrait"] if panel_id == "three_quarter_portrait" else []
        if order in (SHEET_STABLE_PANELS, SHEET_PREP_PANELS) and panel_id == "back_body":
            dependencies = ["front_body"]
        if order == SHEET_PREP_PANELS and panel_id == "front_portrait":
            dependencies = ["portrait_reference"]
        if body_reference and panel_id == "front_body":
            dependencies = ["front_portrait"]
        if panel.get("dependsOn") != dependencies:
            raise ValueError("角色表阶段依赖无效。")
        workflow = panel.get("single")
        _sheet_save(workflow, f"image/H3_CharacterSheetPanel_{panel_id}")
        if panel_id == "portrait_reference":
            _validate_portrait_reference(workflow)
        placeholders = [name for name in _sheet_inputs(workflow) if isinstance(name, str) and name.startswith("__H3_CHARACTER_SHEET_PANEL_")]
        expected = [SHEET_PANEL_INPUT.format(panel_id=key) for key in dependencies]
        if placeholders != expected or (not dual and dependencies and _sheet_inputs(workflow) != expected):
            raise ValueError("角色表依赖阶段必须仅加载指定的已保存图片。")
        item = {"id": panel_id, "label": str(panel.get("label") or panel_id), "dependsOn": dependencies, "single": copy.deepcopy(workflow)}
        if dual:
            roles = panel.get("inputRoles")
            identity_stage = "portrait_reference" if order == SHEET_PREP_PANELS else "front_portrait"
            role = "identity" if panel_id == identity_stage or fidelity and panel_id == "three_quarter_portrait" else ("body" if body_reference else "identity") if panel_id == "front_body" else "back" if panel_id == "back_body" and back_reference else None
            external = {key: node["inputs"].get("image") for key, node in workflow.items() if node["class_type"] == "LoadImage" and node["inputs"].get("image") not in expected}
            if not isinstance(roles, dict) or set(roles) != set(external) or list(roles.values()) != ([role] if role else []):
                raise ValueError("角色表外部参考图必须明确且正确标注身份或身体角色。")
            for name in external.values():
                if not isinstance(name, str) or not name or name.startswith("__") or any(c in name for c in ":\x00\r\n") or any(part in {"", ".", ".."} for part in name.replace("\\", "/").split("/")):
                    raise ValueError("角色表外部参考图路径无效。")
            if len(_sheet_inputs(workflow)) != len(expected) + len(external):
                raise ValueError("角色表参考图依赖数量无效。")
            for node in workflow.values():
                for connection in node["inputs"].values():
                    if isinstance(connection, list) and (len(connection) != 2 or not isinstance(connection[0], str) or connection[0] not in workflow or type(connection[1]) is not int or connection[1] < 0):
                        raise ValueError("角色表阶段不能引用其他阶段的节点。")
            item["inputRoles"] = copy.deepcopy(roles)
            if fidelity and panel_id in ("front_portrait", "three_quarter_portrait"):
                if roles != {"source": "identity"}:
                    raise ValueError("原始身份参考必须显式绑定 source。")
                _validate_identity_frame(workflow, panel_id)
        elif "inputRoles" in panel:
            raise ValueError("角色表参考图角色需要明确的双参考模式。")
        if "withoutBackSingle" in panel and not (back_reference and panel_id == "back_body"):
            raise ValueError("仅背面参考阶段可声明无背面参考分支。")
        normalized.append(item)
    stitch = value.get("stitch")
    _sheet_save(stitch, "image/H3_CharacterSheet")
    classes = [node.get("class_type") for node in stitch.values()]
    base_classes = ["LoadImage"] * 4 + ["ImageStitch"] * 3 + ["SaveImage"]
    cropped = sorted(classes) == sorted(base_classes + ["ImageCrop"] * 2 + ["ResizeAndPadImage"] * 2)
    if sorted(classes) != sorted(base_classes) and not cropped:
        raise ValueError("角色表最终阶段只能加载、确定性身体裁切和拼接保存。")
    if cropped:
        # Only the documented delivery graph is allowed; portraits cannot enter crop nodes.
        expected_ids = {f"{key}_load" for key in SHEET_PANELS} | {"top_row", "bottom_row", "quad", "save"} | {f"{key}_delivery_{op}" for key in ("front_body", "back_body") for op in ("crop", "pad")}
        if set(stitch) != expected_ids:
            raise ValueError("角色表交付裁切节点无效。")
        for key in SHEET_PANELS:
            if stitch[f"{key}_load"] != {"class_type": "LoadImage", "inputs": {"image": SHEET_PANEL_INPUT.format(panel_id=key)}}:
                raise ValueError("角色表交付来源无效。")
        for key in ("front_body", "back_body"):
            crop = stitch[f"{key}_delivery_crop"]
            args = crop["inputs"]
            if crop["class_type"] != "ImageCrop" or set(args) != {"image", "x", "y", "width", "height"} or args["image"] != [f"{key}_load", 0]:
                raise ValueError("角色表身体裁切来源无效。")
            if any(type(args[k]) is not int for k in ("x", "y", "width", "height")) or args["x"] < 0 or args["y"] < 0 or args["width"] < 1 or args["height"] < 1 or args["x"] + args["width"] > 1152 or args["y"] + args["height"] > 2048:
                raise ValueError("角色表身体裁切超出原图。")
            if stitch[f"{key}_delivery_pad"] != {"class_type": "ResizeAndPadImage", "inputs": {"image": [f"{key}_delivery_crop", 0], "target_width": 1152, "target_height": 2048, "padding_color": "white", "interpolation": "lanczos"}}:
                raise ValueError("角色表身体必须等比适配。")
        for key, image1, image2, direction in (("top_row", "front_portrait_load", "three_quarter_portrait_load", "right"), ("bottom_row", "back_body_delivery_pad", "front_body_delivery_pad", "right"), ("quad", "top_row", "bottom_row", "down")):
            if stitch[key] != {"class_type": "ImageStitch", "inputs": {"image1": [image1, 0], "image2": [image2, 0], "direction": direction, "match_image_size": False, "spacing_width": 0, "spacing_color": "white"}}:
                raise ValueError("角色表交付拼接引用无效。")
        if stitch["save"]["inputs"] != {"images": ["quad", 0], "filename_prefix": "image/H3_CharacterSheet"}:
            raise ValueError("角色表交付保存引用无效。")
    stitch_inputs = _sheet_inputs(stitch)
    if any(not isinstance(name, str) for name in stitch_inputs) or sorted(stitch_inputs) != sorted(SHEET_PANEL_INPUT.format(panel_id=key) for key in SHEET_PANELS):
        raise ValueError("角色表拼接必须引用全部四张阶段图片。")
    result = {"kind": "characterSheet", "memoryPolicy": "preserve", "panels": normalized, "stitch": copy.deepcopy(stitch)}
    if dual:
        result["referenceMode"] = value["referenceMode"]
    if fidelity:
        result["fidelityMode"] = "sourceAnchored"
        identities = [panel["single"][key]["inputs"]["image"] for panel in normalized for key, role in panel["inputRoles"].items() if role == "identity"]
        if len(set(identities)) != 1:
            raise ValueError("各阶段必须锚定同一个原始身份参考图。")
    if back_reference:
        original_back = next(panel for panel in panels if panel["id"] == "back_body")
        if not isinstance(original_back.get("withoutBackSingle"), dict):
            raise ValueError("背面参考阶段缺少明确的无背面参考分支。")
        if any(isinstance(node, dict) and isinstance(node.get("inputs"), dict) and any(field.startswith("images.image_") and field != "images.image_1" for field in node["inputs"]) for node in original_back["withoutBackSingle"].values()):
            raise ValueError("无背面参考分支不能包含第二参考图。")
        back = next(panel for panel in result["panels"] if panel["id"] == "back_body")
        back["withoutBackSingle"] = copy.deepcopy(original_back["withoutBackSingle"])
        fallback = _validate_sheet_plan(without_back_plan(result))
        back["withoutBackSingle"] = next(panel["single"] for panel in fallback["panels"] if panel["id"] == "back_body")
    return result


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
    if panel["id"] == "portrait_reference":
        return "角色表头像参考预处理 · 裁切并保存"
    offset = 1 if plan["panels"][0]["id"] == "portrait_reference" else 0
    return f"角色表独立出图 {state['panelIndex'] + 1 - offset}/4 · {panel['label']}"


def _sheet_stage_transfer(job, adapter):
    state = copy.deepcopy(job["planState"])
    final = state["phase"] == "stitch"
    panels = job["plan"]["panels"]
    panel_id = panels[state["panelIndex"]]["id"]
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
    if state["panelIndex"] == len(panels) - 1:
        state["phase"] = "stitch"
        progress = 94
    else:
        state["panelIndex"] += 1
        progress = state["panelIndex"] * 90 / len(panels)
    return {"planState": state, "comfyPromptId": None, "outputs": None, "history": None,
            "status": "running", "stage": sheet_stage_label(state, job["plan"]), "progress": progress}
