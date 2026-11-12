"""Video edit document (E1): strict schema validation and exact PTS arithmetic.

Times are integers on rational time bases (fractions.Fraction); floats are never the
source of truth.  Every clip PTS is relative to the first decoded video frame of
its input (first frame == 0).  A clip may declare its own ``timebase`` (for example
``{"num": 1, "den": 24}`` to address frames); otherwise the source video stream
time base is used.

Resampling to the output frame rate uses one global grid per input, anchored at
that input's first frame: grid index k sits at k / outputFps.  A clip selects the
grid points inside its half-open source interval, so separate clips never round
independently and long timelines cannot drift.
"""
from __future__ import annotations

import math
import re
from fractions import Fraction

SCHEMA_VERSION = 1
INPUT_SLOTS = tuple(f"v{index}" for index in range(1, 9)) + ("a1",)
VIDEO_SLOTS = INPUT_SLOTS[:-1]
MAX_CLIPS = 64
MAX_PAD = 2000
MAX_PTS = 2 ** 53 - 1
MAX_OUTPUT_FRAMES = 60 * 60 * 120  # one hour at 120 fps
AUDIO_RATE = 48000
CLIP_ID = re.compile(r"[A-Za-z0-9_-]{1,64}")
DEFAULT_PROFILE = {"fps": {"num": 24, "den": 1}, "audio": "clips", "videoCodec": "h264", "audioCodec": "aac", "crf": 14}


class EditDocumentError(ValueError):
    """A user/agent supplied document is invalid; message is safe to show."""


def _fail(message):
    raise EditDocumentError(message)


def _keys(value, allowed, path, required=()):
    if not isinstance(value, dict):
        _fail(f"{path} 必须是对象。")
    unknown = sorted(set(value) - set(allowed))
    if unknown:
        _fail(f"{path} 含不支持的字段：{', '.join(unknown)}。")
    missing = [key for key in required if key not in value]
    if missing:
        _fail(f"{path} 缺少字段：{', '.join(missing)}。")


def _int(value, path, minimum=0, maximum=MAX_PTS):
    if type(value) is not int or value < minimum or value > maximum:
        _fail(f"{path} 必须是 {minimum}–{maximum} 之间的整数。")
    return value


def _bool(value, path):
    if type(value) is not bool:
        _fail(f"{path} 必须是布尔值。")
    return value


def _rational(value, path, *, minimum=None, maximum=None):
    _keys(value, ("num", "den"), path, ("num", "den"))
    num = _int(value["num"], f"{path}.num", 1, 1_000_000)
    den = _int(value["den"], f"{path}.den", 1, 1_000_000)
    fraction = Fraction(num, den)
    if minimum is not None and fraction < minimum or maximum is not None and fraction > maximum:
        _fail(f"{path} 超出允许范围。")
    return {"num": num, "den": den}


def as_fraction(rational):
    return Fraction(rational["num"], rational["den"])


def _slot(value, path, allowed=INPUT_SLOTS):
    if not isinstance(value, str) or value not in allowed:
        _fail(f"{path} 必须是输入端口 {', '.join(allowed)} 之一。")
    return value


def _range(value, path):
    start = _int(value.get("sourceInPts"), f"{path}.sourceInPts")
    end = _int(value.get("sourceOutPts"), f"{path}.sourceOutPts")
    if end <= start:
        _fail(f"{path} 的 sourceOutPts 必须大于 sourceInPts（半开区间）。")
    return start, end


