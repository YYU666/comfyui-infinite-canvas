"""Turn a video plus a mask into a green-screen white-model plate.

Argument arrays only (never a shell). The graph is built from validated
integers and one #RRGGBB colour. Outside the mask the colour is exact,
because the encode is RGB H.264 rather than yuv420. The mask is locked to
the source frame count the same way as the chroma node: clone, then fps,
then trim, then a CFR mux. A second fps/tpad on the merged picture is not
used; that path drops a frame.
"""
from __future__ import annotations

import math
import re
from fractions import Fraction

from video_edit_ffmpeg import FFmpegError, probe

_GRAPH_SAFE = re.compile(r"^[0-9A-Za-z\[\]=:.,_+\-/\\'(); *]+$")
_SECONDS = re.compile(r"\d+\.\d{3}")
_FPS = re.compile(r"\d+/\d+")


def _px(value):
    if type(value) is not int or isinstance(value, bool) or value < 0:
        raise FFmpegError("像素参数无效。")
    return str(value)


def _seconds(value):
    if not isinstance(value, Fraction) or value < 0:
        raise FFmpegError("时长参数无效。")
    milliseconds = int(math.ceil(float(value) * 1000 - 1e-9))
    text = f"{milliseconds / 1000:.3f}"
    if not _SECONDS.fullmatch(text):
        raise FFmpegError("时长参数无效。")
    return text


def _fps(value):
    if not isinstance(value, Fraction) or value.numerator <= 0 or value.denominator <= 0:
        raise FFmpegError("帧率无效。")
    text = f"{value.numerator}/{value.denominator}"
    if not _FPS.fullmatch(text):
        raise FFmpegError("帧率无效。")
    return text


def _require_safe(graph):
    if not _GRAPH_SAFE.fullmatch(graph):
        raise FFmpegError("滤镜图含有未允许的字符。")
    return graph


def _rate(info):
    step = info.get("frameTimebase")
    if step is None or step <= 0:
        raise FFmpegError("绿幕白模目前只接受恒定帧率的视频。")
    return 1 / step


def _rgb(color):
    return int(color[1:3], 16), int(color[3:5], 16), int(color[5:7], 16)


def _hold(fps, frames, missing):
    """Clone, resample, then cut. fps stays after tpad (FFmpeg 7.1)."""
    extra = Fraction(missing, 1) / fps if missing > 0 else Fraction(0)
    hold = extra + Fraction(2, fps)
    return (
        f"tpad=stop_mode=clone:stop_duration={_seconds(hold)},fps={_fps(fps)}:round=near,"
        f"trim=end_frame={_px(frames)},setpts=PTS-STARTPTS"
    )


def build_graph(document, info, mask_frames):
    frames = info["frameCount"]
    width, height = info["width"], info["height"]
    fps = info["fps"]
    red, green, blue = _rgb(document["greenColor"])
    if document["shadeMode"] == "shaded":
        white = "format=gray,geq=lum='clip(210+p(X\\,Y)*45/255\\,210\\,255)',format=rgb24"
    else:
        white = "geq=r=255:g=255:b=255"
    grow = document["maskGrow"]
    feather = document["maskFeather"]
    mask_steps = [
        f"format=gray,scale={_px(width)}:{_px(height)}:flags=neighbor,setsar=1",
        _hold(fps, frames, max(0, frames - mask_frames)),
    ]
    if grow:
        mask_steps.append(",".join(["dilation"] * grow))
    mask_steps.append("geq=lum='if(gte(p(X\\,Y)\\,128)\\,255\\,0)'")
    if feather:
        mask_steps.append(f"boxblur={_px(feather)}:1")
    graph = ";".join([
        f"[0:v]format=rgb24,setsar=1,trim=end_frame={_px(frames)},setpts=PTS-STARTPTS,split=2[src][base]",
        f"[base]geq=r={_px(red)}:g={_px(green)}:b={_px(blue)}[green]",
        f"[src]{white}[white]",
        f"[1:v]{','.join(mask_steps)}[mask]",
        "[green]format=gbrp[g];[white]format=gbrp[w];[mask]format=gray[m]",
        "[g][w][m]maskedmerge,format=rgb24,setsar=1[vout]",
    ])
    return _require_safe(graph)


def inspect_video(runner, path):
    info = probe(runner, path)
    if info["width"] % 2 or info["height"] % 2:
        raise FFmpegError("绿幕白模要求偶数宽高。")
    if info["frameCount"] < 1 or info["frameCount"] > 20000:
        raise FFmpegError("视频帧数必须在 1–20000 之间。")
    fps = _rate(info)
    return {
        "width": info["width"], "height": info["height"], "frameCount": info["frameCount"],
        "fps": fps, "duration": info["duration"], "hasAudio": info.get("audioOffset") is not None,
    }


def render_plate(runner, document, video_path, mask_path, target, progress=lambda value, stage: None):
    progress(0.72, "正在合成绿幕白模")
    info = inspect_video(runner, video_path)
    mask = probe(runner, mask_path)
    if mask["frameCount"] < 1:
        raise FFmpegError("SAM3 遮罩没有可解码的帧。")
    graph = build_graph(document, info, mask["frameCount"])
    args = ["-i", str(video_path), "-i", str(mask_path), "-filter_complex", graph, "-map", "[vout]"]
    audio = info["hasAudio"]
    if audio:
        args += ["-map", "0:a:0"]
    args += [
        "-c:v", "libx264rgb", "-pix_fmt", "rgb24", "-qp", "0", "-preset", "veryfast",
        "-r", _fps(info["fps"]), "-fps_mode", "cfr", "-frames:v", _px(info["frameCount"]),
    ]
    if audio:
        args += ["-c:a", "aac", "-b:a", "160k"]
    args += ["-movflags", "+faststart", "-y", str(target)]
    runner.run(args)
    progress(0.94, "正在校验成片")
    return {
        "frames": info["frameCount"],
        "width": info["width"],
        "height": info["height"],
        "fps": {"num": info["fps"].numerator, "den": info["fps"].denominator},
        "audio": "preserve" if audio else "mute",
        "shadeMode": document["shadeMode"],
        "greenColor": document["greenColor"],
        "keepPrompts": list(document["keepPrompts"]),
    }
