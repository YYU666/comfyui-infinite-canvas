"""Settings for the green-screen key and composite node.

One video stream out. The foreground is a keyed video; the background is a still
image or a video. No expressions, no extra channels. Filter text is never taken
from the user: only the fields validated here reach FFmpeg, and only as numbers
or a #RRGGBB color.
"""
from __future__ import annotations

import math
import re

SCHEMA_VERSION = 1
MAX_EDGE = 4096
MIN_EDGE = 16
ANCHORS = ("center", "top", "bottom", "left", "right", "topLeft", "topRight", "bottomLeft", "bottomRight")
FITS = ("cover", "contain", "stretch")
OUTPUT_SIZES = ("background", "foreground")
AUDIO_MODES = ("preserve", "mute")
PREVIEW_MODES = ("composite", "matte", "foreground")
FIELDS = (
    "schemaVersion", "keyColor", "similarity", "blend", "despill", "choke", "feather",
    "scale", "offsetX", "offsetY", "anchor", "backgroundFit", "outputSize", "audio", "startOffset",
)
DEFAULTS = {
    "keyColor": "#00FF00",
    "similarity": 0.2,
    "blend": 0.08,
    "despill": 0.5,
    "choke": 0,
    "feather": 0,
    "scale": 1,
    "offsetX": 0,
    "offsetY": 0,
    "anchor": "center",
    "backgroundFit": "cover",
    "outputSize": "background",
    "audio": "preserve",
    "startOffset": 0,
}
_ANCHOR_XY = {
    "center": (0.5, 0.5),
    "top": (0.5, 0.0),
    "bottom": (0.5, 1.0),
    "left": (0.0, 0.5),
    "right": (1.0, 0.5),
    "topLeft": (0.0, 0.0),
    "topRight": (1.0, 0.0),
    "bottomLeft": (0.0, 1.0),
    "bottomRight": (1.0, 1.0),
}


class ChromaDocumentError(ValueError):
    pass


def _fail(message):
    raise ChromaDocumentError(message)


def _keys(value, allowed, path):
    if not isinstance(value, dict):
        _fail(f"{path} 必须是对象。")
    unknown = sorted(set(value) - set(allowed))
    if unknown:
        _fail(f"{path} 含不支持的字段：{', '.join(unknown)}。")


def _snap(value, path, low, high):
    """Finite number on a 0.001 grid, returned snapped (whole values stay ints)."""
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        _fail(f"{path} 必须是有限数字。")
    if value < low or value > high:
        _fail(f"{path} 必须在 {low}–{high} 之间。")
    milli = int(round(float(value) * 1000))
    snapped = milli / 1000
    if abs(snapped - float(value)) > 1e-6:
        _fail(f"{path} 只精确到 0.001。")
    if snapped == int(snapped):
        return int(snapped)
    return snapped


def _whole(value, path, low, high):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        _fail(f"{path} 必须是整数。")
    if abs(float(value) - round(float(value))) > 1e-9:
        _fail(f"{path} 必须是整数。")
    number = int(round(float(value)))
    if number < low or number > high:
        _fail(f"{path} 必须在 {low}–{high} 之间。")
    return number


def _color(value, path="keyColor"):
    if not isinstance(value, str) or not re.fullmatch(r"#[0-9A-Fa-f]{6}", value):
        _fail(f"{path} 必须是 #RRGGBB。")
    return value.upper()


def _choice(value, allowed, path):
    if value not in allowed:
        _fail(f"{path} 必须是 {'、'.join(allowed)}。")
    return value


def spill_type(key_color):
    """Green unless blue is strictly the strongest channel (a blue screen)."""
    red = int(key_color[1:3], 16)
    green = int(key_color[3:5], 16)
    blue = int(key_color[5:7], 16)
    return "blue" if blue > green and blue >= red else "green"