def normalize_document(document):
    """Validate an untrusted document and return a normalized copy (defaults filled)."""
    _keys(document, ("schemaVersion", "timelineTimebase", "outputProfile", "clips"), "editDocument", ("schemaVersion", "clips"))
    if document["schemaVersion"] != SCHEMA_VERSION or type(document["schemaVersion"]) is not int:
        _fail("editDocument.schemaVersion 必须为 1。")
    profile_in = document.get("outputProfile", {})
    _keys(profile_in, ("fps", "width", "height", "audio", "audioFrom", "videoCodec", "audioCodec", "crf"), "outputProfile")
    profile = {**DEFAULT_PROFILE, **profile_in}
    profile["fps"] = _rational(profile["fps"], "outputProfile.fps", minimum=Fraction(1), maximum=Fraction(120))
    for key in ("width", "height"):
        if key in profile:
            value = _int(profile[key], f"outputProfile.{key}", 16, 7680)
            if value % 2:
                _fail(f"outputProfile.{key} 必须是偶数（yuv420p）。")
    if ("width" in profile) != ("height" in profile):
        _fail("outputProfile.width 与 height 必须同时提供或同时省略。")
    if profile["audio"] not in ("clips", "mute", "external"):
        _fail("outputProfile.audio 必须是 clips、mute 或 external。")
    if profile["videoCodec"] != "h264":
        _fail("outputProfile.videoCodec 目前只支持 h264。")
    if profile["audioCodec"] != "aac":
        _fail("outputProfile.audioCodec 目前只支持 aac。")
    _int(profile["crf"], "outputProfile.crf", 0, 51)
    if profile["audio"] == "external":
        source = profile.get("audioFrom")
        _keys(source, ("inputSlot", "sourceInPts", "sourceOutPts", "timebase"), "outputProfile.audioFrom", ("inputSlot", "sourceInPts", "sourceOutPts"))
        normalized = {"inputSlot": _slot(source["inputSlot"], "outputProfile.audioFrom.inputSlot")}
        normalized["sourceInPts"], normalized["sourceOutPts"] = _range(source, "outputProfile.audioFrom")
        if "timebase" in source:
            normalized["timebase"] = _rational(source["timebase"], "outputProfile.audioFrom.timebase")
        profile["audioFrom"] = normalized
    elif "audioFrom" in profile:
        _fail("只有 outputProfile.audio=external 时才能提供 audioFrom。")
    fps = as_fraction(profile["fps"])
    timebase = _rational(document.get("timelineTimebase", {"num": profile["fps"]["den"], "den": profile["fps"]["num"]}), "timelineTimebase")
    ticks = 1 / (fps * as_fraction(timebase))
    if ticks.denominator != 1:
        _fail("timelineTimebase 必须能用整数刻度表示每个输出帧（例如 fps 24 对应 1/24 或 1/12288）。")
    clips_in = document["clips"]
    if not isinstance(clips_in, list) or not 1 <= len(clips_in) <= MAX_CLIPS:
        _fail(f"clips 必须是 1–{MAX_CLIPS} 个镜头的数组。")
    clips, seen = [], set()
    for index, clip in enumerate(clips_in):
        path = f"clips[{index}]"
        _keys(clip, ("id", "inputSlot", "sourceInPts", "sourceOutPts", "timebase", "reverse", "pad", "muted", "gain"), path, ("id", "inputSlot", "sourceInPts", "sourceOutPts"))
        if not isinstance(clip["id"], str) or not CLIP_ID.fullmatch(clip["id"]) or clip["id"] in seen:
            _fail(f"{path}.id 必须是唯一的 1–64 位字母数字标识。")
        seen.add(clip["id"])
        item = {"id": clip["id"], "inputSlot": _slot(clip["inputSlot"], f"{path}.inputSlot", VIDEO_SLOTS)}
        item["sourceInPts"], item["sourceOutPts"] = _range(clip, path)
        if "timebase" in clip:
            item["timebase"] = _rational(clip["timebase"], f"{path}.timebase")
        item["reverse"] = _bool(clip.get("reverse", False), f"{path}.reverse")
        pad = clip.get("pad", {"mode": "none", "count": 0})
        _keys(pad, ("mode", "count"), f"{path}.pad", ("mode",))
        if pad["mode"] not in ("none", "last_frame"):
            _fail(f"{path}.pad.mode 必须是 none 或 last_frame。")
        count = _int(pad.get("count", 0), f"{path}.pad.count", 0, MAX_PAD)
        if pad["mode"] == "none" and count:
            _fail(f"{path}.pad.mode=none 时 count 必须为 0。")
        item["pad"] = {"mode": pad["mode"], "count": count}
        item["muted"] = _bool(clip.get("muted", False), f"{path}.muted")
        gain = clip.get("gain", 1)
        if type(gain) not in (int, float) or not math.isfinite(gain) or not 0 <= gain <= 1:
            _fail(f"{path}.gain 必须是 0–1 的线性音量（1 为原音量）。")
        item["gain"] = gain
        clips.append(item)
    return {"schemaVersion": SCHEMA_VERSION, "timelineTimebase": timebase, "outputProfile": profile, "clips": clips}


def used_slots(document):
    slots = {clip["inputSlot"] for clip in document["clips"]}
    if document["outputProfile"]["audio"] == "external":
        slots.add(document["outputProfile"]["audioFrom"]["inputSlot"])
    return sorted(slots, key=INPUT_SLOTS.index)


