"""Synthetic media for video edit tests: every frame encodes its index in luma blocks
(plus burned frame number/timecode text when drawtext is available) and the audio
carries a 1 kHz marker during every frame whose index is a multiple of 10."""
from __future__ import annotations

import subprocess
from fractions import Fraction
from pathlib import Path

import numpy as np

from video_edit_ffmpeg import find_ffmpeg

BITS, BLOCK = 12, 8
MARK_EVERY = 10


def _frame(index, width, height):
    y = np.full((height, width), 60, dtype=np.uint8)
    y[height // 2:, :] = 90 + (index * 7) % 100  # visible motion band
    for bit in range(BITS):
        y[0:BLOCK, bit * BLOCK:(bit + 1) * BLOCK] = 235 if index >> bit & 1 else 16
    uv = np.full((height // 2, width // 2), 128, dtype=np.uint8)
    return y.tobytes() + uv.tobytes() + uv.tobytes()


def make_video(path, frames, fps=Fraction(24), width=128, height=72, audio=True, sample_rate=48000, gop=12, text=True, vfr=False):
    ffmpeg = find_ffmpeg()
    path = Path(path)
    audio_file = path.with_suffix(".src.f32")
    if audio:
        total = round(Fraction(frames) / fps * sample_rate)
        t = np.arange(total, dtype=np.float64) / sample_rate
        tone = (0.5 * np.sin(2 * np.pi * 1000 * t)).astype(np.float32)
        marker = np.zeros(total, dtype=np.float32)
        for index in range(0, frames, MARK_EVERY):
            start = round(Fraction(index) / fps * sample_rate)
            end = round(Fraction(index + 1) / fps * sample_rate)
            marker[start:end] = tone[start:end]
        marker.tofile(audio_file)
    def command(with_text):
        args = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "yuv420p", "-s", f"{width}x{height}",
                "-framerate", f"{fps.numerator}/{fps.denominator}", "-i", "pipe:0"]
        if audio:
            args += ["-f", "f32le", "-ar", str(sample_rate), "-ac", "1", "-i", str(audio_file)]
        filters = ["drawtext=text='%{frame_num} %{pts\\:hms}':x=4:y=12:fontsize=12:fontcolor=white"] if with_text else []
        if vfr:  # irregular spacing: frames after 30 are delayed by half a frame, after 60 squeezed
            filters.append("settb=1/96000,setpts='(N+if(gte(N\\,30)\\,0.5\\,0)-if(gte(N\\,60)\\,0.25*(N-60)\\,0))/(24*TB)'")
            args += ["-fps_mode", "passthrough", "-enc_time_base", "filter", "-video_track_timescale", "96000"]
        if filters:
            args += ["-vf", ",".join(filters)]
        args += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "10", "-g", str(gop), "-bf", "2", "-pix_fmt", "yuv420p"]
        if audio:
            args += ["-c:a", "aac", "-b:a", "128k"]
        return args + [str(path)]
    payload = b"".join(_frame(index, width, height) for index in range(frames))
    for with_text in ((True, False) if text else (False,)):
        result = subprocess.run(command(with_text), input=payload, capture_output=True)
        if result.returncode == 0:
            break
    else:
        raise RuntimeError(result.stderr.decode("utf-8", "replace")[-400:])
    audio_file.unlink(missing_ok=True)
    return path


def read_indices(path):
    """Decode a video and return the frame index encoded in every frame (or -1 if unreadable)."""
    ffmpeg = find_ffmpeg()
    info = subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-i", str(path), "-map", "0:v:0", "-fps_mode", "passthrough",
                           "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"], capture_output=True, check=True).stdout
    width, height = dimensions(path)
    frames = np.frombuffer(info, dtype=np.uint8).reshape(-1, height, width)
    indices = []
    for frame in frames:
        value = 0
        for bit in range(BITS):
            if frame[2:BLOCK - 2, bit * BLOCK + 2:(bit + 1) * BLOCK - 2].mean() > 128:
                value |= 1 << bit
        indices.append(value)
    return indices


def dimensions(path):
    out = subprocess.run([find_ffmpeg(), "-hide_banner", "-i", str(path), "-map", "0:v:0", "-frames:v", "1", "-c:v", "wrapped_avframe", "-f", "framecrc", "-"],
                         capture_output=True, check=True).stdout.decode()
    line = next(item for item in out.splitlines() if item.startswith("#dimensions 0:"))
    width, height = line.split(":")[1].strip().split("x")
    return int(width), int(height)


def audio_marks(path, fps, frames):
    """Per output frame: True when the 1 kHz marker is present (RMS over that frame window)."""
    out = subprocess.run([find_ffmpeg(), "-hide_banner", "-loglevel", "error", "-i", str(path), "-map", "0:a:0", "-ac", "1", "-ar", "48000", "-f", "f32le", "pipe:1"],
                         capture_output=True, check=True).stdout
    data = np.frombuffer(out, dtype=np.float32)
    marks = []
    for index in range(frames):
        start = round(Fraction(index) / fps * 48000)
        end = round(Fraction(index + 1) / fps * 48000)
        window = data[start:end]
        marks.append(bool(len(window)) and float(np.sqrt(np.mean(window.astype(np.float64) ** 2))) > 0.12)
    return marks, len(data)


def has_audio(path):
    result = subprocess.run([find_ffmpeg(), "-hide_banner", "-i", str(path), "-map", "0:a:0", "-f", "null", "-"], capture_output=True)
    return result.returncode == 0
