"""FFmpeg chromakey + despill + overlay for the green-screen node.

Argument arrays only (never a shell). The filter graph is assembled from
validated numbers and a #RRGGBB color. It runs in the workbench process.
"""
from __future__ import annotations

import math
import re
from fractions import Fraction

from video_chroma_document import plan_placement
from video_edit_ffmpeg import FFmpegError, probe

_GRAPH_SAFE = re.compile(r"^[0-9A-Za-z\[\]=:.,_+\-/\\'(); ]+$")
_UNIT = re.compile(r"\d+\.\d{3}")
_PIXEL = re.compile(r"-?\d+")
_FPS = re.compile(r"\d+/\d+")
_SECONDS = re.compile(r"\d+\.\d{3}")
_COLOR = re.compile(r"0x[0-9A-F]{6}")


def _px(value):
    if type(value) is not int:
        raise FFmpegError("像素参数无效。")
    text = str(value)
    if not _PIXEL.fullmatch(text):
        raise FFmpegError("像素参数无效。")
    return text


def _unit(value):
    text = f"{float(value):.3f}"
    if not _UNIT.fullmatch(text) or abs(float(text) - float(value)) > 1e-9:
        raise FFmpegError("抠像参数无效。")
    return text


def _fps(value):
    if not isinstance(value, Fraction) or value.numerator <= 0 or value.denominator <= 0:
        raise FFmpegError("帧率无效。")
    text = f"{value.numerator}/{value.denominator}"
    if not _FPS.fullmatch(text):
        raise FFmpegError("帧率无效。")
    return text


def _seconds(value):
    """Round a non-negative duration up to the next millisecond."""
    if not isinstance(value, Fraction) or value < 0:
        raise FFmpegError("时长参数无效。")
    milliseconds = int(math.ceil(float(value) * 1000 - 1e-9))
    text = f"{milliseconds / 1000:.3f}"
    if not _SECONDS.fullmatch(text):
        raise FFmpegError("时长参数无效。")
    return text


def _color(key_color):
    if not isinstance(key_color, str) or not re.fullmatch(r"#[0-9A-F]{6}", key_color):
        raise FFmpegError("键色无效。")
    text = "0x" + key_color[1:]
    if not _COLOR.fullmatch(text):
        raise FFmpegError("键色无效。")
    return text


def _require_safe(graph):
    if not isinstance(graph, str) or not _GRAPH_SAFE.fullmatch(graph):
        raise FFmpegError("滤镜图含未允许的字符，已拒绝执行。")
    return graph


def foreground_fps(info):
    step = info.get("frameTimebase")
    if step is None or step <= 0:
        raise FFmpegError("绿幕扣像目前只接受恒定帧率的前景视频。")
    return 1 / step


def frame_index(time_seconds, fps, frame_count):
    """min(N-1, floor(t * fps)) with t on the 0.001 second grid."""
    if frame_count < 1:
        raise FFmpegError("前景没有可预览的帧。")
    milli = int(round(float(time_seconds) * 1000))
    index = int(Fraction(milli, 1000) * fps)
    if index >= frame_count:
        index = frame_count - 1
    if index < 0:
        index = 0
    return index


def _fit(mode, width, height):
    w, h = _px(width), _px(height)
    if mode == "cover":
        return f"scale={w}:{h}:force_original_aspect_ratio=increase:flags=bicubic,crop={w}:{h}"
    if mode == "contain":
        return f"scale={w}:{h}:force_original_aspect_ratio=decrease:flags=bicubic,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color=black"
    if mode == "stretch":
        return f"scale={w}:{h}:flags=bicubic"
    raise FFmpegError("背景适配方式无效。")


def _hold_then_lock(fps, frames, extra=Fraction(0)):
    """Clone the last frame, resample, then cut to an exact frame count.

    fps runs after tpad. On FFmpeg 7.1 the other order duplicates a timestamp
    where the hold starts and that frame never reaches the output. The extra
    two frames cover a one-frame shortfall: 175 frames at 17500/729 last 7.290s,
    a millisecond under 175/24, and a duration trim (or passthrough mux) writes 174.
    """
    if extra < 0:
        extra = Fraction(0)
    hold = extra + Fraction(2, fps)
    return (
        f"tpad=stop_mode=clone:stop_duration={_seconds(hold)},fps={_fps(fps)}:round=near,"
        f"trim=end_frame={_px(frames)},setpts=PTS-STARTPTS"
    )


