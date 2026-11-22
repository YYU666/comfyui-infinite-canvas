"""CPU-only delogo. A fixed filter interpolates only the selected rectangle.

H.264 export is lossy across the frame; it cannot promise byte-identical pixels
outside that rectangle. Audio packets are copied, never silently transcoded.
"""
from __future__ import annotations

import subprocess
import threading
from fractions import Fraction

from video_edit_ffmpeg import Cancelled, FFmpegError, probe
from video_repair_document import MAX_FRAMES, MAX_SECONDS, normalize_preview_request, plan_repair

MAX_OUTPUT_BYTES = 512 * 1024 ** 2
INPUT_GUARDS = ["-protocol_whitelist", "file,pipe", "-format_whitelist", "mov,matroska,webm", "-threads", "2"]


class _ProbeRunner:
    """Bound the shared decoder probe before collecting its frame CRC rows."""
    def __init__(self, runner):
        self.runner = runner

    def run(self, args, timeout=60):
        return self.runner.run(["-max_alloc", "268435456", *INPUT_GUARDS, *args[:-1],
                                "-t", str(MAX_SECONDS + 1), "-frames:v", str(MAX_FRAMES + 1), args[-1]], timeout=min(timeout, 60))


def bounded_probe(runner, source):
    return probe(_ProbeRunner(runner), source)


def build_filter(document, info, mode="repaired"):
    normalize_preview_request(0, mode)
    plan = plan_repair(document, info)
    r = plan["pixelRect"]
    # Full-resolution chroma keeps the exact rectangle boundary in all planes.
    filters = ["format=yuv444p"]
    if mode == "repaired":
        filters.append(f"delogo=x={r['x']}:y={r['y']}:w={r['width']}:h={r['height']}:"
                       f"enable='between(n,{plan['first']},{plan['last']})'")
    elif mode == "mask":
        filters.append(f"drawbox=x={r['x']}:y={r['y']}:w={r['width']}:h={r['height']}:color=red@0.5:t=fill")
    return ",".join(filters), plan


def render_preview(runner, document, source, time=0, mode="repaired"):
    request = normalize_preview_request(time, mode)
    info = bounded_probe(runner, source)
    graph, plan = build_filter(document, info, request["mode"])
    frame = min(info["frameCount"] - 1, int(Fraction(str(request["time"])) * plan["fps"]))
    graph += f",select=eq(n\\,{frame})"
    png = runner.run([*INPUT_GUARDS, "-i", str(source), "-map", "0:v:0", "-vf", graph,
                      "-filter_threads", "1", "-frames:v", "1", "-threads", "2", "-c:v", "png",
                      "-f", "image2pipe", "pipe:1"], timeout=30)
    if not png.startswith(b"\x89PNG\r\n\x1a\n"):
        raise FFmpegError("预览帧未生成。")
    return {"png": png, "width": info["width"], "height": info["height"], "frame": frame,
            "time": float(frame / plan["fps"]), "mode": mode, "pixelRect": plan["pixelRect"],
            "active": plan["first"] <= frame <= plan["last"]}


def render_export(runner, document, source, target, progress=lambda value, stage: None):
    progress(.02, "正在检查视频")
    info = bounded_probe(runner, source)
    graph, plan = build_filter(document, info)
    args = [*INPUT_GUARDS, "-copyts", "-start_at_zero", "-i", str(source),
            "-map", "0:v:0", "-map", "0:a?", "-vf", graph, "-filter_threads", "1",
            "-c:v", "libx264", "-preset", "fast", "-crf", "14", "-pix_fmt", "yuv420p", "-threads", "2",
            "-fps_mode", "passthrough", "-enc_time_base", str(info["timebase"]),
            "-video_track_timescale", str(info["timebase"].denominator), "-c:a", "copy",
            "-movflags", "+faststart", "-fs", str(MAX_OUTPUT_BYTES), "-progress", "pipe:1", "-nostats", "-y", str(target)]
    process = runner.popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    errors = []
    reader = threading.Thread(target=lambda: errors.append(process.stderr.read()), daemon=True)
    reader.start()
    timed_out = threading.Event()
    def expire():
        timed_out.set()
        runner.cancel()
    timeout = threading.Timer(180, expire)
    timeout.start()
    try:
        for line in process.stdout:
            runner.check()
            if line.startswith(b"frame="):
                progress(.1 + .8 * min(int(line[6:].strip()) / info["frameCount"], 1), "正在局部空间修复")
        process.wait()
        runner.check()
        reader.join(5)
        if process.returncode:
            raise FFmpegError("局部修复失败（原声音频须兼容 MP4）：" + b"".join(errors).decode("utf-8", "replace")[-400:])
    except Cancelled:
        if timed_out.is_set():
            raise FFmpegError("局部修复编码超过 180 秒，已停止。")
        raise
    finally:
        timeout.cancel()
        if process.poll() is None:
            process.kill()
            process.wait()
        reader.join(5)
        process.stdout.close()
        process.stderr.close()
        runner.release(process)
    progress(.94, "正在核对帧数和时间")
    output = bounded_probe(runner, target)
    if any(output[k] != info[k] for k in ("width", "height", "frameCount", "frameTimebase", "frameTimes", "audioOffset", "audioDuration")):
        raise FFmpegError("输出尺寸、帧数、帧时间或原声时长不一致，未交付。")
    if info["audioOffset"] is not None:
        def audio_hash(path):
            return runner.run([*INPUT_GUARDS, "-i", str(path), "-map", "0:a", "-c:a", "copy",
                               "-f", "streamhash", "-"], timeout=30)
        if audio_hash(source) != audio_hash(target):
            raise FFmpegError("原声音频包校验失败，未交付。")
    return {"width": info["width"], "height": info["height"], "frames": info["frameCount"],
            "fps": {"num": plan["fps"].numerator, "den": plan["fps"].denominator},
            "duration": float(info["duration"]), "audio": "preserve", "pixelRect": plan["pixelRect"],
            "method": "spatial-delogo", "warning": "空间插值可能模糊衣物和纹理；H.264 重编码会影响选区外像素。"}