def normalize_chroma_document(document):
    """Fill defaults, reject unknown fields, and derive the despill type."""
    if document is None:
        document = {}
    _keys(document, FIELDS, "chromaDocument")
    if "schemaVersion" in document and document["schemaVersion"] != SCHEMA_VERSION:
        _fail("chromaDocument.schemaVersion 必须为 1。")
    merged = {**DEFAULTS, **{key: document[key] for key in DEFAULTS if key in document}}
    key_color = _color(merged["keyColor"])
    return {
        "schemaVersion": SCHEMA_VERSION,
        "keyColor": key_color,
        "similarity": _snap(merged["similarity"], "similarity", 0, 1),
        "blend": _snap(merged["blend"], "blend", 0, 1),
        "despill": _snap(merged["despill"], "despill", 0, 1),
        "choke": _whole(merged["choke"], "choke", 0, 8),
        "feather": _whole(merged["feather"], "feather", 0, 16),
        "scale": _snap(merged["scale"], "scale", 0.05, 8),
        "offsetX": _whole(merged["offsetX"], "offsetX", -4096, 4096),
        "offsetY": _whole(merged["offsetY"], "offsetY", -4096, 4096),
        "anchor": _choice(merged["anchor"], ANCHORS, "anchor"),
        "backgroundFit": _choice(merged["backgroundFit"], FITS, "backgroundFit"),
        "outputSize": _choice(merged["outputSize"], OUTPUT_SIZES, "outputSize"),
        "audio": _choice(merged["audio"], AUDIO_MODES, "audio"),
        "startOffset": _snap(merged["startOffset"], "startOffset", 0, 600),
        "spill": spill_type(key_color),
    }


def normalize_preview_request(time, mode):
    if time is None:
        time = 0
    snapped = _snap(time, "time", 0, 600)
    if mode is None:
        mode = "composite"
    return {"time": snapped, "mode": _choice(mode, PREVIEW_MODES, "mode")}


def even_size(width, height, path):
    """Floor to even pixels. Odd plates (721×1281) become 720×1280."""
    if isinstance(width, bool) or isinstance(height, bool) or type(width) is not int or type(height) is not int:
        _fail(f"{path} 尺寸无效。")
    even_width = width - (width % 2)
    even_height = height - (height % 2)
    if even_width < MIN_EDGE or even_height < MIN_EDGE or even_width > MAX_EDGE or even_height > MAX_EDGE:
        _fail(f"{path} 宽高取偶数后必须在 {MIN_EDGE}–{MAX_EDGE} 之间。")
    return even_width, even_height


def _scaled_edge(pixels, scale_milli):
    size = (int(pixels) * scale_milli + 500) // 1000
    size -= size % 2
    if size < 2:
        size = 2
    if size > MAX_EDGE:
        _fail("前景缩放后超过 4096。")
    return size


def _half(span):
    if span >= 0:
        return (span + 1) // 2
    return -(((-span) + 1) // 2)


def _anchor_offset(span, anchor):
    if anchor == 0:
        return 0
    if anchor == 1:
        return span
    return _half(span)


def plan_placement(document, fg_width, fg_height, bg_width, bg_height):
    """Pixel placement. ``scale`` 1 keeps the foreground's native pixel size.

    Output size follows the background (floored to even) unless outputSize is
    foreground. The foreground is then anchored on that canvas; offsets are pixels.
    """
    document = document if document.get("schemaVersion") == SCHEMA_VERSION and "spill" in document else normalize_chroma_document(document)
    if document["outputSize"] == "background":
        out_w, out_h = even_size(int(bg_width), int(bg_height), "背景")
    else:
        out_w, out_h = even_size(int(fg_width), int(fg_height), "前景")
    scale_milli = int(round(float(document["scale"]) * 1000))
    fg_w = _scaled_edge(fg_width, scale_milli)
    fg_h = _scaled_edge(fg_height, scale_milli)
    ax, ay = _ANCHOR_XY[document["anchor"]]
    x = _anchor_offset(out_w - fg_w, ax) + document["offsetX"]
    y = _anchor_offset(out_h - fg_h, ay) + document["offsetY"]
    return {
        "outputWidth": out_w,
        "outputHeight": out_h,
        "foregroundWidth": fg_w,
        "foregroundHeight": fg_h,
        "overlayX": x,
        "overlayY": y,
    }