def _background_chain(document, background, placement, fps):
    """Loop a still in the input args. A video is locked to the foreground frame count."""
    parts = []
    frames = int(placement["frames"])
    duration = Fraction(frames, fps)
    if not background["isImage"]:
        start = Fraction(int(round(float(document["startOffset"]) * 1000)), 1000)
        if start > 0 and start >= background["duration"]:
            last = background["frameCount"] - 1
            parts.append(f"trim=start_frame={_px(last)}:end_frame={_px(last + 1)},setpts=PTS-STARTPTS")
            remaining = Fraction(0)
        else:
            if start > 0:
                parts.append(f"trim=start={_seconds(start)},setpts=PTS-STARTPTS")
            remaining = background["duration"] - start
            if remaining < 0:
                remaining = Fraction(0)
        deficit = duration - remaining if remaining < duration else Fraction(0)
    else:
        deficit = None
    parts.append(_fit(document["backgroundFit"], placement["outputWidth"], placement["outputHeight"]))
    if deficit is not None:
        parts.append(_hold_then_lock(fps, frames, deficit))
    parts.append("setsar=1,format=rgba,setpts=PTS-STARTPTS")
    return "[1:v]" + ",".join(parts) + "[bg]", _seconds(deficit) if deficit else None


def _primary_key(document):
    spill = "blue" if document.get("spill") == "blue" else "green"
    return (
        f"chromakey=color={_color(document['keyColor'])}:similarity={_unit(document['similarity'])}:"
        f"blend={_unit(document['blend'])}:yuv=0,despill=type={spill}:mix={_unit(document['despill'])}:expand=0.0"
    )


def _alpha_shape(document):
    choke, feather = document["choke"], document["feather"]
    if not choke and not feather:
        return ""
    alpha = ["alphaextract"]
    alpha.extend(["erosion"] * int(choke))
    if feather:
        alpha.append(f"boxblur={_px(int(feather))}:1")
    return ",".join(alpha)


def _foreground_chain(document, placement, mode):
    width, height = _px(placement["foregroundWidth"]), _px(placement["foregroundHeight"])
    scale = f"scale={width}:{height}:flags=bicubic,format=rgba,setpts=PTS-STARTPTS[fg]"
    if mode == "foreground":
        return f"[0:v]format=rgba,{scale}"
    head = _primary_key(document)
    shape = _alpha_shape(document)
    if document.get("secondKey"):
        second = (
            f"chromakey=color={_color(document['secondKeyColor'])}:similarity={_unit(document['secondSimilarity'])}:"
            f"blend={_unit(document['secondBlend'])}:yuv=0"
        )
        # Multiply the two alphas: a pixel matching either key becomes transparent.
        keyed = (
            f"[0:v]format=rgba,split[src][wsrc];"
            f"[src]format=rgba,{head},format=rgba[keyed];"
            f"[wsrc]{second},format=rgba,alphaextract,format=gray[wA];"
            f"[keyed]split[k0][k1];"
            f"[k1]format=rgba,alphaextract,format=gray[gA];"
            f"[gA][wA]blend=all_mode=multiply,format=gray[cA];"
            f"[k0][cA]alphamerge,format=rgba"
        )
        if not shape:
            return f"{keyed},{scale}"
        return (
            f"{keyed},split[ck0][ck1];"
            f"[ck1]format=rgba,{shape}[ckA];"
            f"[ck0][ckA]alphamerge,{scale}"
        )
    if not shape:
        return f"[0:v]format=rgba,{head},{scale}"
    return (
        f"[0:v]format=rgba,{head},format=rgba,split[ck0][ck1];"
        f"[ck1]{shape}[ckA];"
        f"[ck0][ckA]alphamerge,{scale}"
    )


def _checker(placement, fps):
    width, height = _px(placement["outputWidth"]), _px(placement["outputHeight"])
    # Fixed expression: 16px checker, no user text. Commas are escaped for the filtergraph.
    return (
        f"color=c=black:s={width}x{height},fps={_fps(fps)},format=yuv444p,"
        f"geq=lum='if(eq(mod(floor(X/16)+floor(Y/16)\\,2)\\,0)\\,200\\,48)':cb=128:cr=128,format=rgba[bg]"
    )


def build_graph(document, foreground, background, mode="export"):
    """Return a safe filtergraph. ``foreground`` / ``background`` are probe dicts."""
    if mode not in ("export", "composite", "matte", "foreground"):
        raise FFmpegError("预览模式无效。")
    fps = foreground["fps"]
    placement = plan_placement(document, foreground["width"], foreground["height"], background["width"], background["height"])
    placement = {**placement, "frames": foreground["frameCount"]}
    chains = [_foreground_chain(document, placement, mode)]
    if mode in ("matte", "foreground"):
        if mode == "matte":
            chains.append(_checker(placement, fps))
        else:
            chains.append(
                f"color=c=black:s={_px(placement['outputWidth'])}x{_px(placement['outputHeight'])},fps={_fps(fps)},format=rgba[bg]"
            )
    else:
        chain, _pad = _background_chain(document, background, placement, fps)
        chains.append(chain)
    x, y = _px(placement["overlayX"]), _px(placement["overlayY"])
    # The background chain already holds and cuts to the foreground frame count.
    # A second fps/tpad on the overlay output drops one frame: the hold's cloned
    # timestamp does not survive that resample.
    chains.append(
        f"[bg][fg]overlay=x={x}:y={y}:format=rgb:eof_action=repeat:shortest=1,format=yuv420p,setsar=1[vout]"
    )
    return _require_safe(";".join(chains)), placement


