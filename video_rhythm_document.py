"""Keyframe and constant-speed documents for video rhythm nodes.

One video stream. Curves are keyframes only (linear and ease in/out): output time
on X, source time on Y. A flat segment is a freeze. No expressions, no channels.
"""
from __future__ import annotations

import math
from fractions import Fraction

SCHEMA_VERSION = 1
MAX_KEYS = 64
MAX_SECONDS = 600
INTERPOLATION = ("linear", "easeIn", "easeOut", "easeInOut")
AUDIO_MODES = ("preserve", "stretch", "mute")


class RhythmDocumentError(ValueError):
    pass


def _fail(message):
    raise RhythmDocumentError(message)


def _keys(value, allowed, path, required=()):
    if not isinstance(value, dict):
        _fail(f"{path} 必须是对象。")
    unknown = sorted(set(value) - set(allowed))
    if unknown:
        _fail(f"{path} 含不支持的字段：{', '.join(unknown)}。")
    missing = [key for key in required if key not in value]
    if missing:
        _fail(f"{path} 缺少字段：{', '.join(missing)}。")


def _speed(value, path="speed"):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        _fail(f"{path} 必须是有限数字。")
    if value < 0.25 or value > 4:
        _fail(f"{path} 必须在 0.25–4 之间（0.5 为两倍慢放 / 升格，2 为两倍快放）。")
    rate = Fraction(value).limit_denominator(1000)
    if abs(float(rate) - float(value)) > 1e-6:
        _fail(f"{path} 无法表示为精确倍率。")
    return {"num": rate.numerator, "den": rate.denominator}


def _audio(value):
    if value not in AUDIO_MODES:
        _fail("audio 必须是 preserve、stretch 或 mute。")
    return value


def _seconds_ms(value, path):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        _fail(f"{path} 必须是有限秒数。")
    if value < 0 or value > MAX_SECONDS:
        _fail(f"{path} 必须在 0–{MAX_SECONDS} 秒之间。")
    milliseconds = int(round(float(value) * 1000))
    if abs(milliseconds / 1000 - float(value)) > 1e-6:
        _fail(f"{path} 只精确到毫秒。")
    return milliseconds


def _interpolation(value, path):
    if value not in INTERPOLATION:
        _fail(f"{path} 必须是 linear、easeIn、easeOut 或 easeInOut。")
    return value


def normalize_speed_document(document):
    """Constant speed. ``speed`` 0.5 holds each source frame for two output frames."""
    _keys(document, ["schemaVersion", "operation", "speed", "audio"], "speedDocument", ["schemaVersion", "speed"])
    if document["schemaVersion"] != SCHEMA_VERSION:
        _fail("speedDocument.schemaVersion 必须为 1。")
    if "operation" in document and document["operation"] != "speed":
        _fail("speedDocument.operation 必须是 speed。")
    return {
        "schemaVersion": SCHEMA_VERSION,
        "operation": "speed",
        "speed": _speed(document["speed"]),
        "audio": _audio(document.get("audio", "preserve")),
    }


def normalize_remap_document(document):
    """Source-time curve. Flat Y is a freeze; slope < 1 is slow, slope > 1 is fast."""
    _keys(document, ["schemaVersion", "operation", "keyframes"], "remapDocument", ["schemaVersion", "keyframes"])
    if document["schemaVersion"] != SCHEMA_VERSION:
        _fail("remapDocument.schemaVersion 必须为 1。")
    if "operation" in document and document["operation"] != "remap":
        _fail("remapDocument.operation 必须是 remap。")
    rows = document["keyframes"]
    if not isinstance(rows, list) or not 2 <= len(rows) <= MAX_KEYS:
        _fail(f"keyframes 必须是 2–{MAX_KEYS} 个关键帧。")
    keyframes = []
    for index, row in enumerate(rows):
        path = f"keyframes[{index}]"
        _keys(row, ["output", "source", "interpolation"], path, ["output", "source"])
        item = {
            "output": _seconds_ms(row["output"], f"{path}.output") / 1000,
            "source": _seconds_ms(row["source"], f"{path}.source") / 1000,
            "interpolation": _interpolation(row.get("interpolation", "linear"), f"{path}.interpolation"),
        }
        if keyframes and item["output"] <= keyframes[-1]["output"]:
            _fail(f"{path}.output 必须严格递增（成片时间轴）。")
        if keyframes and item["source"] < keyframes[-1]["source"]:
            _fail(f"{path}.source 不能回退；倒放请用视频编辑节点。")
        keyframes.append(item)
    if keyframes[0]["output"] != 0:
        _fail("第一个关键帧的 output 必须是 0。")
    return {"schemaVersion": SCHEMA_VERSION, "operation": "remap", "keyframes": keyframes}


