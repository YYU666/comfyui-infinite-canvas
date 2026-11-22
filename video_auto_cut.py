"""Build a non-destructive edit suggestion for black or quiet intervals."""
from __future__ import annotations

import math
from fractions import Fraction

from video_edit_document import MAX_CLIPS, MAX_OUTPUT_FRAMES, EditDocumentError, normalize_document

MIN_GAP = Fraction(6, 5)
SILENCE_MARGIN = Fraction(1, 5)
MAX_SOURCE_SECONDS = 3600


def _intervals(output, tag, end):
    start = None
    for line in output.decode("utf-8", "replace").splitlines():
        key, separator, value = line.partition("=")
        if not separator:
            continue
        if key == f"lavfi.{tag}_start":
            start = Fraction(value)
        elif key == f"lavfi.{tag}_end" and start is not None:
            yield start, Fraction(value)
            start = None
    if start is not None:
        yield start, end


def _cut_ranges(intervals, frame_timebase, frame_count, margin):
    cuts = []
    for start, end in intervals:
        if end - start < MIN_GAP:
            continue
        if start <= 0 and end >= frame_count * frame_timebase:
            return [(0, frame_count)]
        first = max(0, math.ceil((start + margin) / frame_timebase))
        last = min(frame_count, math.floor((end - margin) / frame_timebase))
        if first < last:
            if cuts and first <= cuts[-1][1]:
                cuts[-1] = (cuts[-1][0], max(last, cuts[-1][1]))
            else:
                cuts.append((first, last))
    # Each interior removal adds a clip. Retain smaller gaps when the
    # timeline limit is reached, so no source content outside a cut is lost.
    interior = [(first, last) for first, last in cuts if first and last < frame_count]
    selected = set(sorted(interior, key=lambda cut: cut[1] - cut[0], reverse=True)[:MAX_CLIPS - 1])
    return [(first, last) for first, last in cuts
            if first == 0 or last == frame_count or (first, last) in selected]


def _keep_ranges(cuts, frame_count):
    keep, cursor = [], 0
    for first, last in cuts:
        if cursor < first:
            keep.append((cursor, first))
        cursor = last
    if cursor < frame_count:
        keep.append((cursor, frame_count))
    return keep


def suggest_cuts(runner, file, info, slot, mode):
    frame_count, timebase = info["frameCount"], info["frameTimebase"]
    if not frame_count or timebase is None or not 1 <= 1 / timebase <= 120:
        raise EditDocumentError("自动剪辑需要 1–120 fps 的恒定帧率视频。")
    if frame_count > MAX_OUTPUT_FRAMES or info["duration"] > MAX_SOURCE_SECONDS:
        raise EditDocumentError("自动剪辑支持最长 1 小时的视频。")
    if mode == "black":
        filter_args = ["-map", "0:v:0", "-an", "-vf",
                       "setpts=PTS-STARTPTS,scale=320:180:flags=area,"
                       "blackdetect=d=0:pix_th=0.10:pic_th=0.985,metadata=mode=print:file=-",
                       "-fps_mode", "passthrough"]
        offset, end, margin = Fraction(0), info["duration"], Fraction(0)
    else:
        offset = info["audioOffset"]
        if offset is None:
            raise EditDocumentError("此素材没有音轨，无法检测静音。")
        filter_args = ["-map", "0:a:0", "-vn", "-af",
                       "asetpts=PTS-STARTPTS,silencedetect=noise=-42dB:d=1.2,"
                       "ametadata=mode=print:file=-"]
        end, margin = info["audioDuration"] - offset, SILENCE_MARGIN

    output = runner.run(["-i", str(file), *filter_args, "-f", "null", "-"], timeout=600)
    intervals = ((start + offset, stop + offset) for start, stop in _intervals(output, mode, end))
    cuts = _cut_ranges(intervals, timebase, frame_count, margin)
    ranges = _keep_ranges(cuts, frame_count)
    if not ranges:
        raise EditDocumentError("整段素材都符合剪除条件，请改用其他模式或手动剪辑。")
    kept = sum(last - first for first, last in ranges)
    removed = frame_count - kept
    if not removed:
        return {"removedFrames": 0, "frameCount": frame_count, "cuts": [], "document": None}

    grid = {"num": timebase.numerator, "den": timebase.denominator}
    profile = {"fps": {"num": grid["den"], "den": grid["num"]}}
    if info["width"] % 2 or info["height"] % 2:
        profile.update(width=max(16, info["width"] + info["width"] % 2),
                       height=max(16, info["height"] + info["height"] % 2))
    document = normalize_document({
        "schemaVersion": 1, "timelineTimebase": grid, "outputProfile": profile,
        "clips": [{"id": f"auto{index}", "inputSlot": slot, "timebase": grid,
                   "sourceInPts": first, "sourceOutPts": last}
                  for index, (first, last) in enumerate(ranges, 1)],
    })
    return {"removedFrames": removed, "frameCount": frame_count, "cuts": cuts, "document": document}
