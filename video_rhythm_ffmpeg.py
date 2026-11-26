"""FFmpeg renderer for constant-speed and curve time-remap.

Argument arrays only (never a shell). Filter text is built here from validated
fractions, never from user strings. Runs in the workbench process.
"""
from __future__ import annotations

from fractions import Fraction
from pathlib import Path

import numpy as np

from video_edit_ffmpeg import AUDIO_CHANNELS, AUDIO_RATE, FFmpegError, _segment_frames
from video_rhythm_document import (
    remap_frame_indices,
    source_fps,
    speed_frame_indices,
    speed_rate,
)


def atempo_filter(rate):
    """Pitch-preserving chain. Each stage stays inside FFmpeg's 0.5–2 window."""
    if not isinstance(rate, Fraction) or rate <= 0:
        raise ValueError("atempo rate must be a positive fraction")
    factors = []
    value = rate
    while value > 2:
        factors.append(Fraction(2))
        value /= 2
    while value < Fraction(1, 2):
        factors.append(Fraction(1, 2))
        value *= 2
    factors.append(value)
    parts = []
    for factor in factors:
        text = f"{float(factor):.6f}".rstrip("0").rstrip(".")
        if "." not in text:
            text += ".0"
        if not all(character.isdigit() or character == "." for character in text):
            raise ValueError("atempo factor is not a plain decimal")
        parts.append(f"atempo={text}")
    return ",".join(parts)


def _indexed_frames(runner, path, indices, width, height, workdir):
    frame_bytes = width * height * 3 // 2
    segment = {"frames": list(indices), "index": 0}
    yield from _segment_frames(runner, path, segment, width, height, frame_bytes, workdir)


def _write_audio(runner, source, document, indices, fps, probe, workdir):
    if probe.get("audioOffset") is None:
        return None
    mode = document["audio"] if document["operation"] == "speed" else "mute"
    if mode == "mute":
        return None
    target = Path(workdir) / "rhythm-audio.f32"
    output_frames = len(indices)
    if mode == "preserve":
        runner.run(["-i", str(source), "-map", "0:a:0", "-vn", "-af", atempo_filter(speed_rate(document)),
                    "-ac", str(AUDIO_CHANNELS), "-ar", str(AUDIO_RATE), "-f", "f32le", str(target)])
        return target
    raw = Path(workdir) / "rhythm-source.f32"
    runner.run(["-i", str(source), "-map", "0:a:0", "-vn", "-ac", str(AUDIO_CHANNELS), "-ar", str(AUDIO_RATE), "-f", "f32le", str(raw)])
    data = np.fromfile(raw, dtype=np.float32).reshape(-1, AUDIO_CHANNELS)
    out_count = int(round(Fraction(output_frames) / fps * AUDIO_RATE))
    rate = float(speed_rate(document))
    stretched = np.zeros((out_count, AUDIO_CHANNELS), dtype=np.float32)
    if len(data):
        positions = np.minimum(np.arange(out_count, dtype=np.float64) * rate, len(data) - 1)
        left = np.floor(positions).astype(np.int64)
        right = np.minimum(left + 1, len(data) - 1)
        weight = (positions - left).astype(np.float32)[:, None]
        stretched[:] = data[left] * (1 - weight) + data[right] * weight
    stretched.tofile(target)
    return target


def render(runner, document, probe, source, target, workdir, progress=lambda value, stage, preview=None: None):
    import hashlib
    import json

    from video_frame_export import FrameExporter, mux_mp4

    width, height = probe["width"], probe["height"]
    if width % 2 or height % 2 or width < 16 or height < 16:
        raise FFmpegError("素材宽高必须是不小于 16 的偶数。")
    fps = source_fps(probe)
    if document["operation"] == "speed":
        indices = speed_frame_indices(probe["frameCount"], speed_rate(document))
        audio_mode = document["audio"] if probe.get("audioOffset") is not None else "mute"
    else:
        indices = remap_frame_indices(probe, document["keyframes"])
        audio_mode = "mute"
    progress(0.05, "正在装配声音" if audio_mode != "mute" else "正在准备画面")
    audio_file = _write_audio(runner, source, document, indices, fps, probe, workdir) if audio_mode != "mute" else None
    if audio_file is None:
        audio_mode = "mute"
    identity = hashlib.sha256(json.dumps({
        "document": document, "frames": indices, "width": width, "height": height,
        "fps": [fps.numerator, fps.denominator], "preset": "veryfast", "crf": 14, "audio": audio_mode,
    }, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()
    exporter = FrameExporter(runner, workdir, width=width, height=height, fps=fps, preset="veryfast",
                             crf=14, total=len(indices), identity=identity, progress=progress)
    if exporter.resume_from:
        progress(0.1 + 0.85 * exporter.resume_from / len(indices), f"从第 {exporter.resume_from} 帧继续导出")
    for chunk in _indexed_frames(runner, source, indices[exporter.resume_from:], width, height, workdir):
        exporter.write(chunk)
    video = exporter.finish()
    mux_mp4(runner, video, audio_file, target, timescale=fps.numerator, audio_rate=AUDIO_RATE, audio_channels=AUDIO_CHANNELS)
    progress(0.98, "正在校验")
    return {
        "frames": len(indices),
        "width": width,
        "height": height,
        "fps": {"num": fps.numerator, "den": fps.denominator},
        "audio": audio_mode,
        "operation": document["operation"],
        "firstSourceFrame": indices[0],
        "lastSourceFrame": indices[-1],
        "resumedFrames": exporter.resume_from,
    }
