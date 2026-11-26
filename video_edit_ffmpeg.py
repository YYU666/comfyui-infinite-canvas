"""FFmpeg adapter for the video edit node (E1).

Only fixed argument arrays are executed (never a shell).  Callers pass resolved
project asset files; no user-controlled path, URL or filter text reaches FFmpeg.
Filter strings are assembled here from validated integers only.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import threading
from fractions import Fraction
from pathlib import Path

from video_edit_document import AUDIO_RATE, EditDocumentError, as_fraction

WINGET_FFMPEG = Path(os.environ.get("LOCALAPPDATA", "")) / "Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-8.0.1-full_build/bin/ffmpeg.exe"
AUDIO_CHANNELS = 2


class Cancelled(Exception):
    pass


class FFmpegError(RuntimeError):
    pass


def find_ffmpeg():
    try:
        import imageio_ffmpeg  # same binary the delivery export already uses
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        pass
    found = shutil.which("ffmpeg")
    if found:
        return found
    if WINGET_FFMPEG.is_file():
        return str(WINGET_FFMPEG)
    raise FFmpegError("找不到 FFmpeg。")


class Runner:
    """Tracks this job's child processes so cancel kills only them."""

    def __init__(self, ffmpeg=None):
        self.ffmpeg = ffmpeg or find_ffmpeg()
        self.cancelled = threading.Event()
        self.processes = set()
        self.lock = threading.Lock()

    def cancel(self):
        self.cancelled.set()
        with self.lock:
            for process in list(self.processes):
                try:
                    process.kill()
                except OSError:
                    pass

    def check(self):
        if self.cancelled.is_set():
            raise Cancelled()

    def popen(self, args, **kwargs):
        self.check()
        if not isinstance(args, list) or not all(isinstance(item, str) for item in args):
            raise TypeError("FFmpeg arguments must be a list of strings.")
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        process = subprocess.Popen([self.ffmpeg, "-hide_banner", "-nostdin", "-loglevel", "error", *args], shell=False, creationflags=flags, **kwargs)
        with self.lock:
            self.processes.add(process)
        return process

    def release(self, process):
        with self.lock:
            self.processes.discard(process)

    def run(self, args, timeout=3600):
        process = self.popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            out, err = process.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            process.kill()
            process.communicate()
            raise FFmpegError("FFmpeg 处理超时。")
        finally:
            self.release(process)
        self.check()
        if process.returncode != 0:
            raise FFmpegError("FFmpeg 失败：" + err.decode("utf-8", "replace")[-400:])
        return out


def _parse_framecrc(text):
    streams, rows = {}, {}
    for line in text.splitlines():
        if line.startswith("#"):
            key, _, value = line[1:].partition(":")
            parts = key.split()
            if len(parts) == 2 and parts[1].isdigit():
                streams.setdefault(int(parts[1]), {})[parts[0]] = value.strip()
            continue
        fields = [item.strip() for item in line.split(",")]
        if len(fields) >= 5 and fields[0].isdigit():
            rows.setdefault(int(fields[0]), []).append((int(fields[2]), int(fields[3]), int(fields[4])))
    return streams, rows


def _tb(value):
    num, _, den = value.partition("/")
    return Fraction(int(num), int(den))


def probe(runner, path):
    """Decode once and return exact frame times (relative to the first frame)."""
    out = runner.run(["-copyts", "-i", str(path), "-map", "0:v:0", "-map", "0:a:0?", "-fps_mode", "passthrough",
                      "-c:v", "wrapped_avframe", "-c:a", "pcm_s16le", "-ac", str(AUDIO_CHANNELS), "-f", "framecrc", "-"])
    streams, rows = _parse_framecrc(out.decode("utf-8", "replace"))
    video = next((index for index, info in streams.items() if info.get("media_type") == "video"), None)
    if video is None or not rows.get(video):
        raise EditDocumentError("素材没有可解码的视频帧。")
    vtb = _tb(streams[video]["tb"])
    width, height = (int(value) for value in streams[video]["dimensions"].split("x"))
    pts = sorted(row[0] for row in rows[video])
    first = pts[0] * vtb
    times = [value * vtb - first for value in pts]
    deltas = {times[index + 1] - times[index] for index in range(len(times) - 1)}
    last_duration = rows[video][-1][1] * vtb if rows[video][-1][1] > 0 else (min(deltas) if deltas else Fraction(1, 24))
    duration = times[-1] + last_duration
    frame_timebase = next(iter(deltas)) if len(deltas) == 1 else (last_duration if not deltas else None)
    result = {"width": width, "height": height, "frameCount": len(times), "frameTimes": times, "duration": duration,
              "timebase": vtb, "frameTimebase": frame_timebase, "audioOffset": None, "audioDuration": None}
    audio = next((index for index, info in streams.items() if info.get("media_type") == "audio"), None)
    if audio is not None and rows.get(audio):
        atb = _tb(streams[audio]["tb"])
        rate = int(streams[audio].get("sample_rate", "0") or 0) or AUDIO_RATE
        start = min(row[0] for row in rows[audio]) * atb
        samples = sum(row[2] for row in rows[audio]) // (2 * AUDIO_CHANNELS)
        result["audioOffset"] = start - first
        result["audioDuration"] = result["audioOffset"] + Fraction(samples, rate)
    return result