# ---------------------------------------------------------------- planning

def _time(pts, timebase):
    return pts * timebase


def nearest_frame(frame_times, target):
    """Index of the source frame nearest to ``target`` (ties choose the earlier frame)."""
    low, high = 0, len(frame_times)
    while low < high:
        middle = (low + high) // 2
        if frame_times[middle] < target:
            low = middle + 1
        else:
            high = middle
    if low == 0:
        return 0
    if low == len(frame_times):
        return len(frame_times) - 1
    return low if frame_times[low] - target < target - frame_times[low - 1] else low - 1


def _grid_range(start, end, fps):
    """Grid indices k with k/fps in [start, end)."""
    first = math.ceil(start * fps)
    last = math.ceil(end * fps)
    return first, last


def plan(document, probes):
    """Build an exact frame/sample plan.

    ``probes`` maps slot -> probe dict with ``frameTimes`` (list[Fraction] relative to
    the first frame), ``duration`` (Fraction), ``timebase`` (Fraction), ``width``,
    ``height`` and ``audioOffset`` (Fraction or None: audio start minus first video frame).
    """
    profile = document["outputProfile"]
    fps = as_fraction(profile["fps"])
    frame_duration = 1 / fps
    sizes = {(probes[clip["inputSlot"]]["width"], probes[clip["inputSlot"]]["height"]) for clip in document["clips"]}
    if "width" in profile:
        width, height = profile["width"], profile["height"]
    else:
        if len(sizes) != 1:
            _fail("各镜头的源分辨率不同，请在 outputProfile 中指定 width 和 height（将等比缩放并补黑边）。")
        width, height = next(iter(sizes))
        if width % 2 or height % 2:
            _fail("源分辨率不是偶数，请在 outputProfile 中指定偶数 width/height。")
    segments, total = [], 0
    for index, clip in enumerate(document["clips"]):
        probe = probes[clip["inputSlot"]]
        timebase = as_fraction(clip["timebase"]) if "timebase" in clip else probe["timebase"]
        start, end = _time(clip["sourceInPts"], timebase), _time(clip["sourceOutPts"], timebase)
        if end > probe["duration"]:
            _fail(f"clips[{index}] 的出点超出素材 {clip['inputSlot']} 的时长。")
        first, last = _grid_range(start, end, fps)
        if last <= first:
            _fail(f"clips[{index}] 区间短于一个输出帧。")
        grid_times = [Fraction(k) / fps for k in range(first, last)]
        frames = [nearest_frame(probe["frameTimes"], t) for t in grid_times]
        content_start = grid_times[0]
        if clip["reverse"]:
            frames.reverse()
        count = len(frames)
        padding = clip["pad"]["count"] if clip["pad"]["mode"] == "last_frame" else 0
        segments.append({
            "clip": clip, "index": index, "slot": clip["inputSlot"], "frames": frames,
            "contentFrames": count, "padFrames": padding, "timelineStart": total,
            "sourceStart": content_start, "sourceDuration": count * frame_duration,
        })
        total += count + padding
    if total > MAX_OUTPUT_FRAMES:
        _fail("成片过长，超过 E1 上限。")
    audio = profile["audio"]
    external = None
    if audio == "external":
        source = profile["audioFrom"]
        probe = probes[source["inputSlot"]]
        timebase = as_fraction(source["timebase"]) if "timebase" in source else probe.get("timebase") or Fraction(1, AUDIO_RATE)
        start, end = _time(source["sourceInPts"], timebase), _time(source["sourceOutPts"], timebase)
        if probe.get("audioOffset") is None:
            _fail(f"外挂原声的输入 {source['inputSlot']} 没有音频轨。")
        if end > probe.get("audioDuration", probe["duration"]):
            _fail("外挂原声区间超出素材时长。")
        if abs((end - start) - total * frame_duration) >= frame_duration:
            _fail(f"外挂原声区间时长 {float(end - start):.3f}s 与成片 {float(total * frame_duration):.3f}s 相差一帧以上。")
        external = {"slot": source["inputSlot"], "start": start}
    has_audio = audio == "external" or audio == "clips" and any(probes[s["slot"]].get("audioOffset") is not None for s in segments)
    return {"width": width, "height": height, "fps": fps, "totalFrames": total, "segments": segments,
            "audio": audio if has_audio else "none", "external": external,
            "sampleBoundary": lambda frame: round(Fraction(frame) * AUDIO_RATE / fps)}
