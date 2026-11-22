"""Strict document for bounded spatial interpolation; never an AI restoration."""
from __future__ import annotations

import math
from fractions import Fraction

MAX_SECONDS = 120
MAX_FRAMES = 7200
MAX_EDGE = 4096


class RepairDocumentError(ValueError):
    pass


def number(value, name, low, high):
    if type(value) not in (int, float) or not low <= value <= high or not math.isfinite(value):
        raise RepairDocumentError(f"{name} 必须是 {low}–{high} 内的有限数字。")
    return value


def normalize_repair_document(value):
    if not isinstance(value, dict) or set(value) - {"schemaVersion", "rect", "start", "end"}:
        raise RepairDocumentError("settings 字段无效。")
    version = value.get("schemaVersion", 1)
    if type(version) is not int or version != 1:
        raise RepairDocumentError("schemaVersion 必须为 1。")
    rect = value.get("rect")
    if not isinstance(rect, dict) or set(rect) != {"x", "y", "width", "height"}:
        raise RepairDocumentError("rect 必须包含归一化 x、y、width、height。")
    rect = {k: number(v, f"rect.{k}", 0, 1) for k, v in rect.items()}
    if (not 0 < rect["width"] <= .5 or not 0 < rect["height"] <= .5
            or rect["width"] * rect["height"] > .15
            or rect["x"] + rect["width"] > 1 or rect["y"] + rect["height"] > 1):
        raise RepairDocumentError("选区必须在画面内，每边不超过一半，面积不超过 15%。")
    start = number(value.get("start", 0), "start", 0, MAX_SECONDS)
    end = value.get("end")
    if end is not None:
        end = number(end, "end", 0, MAX_SECONDS)
        if end <= start:
            raise RepairDocumentError("end 必须大于 start。")
    return {"schemaVersion": 1, "rect": rect, "start": start, "end": end}


def normalize_preview_request(time=0, mode="repaired"):
    time = number(time, "time", 0, MAX_SECONDS)
    if mode not in ("original", "mask", "repaired"):
        raise RepairDocumentError("mode 必须是 original、mask 或 repaired。")
    return {"time": time, "mode": mode}


def plan_repair(document, info):
    document = normalize_repair_document(document)
    w, h = info["width"], info["height"]
    step = info["frameTimebase"]
    if (min(w, h) < 16 or max(w, h) > MAX_EDGE or w % 2 or h % 2
            or step is None or not Fraction(1, 60) <= step <= 1
            or info["duration"] > MAX_SECONDS or info["frameCount"] > MAX_FRAMES):
        raise RepairDocumentError("仅支持偶数尺寸 16–4096、1–60 FPS 恒定帧率、最长 120 秒的视频。")
    r = document["rect"]
    x, y = math.floor(r["x"] * w), math.floor(r["y"] * h)
    right, bottom = math.ceil((r["x"] + r["width"]) * w), math.ceil((r["y"] + r["height"]) * h)
    if x < 2 or y < 2 or right > w - 2 or bottom > h - 2 or right - x < 4 or bottom - y < 4:
        raise RepairDocumentError("实际选区至少 4×4 像素，且距画面四边至少 2 像素。")
    start = Fraction(str(document["start"]))
    end = info["duration"] if document["end"] is None else Fraction(str(document["end"]))
    if start >= info["duration"] or end > info["duration"]:
        raise RepairDocumentError("修复时间必须在视频时长内。")
    first, last = math.ceil(start / step), math.ceil(end / step) - 1
    if first > last:
        raise RepairDocumentError("时间范围内没有视频帧。")
    return {"pixelRect": {"x": x, "y": y, "width": right - x, "height": bottom - y},
            "first": first, "last": last, "fps": 1 / step}