def inspect_foreground(runner, path):
    info = probe(runner, path)
    if info["width"] % 2 or info["height"] % 2:
        # Flooring happens at placement; the source itself may be odd and is scaled later.
        pass
    fps = foreground_fps(info)
    if info["frameCount"] < 1 or info["frameCount"] > 20000:
        raise FFmpegError("前景帧数必须在 1–20000 之间。")
    return {
        "width": info["width"], "height": info["height"], "frameCount": info["frameCount"],
        "fps": fps, "duration": info["duration"], "isImage": False,
        "hasAudio": info.get("audioOffset") is not None,
    }


def inspect_background(runner, path, is_image):
    if is_image:
        out = runner.run(["-i", str(path), "-map", "0:v:0", "-frames:v", "1", "-c:v", "wrapped_avframe", "-f", "framecrc", "-"])
        from video_edit_ffmpeg import _parse_framecrc
        streams, _rows = _parse_framecrc(out.decode("utf-8", "replace"))
        video = next((index for index, item in streams.items() if item.get("media_type") == "video"), None)
        if video is None or "dimensions" not in streams[video]:
            raise FFmpegError("背景图片无法读取。")
        width, height = (int(value) for value in streams[video]["dimensions"].split("x"))
        return {"width": width, "height": height, "isImage": True, "frameCount": 1, "duration": Fraction(0), "fps": None, "hasAudio": False}
    info = probe(runner, path)
    step = info.get("frameTimebase")
    fps = (1 / step) if step else None
    return {
        "width": info["width"], "height": info["height"], "isImage": False,
        "frameCount": info["frameCount"], "duration": info["duration"], "fps": fps, "hasAudio": False,
    }


def _inputs(foreground, background, fps, use_background):
    args = ["-i", str(foreground)]
    if use_background:
        if background["isImage"]:
            args += ["-loop", "1", "-framerate", _fps(fps), "-i", str(background["path"])]
        else:
            args += ["-i", str(background["path"])]
    return args


def render_export(runner, document, foreground_path, background_path, background_is_image, target, progress=lambda value, stage: None):
    progress(0.05, "正在探测素材")
    foreground = inspect_foreground(runner, foreground_path)
    background = inspect_background(runner, background_path, background_is_image)
    background = {**background, "path": background_path}
    graph, placement = build_graph(document, foreground, background, "export")
    audio = document["audio"] == "preserve" and foreground["hasAudio"]
    progress(0.2, "正在抠像合成")
    args = _inputs(foreground_path, background, foreground["fps"], True)
    args += ["-filter_complex", graph, "-map", "[vout]"]
    if audio:
        args += ["-map", "0:a:0"]
    args += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p",
             "-r", _fps(foreground["fps"]), "-fps_mode", "cfr", "-frames:v", _px(placement["frames"])]
    if audio:
        args += ["-c:a", "aac", "-b:a", "192k"]
    args += ["-movflags", "+faststart", "-y", str(target)]
    runner.run(args)
    progress(0.95, "正在校验")
    return {
        "frames": placement["frames"],
        "width": placement["outputWidth"],
        "height": placement["outputHeight"],
        "fps": {"num": foreground["fps"].numerator, "den": foreground["fps"].denominator},
        "audio": "preserve" if audio else "mute",
        "outputSize": document["outputSize"],
        "overlay": {
            "x": placement["overlayX"], "y": placement["overlayY"],
            "width": placement["foregroundWidth"], "height": placement["foregroundHeight"],
        },
        "keyColor": document["keyColor"],
        "foreground": {"width": foreground["width"], "height": foreground["height"], "frames": foreground["frameCount"]},
        "background": {"width": background["width"], "height": background["height"], "kind": "image" if background_is_image else "video"},
    }


def render_preview(runner, document, foreground_path, background_path, background_is_image, time_seconds, mode):
    foreground = inspect_foreground(runner, foreground_path)
    background = inspect_background(runner, background_path, background_is_image)
    background = {**background, "path": background_path}
    graph, placement = build_graph(document, foreground, background, mode)
    index = frame_index(time_seconds, foreground["fps"], placement["frames"])
    graph = _require_safe(graph + f";[vout]trim=start_frame={_px(index)}:end_frame={_px(index + 1)},setpts=PTS-STARTPTS,format=rgb24[frame]")
    use_background = mode == "composite"
    args = _inputs(foreground_path, background, foreground["fps"], use_background)
    args += ["-filter_complex", graph, "-map", "[frame]", "-frames:v", "1", "-f", "image2pipe", "-c:v", "png", "-"]
    png = runner.run(args, timeout=120)
    if not png.startswith(b"\x89PNG\r\n\x1a\n"):
        raise FFmpegError("预览不是 PNG。")
    if len(png) > 6_000_000:
        raise FFmpegError("预览图过大。")
    return {
        "png": png,
        "width": placement["outputWidth"],
        "height": placement["outputHeight"],
        "frame": index,
        "time": time_seconds,
        "mode": mode,
    }