def public_probe(info):
    """JSON-safe probe summary for the canvas / agents (all times as rationals)."""
    rational = lambda value: None if value is None else {"num": value.numerator, "den": value.denominator}
    frame_tb = info["frameTimebase"]
    return {
        "width": info["width"], "height": info["height"], "frameCount": info["frameCount"],
        "timebase": rational(info["timebase"]),
        "durationPts": int(info["duration"] / info["timebase"]) if (info["duration"] / info["timebase"]).denominator == 1 else None,
        "duration": rational(info["duration"]),
        "frameTimebase": rational(frame_tb), "constantFrameRate": frame_tb is not None,
        "fps": rational(1 / frame_tb) if frame_tb else None,
        "hasAudio": info["audioOffset"] is not None,
        "audioOffset": rational(info["audioOffset"]),
    }


def _video_filter(first, last, width, height):
    for value in (first, last, width, height):
        if type(value) is not int or value < 0:
            raise ValueError("filter values must be validated integers")
    return (f"select=between(n\\,{first}\\,{last}),scale={width}:{height}:force_original_aspect_ratio=decrease:flags=bicubic,"
            f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p")


def _frames(runner, path, first, last, width, height, frame_bytes):
    """Yield decoded output-sized frames first..last (inclusive) of the source."""
    process = runner.popen(["-i", str(path), "-map", "0:v:0", "-vf", _video_filter(first, last, width, height),
                            "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "yuv420p", "pipe:1"],
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    received = 0
    try:
        while True:
            runner.check()
            chunk = process.stdout.read(frame_bytes)
            if not chunk:
                break
            if len(chunk) != frame_bytes:
                raise FFmpegError("解码帧不完整。")
            received += 1
            yield chunk
        error = process.stderr.read()
        process.wait()
        runner.check()
        if process.returncode != 0:
            raise FFmpegError("FFmpeg 解码失败：" + error.decode("utf-8", "replace")[-400:])
        if received != last - first + 1:
            raise FFmpegError(f"解码帧数 {received} 与探测帧数 {last - first + 1} 不一致，已停止以避免错帧。")
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        process.stdout.close()
        process.stderr.close()
        runner.release(process)


def _segment_frames(runner, path, segment, width, height, frame_bytes, workdir):
    wanted = segment["frames"]
    first, last = min(wanted), max(wanted)
    if wanted == sorted(wanted):
        position, current = first - 1, None
        source = _frames(runner, path, first, last, width, height, frame_bytes)
        for index in wanted:
            while position < index:
                current = next(source)
                position += 1
            yield current
        for _ in source:  # drain so the decoder verifies the exact count
            pass
        return
    spool = Path(workdir) / f"segment-{segment['index']}.yuv"
    try:
        with spool.open("wb") as target:
            for chunk in _frames(runner, path, first, last, width, height, frame_bytes):
                target.write(chunk)
        with spool.open("rb") as stream:
            for index in wanted:
                runner.check()
                stream.seek((index - first) * frame_bytes)
                yield stream.read(frame_bytes)
    finally:
        spool.unlink(missing_ok=True)


def _decode_audio(runner, path, target):
    runner.run(["-i", str(path), "-map", "0:a:0", "-vn", "-ac", str(AUDIO_CHANNELS), "-ar", str(AUDIO_RATE), "-f", "f32le", str(target)])


def build_audio(runner, plan, files, probes, workdir):
    import numpy as np

    total = plan["sampleBoundary"](plan["totalFrames"])
    output = np.zeros((total, AUDIO_CHANNELS), dtype=np.float32)
    decoded = {}

    def source(slot):
        if slot not in decoded:
            target = Path(workdir) / f"audio-{slot}.f32"
            _decode_audio(runner, files[slot], target)
            decoded[slot] = np.fromfile(target, dtype=np.float32).reshape(-1, AUDIO_CHANNELS)
        return decoded[slot]

    def take(slot, start_time, length):
        samples = np.zeros((length, AUDIO_CHANNELS), dtype=np.float32)
        offset = probes[slot]["audioOffset"]
        if offset is None or length <= 0:
            return samples
        data = source(slot)
        begin = round((start_time - offset) * AUDIO_RATE)
        low, high = max(begin, 0), min(begin + length, len(data))
        if high > low:
            samples[low - begin:high - begin] = data[low:high]
        return samples

    if plan["audio"] == "external":
        output[:] = take(plan["external"]["slot"], plan["external"]["start"], total)
    else:
        for segment in plan["segments"]:
            runner.check()
            clip = segment["clip"]
            start = plan["sampleBoundary"](segment["timelineStart"])
            end = plan["sampleBoundary"](segment["timelineStart"] + segment["contentFrames"])
            if clip["muted"] or clip["gain"] == 0:
                continue
            piece = take(segment["slot"], segment["sourceStart"], end - start)
            if clip["reverse"]:
                piece = piece[::-1]
            output[start:end] = piece * np.float32(clip["gain"])
            # Pad frames stay silent by construction.
    target = Path(workdir) / "timeline-audio.f32"
    output.tofile(target)
    return target


def render(runner, document, plan, files, probes, target, workdir, progress=lambda value, stage: None):
    width, height, fps = plan["width"], plan["height"], plan["fps"]
    frame_bytes = width * height * 3 // 2
    audio_file = None
    if plan["audio"] != "none":
        progress(0.02, "正在装配原声")
        audio_file = build_audio(runner, plan, files, probes, workdir)
    timescale = as_fraction(document["timelineTimebase"]).denominator
    profile = document["outputProfile"]
    args = ["-f", "rawvideo", "-pix_fmt", "yuv420p", "-s", f"{width}x{height}", "-framerate", f"{fps.numerator}/{fps.denominator}", "-i", "pipe:0"]
    if audio_file:
        args += ["-f", "f32le", "-ar", str(AUDIO_RATE), "-ac", str(AUDIO_CHANNELS), "-i", str(audio_file)]
    args += ["-map", "0:v:0"] + (["-map", "1:a:0"] if audio_file else [])
    args += ["-c:v", "libx264", "-preset", "medium", "-crf", str(int(profile["crf"])), "-pix_fmt", "yuv420p",
             "-video_track_timescale", str(timescale), "-fps_mode", "passthrough"]
    if audio_file:
        args += ["-c:a", "aac", "-b:a", "192k"]
    args += ["-movflags", "+faststart", "-y", str(target)]
    encoder = runner.popen(args, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    written = 0
    stderr = []
    reader = threading.Thread(target=lambda: stderr.append(encoder.stderr.read()), daemon=True)
    reader.start()
    try:
        for segment in plan["segments"]:
            last = None
            for chunk in _segment_frames(runner, files[segment["slot"]], segment, width, height, frame_bytes, workdir):
                encoder.stdin.write(chunk)
                last = chunk
                written += 1
                if written % 12 == 0:
                    progress(0.05 + 0.9 * written / plan["totalFrames"], "正在逐帧导出")
            for _ in range(segment["padFrames"]):
                runner.check()
                encoder.stdin.write(last)
                written += 1
        encoder.stdin.close()
        encoder.wait()
        reader.join(5)
        runner.check()
        if encoder.returncode != 0:
            raise FFmpegError("FFmpeg 编码失败：" + b"".join(stderr).decode("utf-8", "replace")[-400:])
    except (BrokenPipeError, OSError) as error:
        runner.check()
        raise FFmpegError("FFmpeg 编码进程提前退出。") from error
    finally:
        if encoder.poll() is None:
            encoder.kill()
            encoder.wait()
        reader.join(5)
        encoder.stderr.close()
        runner.release(encoder)
    if written != plan["totalFrames"]:
        raise FFmpegError("写入帧数与计划不一致。")
    progress(0.98, "正在校验")
    return {"frames": written, "width": width, "height": height, "fps": {"num": fps.numerator, "den": fps.denominator},
            "durationPts": plan["totalFrames"] * int(1 / (fps * as_fraction(document["timelineTimebase"]))),
            "timelineTimebase": document["timelineTimebase"], "audio": plan["audio"]}
