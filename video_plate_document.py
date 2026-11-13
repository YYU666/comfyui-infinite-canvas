"""Settings for the green-screen white-model plate.

One video in, one video out. The person and the extra objects named in
keepPrompts stay; everything else becomes the green colour. Filter text is
never taken from the user. SAM3 is text-conditioned by these prompts.
"""
from __future__ import annotations

import re

SCHEMA_VERSION = 1
SHADE_MODES = ("flat", "shaded")
FIELDS = ("schemaVersion", "keepPrompts", "maskGrow", "maskFeather", "shadeMode", "greenColor")
DEFAULTS = {
    "keepPrompts": ["person", "pole"],
    "maskGrow": 8,
    "maskFeather": 2,
    "shadeMode": "flat",
    "greenColor": "#00FF00",
}
_PROMPT = re.compile(r"[A-Za-z0-9 ._\-\u4e00-\u9fff]{1,40}\Z")
_COLOR = re.compile(r"#[0-9A-F]{6}\Z")


class PlateDocumentError(ValueError):
    pass


def _fail(message):
    raise PlateDocumentError(message)


def _keys(document):
    if not isinstance(document, dict):
        _fail("plateDocument 必须是对象。")
    unknown = sorted(set(document) - set(FIELDS))
    if unknown:
        _fail("plateDocument 含有不支持的字段：" + ", ".join(unknown))


def _whole(value, name, low, high):
    if type(value) is not int or isinstance(value, bool) or not low <= value <= high:
        _fail(f"{name} 必须是 {low}–{high} 的整数。")
    return value


def _color(value):
    if not isinstance(value, str):
        _fail("greenColor 必须是 #RRGGBB。")
    text = value.upper()
    if not _COLOR.fullmatch(text):
        _fail("greenColor 必须是 #RRGGBB。")
    return text


def _prompts(value):
    if value is None:
        value = list(DEFAULTS["keepPrompts"])
    if isinstance(value, str):
        value = [part.strip() for part in re.split(r"[,，]", value)]
        value = [part for part in value if part]
    if not isinstance(value, list) or not 1 <= len(value) <= 4:
        _fail("keepPrompts 需要 1–4 个文字提示，默认 person 与 pole。")
    result = []
    for item in value:
        if not isinstance(item, str) or not _PROMPT.fullmatch(item):
            _fail("keepPrompts 只接受字母、数字、空格、点、横线和中文，每项最多 40 字。")
        if item not in result:
            result.append(item)
    if not result:
        _fail("keepPrompts 至少要有一个提示词。")
    return result


def normalize_plate_document(document=None):
    if document is None:
        document = {}
    _keys(document)
    if "schemaVersion" in document and document["schemaVersion"] != SCHEMA_VERSION:
        _fail("plateDocument.schemaVersion 必须为 1。")
    merged = {**DEFAULTS, **{key: document[key] for key in DEFAULTS if key in document}}
    shade = merged["shadeMode"]
    if shade not in SHADE_MODES:
        _fail("shadeMode 只能是 flat 或 shaded。")
    return {
        "schemaVersion": SCHEMA_VERSION,
        "keepPrompts": _prompts(merged["keepPrompts"]),
        "maskGrow": _whole(merged["maskGrow"], "maskGrow", 0, 64),
        "maskFeather": _whole(merged["maskFeather"], "maskFeather", 0, 32),
        "shadeMode": shade,
        "greenColor": _color(merged["greenColor"]),
    }