def speed_rate(document):
    speed = document["speed"]
    return Fraction(speed["num"], speed["den"])


def speed_frame_indices(frame_count, rate):
    """Output frame i shows source frame floor(i * N / out). out = round(N / rate)."""
    if type(frame_count) is not int or frame_count < 1:
        _fail("素材没有可映射的视频帧。")
    if not isinstance(rate, Fraction) or rate <= 0:
        _fail("speed 倍率无效。")
    total = max(1, int(round(frame_count * rate.denominator / rate.numerator)))
    return [min(frame_count - 1, (index * frame_count) // total) for index in range(total)]


def _ease(amount, kind):
    if kind == "linear":
        return amount
    if kind == "easeIn":
        return amount * amount
    if kind == "easeOut":
        return 1 - (1 - amount) ** 2
    if kind == "easeInOut":
        return amount * amount * (3 - 2 * amount)
    _fail("不支持的插值。")


def sample_source_time(keyframes, output_time):
    """Source time in seconds at an output time. ``output_time`` may be a Fraction."""
    if isinstance(output_time, float) and not math.isfinite(output_time):
        _fail("输出时间无效。")
    current = Fraction(output_time)
    first_out = Fraction(keyframes[0]["output"])
    first_src = Fraction(keyframes[0]["source"])
    if current <= first_out:
        return first_src
    last_out = Fraction(keyframes[-1]["output"])
    last_src = Fraction(keyframes[-1]["source"])
    if current >= last_out:
        return last_src
    for index in range(len(keyframes) - 1):
        start, end = keyframes[index], keyframes[index + 1]
        t0, t1 = Fraction(start["output"]), Fraction(end["output"])
        if not t0 <= current <= t1:
            continue
        s0, s1 = Fraction(start["source"]), Fraction(end["source"])
        if t1 == t0 or s1 == s0:
            return s0
        if start["interpolation"] == "linear":
            return s0 + (s1 - s0) * (current - t0) / (t1 - t0)
        amount = float((current - t0) / (t1 - t0))
        eased = _ease(amount, start["interpolation"])
        return s0 + (s1 - s0) * Fraction(eased).limit_denominator(10**9)
    return last_src


def source_fps(probe):
    step = probe.get("frameTimebase")
    if step is None or step <= 0:
        _fail("变速和时间重映射目前只接受恒定帧率视频。")
    return 1 / step


def remap_frame_indices(probe, keyframes):
    """One output frame per source-fps tick from 0 inclusive to the last key exclusive."""
    fps = source_fps(probe)
    duration = probe["duration"]
    last = Fraction(keyframes[-1]["output"])
    total = int(round(last * fps))
    if total < 1:
        _fail("重映射成片至少需要 1 帧。")
    if total > 20000:
        _fail("重映射成片超过 20000 帧。")
    times = probe["frameTimes"]
    from video_edit_document import nearest_frame

    indices = []
    for index in range(total):
        output_time = Fraction(index) / fps
        source_time = sample_source_time(keyframes, output_time)
        if source_time > duration:
            _fail(f"曲线在成片 {float(output_time):.3f} 秒处的源时间 {float(source_time):.3f} 秒超出素材时长 {float(duration):.3f} 秒。")
        indices.append(nearest_frame(times, source_time))
    return indices
