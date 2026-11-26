"""Durable frame chunks and a live JPEG for CPU video exports.

Each closed MPEG-TS chunk survives a killed workbench process. The next
process encodes only the missing tail, then copies the chunks into the
usual MP4. A graceful cancel deletes the chunks and does not resume.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import threading
import time
from pathlib import Path

import numpy as np
from PIL import Image

from video_edit_ffmpeg import FFmpegError

CHUNK_FRAMES = 24
PREVIEW_EDGE = 480
_RECORD_LIMIT = 512_000


def atomic_json(path, value):
    path = Path(path)
    payload = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(payload) > _RECORD_LIMIT:
        raise FFmpegError("导出记录超过允许的大小。")
    temporary = path.with_name(path.name + ".tmp")
    with temporary.open("wb") as stream:
        stream.write(payload)
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)


def write_job_record(directory, record):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    atomic_json(directory / "job.json", record)


def read_job_record(directory):
    path = Path(directory) / "job.json"
    try:
        if not path.is_file() or path.stat().st_size > _RECORD_LIMIT:
            return None
        record = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(record, dict) or record.get("version") != 1 or not isinstance(record.get("submission"), dict):
        return None
    if record.get("status") not in {"running", "completed", "cancelled", "failed"}:
        return None
    return record


def load_export_record(directory, job_pattern):
    """Return a running or completed export, or None when the directory cannot resume."""
    directory = Path(directory)
    record = read_job_record(directory)
    if record is None or record.get("id") != directory.name or not job_pattern.fullmatch(directory.name):
        return None
    if record["status"] == "completed" and (directory / "output.mp4").is_file():
        return record
    if record["status"] == "running" and (directory / "output.mp4").is_file():
        return {**record, "status": "completed"}
    if record["status"] == "running":
        return record
    return None


def cleanup_workdir(workdir, status):
    """Keep a crashed export. Drop everything else except a finished MP4 and its record."""
    workdir = Path(workdir)
    if not workdir.is_dir():
        return
    if status == "running":
        for leftover in list(workdir.iterdir()):
            if leftover.name in {"job.json", "checkpoint.json", "preview.jpg"}:
                continue
            if leftover.name.startswith("chunk-") and leftover.suffix in {".ts", ".json"}:
                continue
            if leftover.is_file():
                leftover.unlink(missing_ok=True)
        return
    if status == "completed":
        for leftover in list(workdir.iterdir()):
            if leftover.name in {"output.mp4", "job.json"}:
                continue
            if leftover.is_file():
                leftover.unlink(missing_ok=True)
        return
    shutil.rmtree(workdir, ignore_errors=True)


def write_preview_jpeg(frame, width, height, path):
    """Return the stored JPEG size. The frame is full-resolution yuv420p."""
    frame_bytes = width * height * 3 // 2
    if len(frame) != frame_bytes or width % 2 or height % 2:
        raise FFmpegError("预览帧尺寸不正确。")
    y_size = width * height
    y = np.frombuffer(frame, dtype=np.uint8, count=y_size).reshape(height, width)
    chroma = y_size // 4
    u = np.frombuffer(frame, dtype=np.uint8, count=chroma, offset=y_size).reshape(height // 2, width // 2)
    v = np.frombuffer(frame, dtype=np.uint8, count=chroma, offset=y_size + chroma).reshape(height // 2, width // 2)
    u = u.repeat(2, axis=0).repeat(2, axis=1)
    v = v.repeat(2, axis=0).repeat(2, axis=1)
    centered = y.astype(np.float32) - 16
    blue = u.astype(np.float32) - 128
    red = v.astype(np.float32) - 128
    rgb = np.stack((
        (298 * centered + 409 * red + 128) / 256,
        (298 * centered - 100 * blue - 208 * red + 128) / 256,
        (298 * centered + 516 * blue + 128) / 256,
    ), axis=-1)
    image = Image.fromarray(np.clip(rgb, 0, 255).astype(np.uint8), "RGB")
    image.thumbnail((PREVIEW_EDGE, PREVIEW_EDGE))
    path = Path(path)
    temporary = path.with_name(path.name + ".tmp")
    image.save(temporary, "JPEG", quality=80)
    # The browser may still have the previous JPEG open. On Windows that makes
    # the replace raise; skip this frame instead of stalling the export.
    replaced = False
    try:
        for _ in range(6):
            try:
                temporary.replace(path)
                replaced = True
                break
            except PermissionError:
                time.sleep(0.02)
    finally:
        if not replaced:
            temporary.unlink(missing_ok=True)
    return image.size


def _chunk_paths(workdir, index):
    stem = f"chunk-{index:05d}"
    return workdir / f"{stem}.ts", workdir / f"{stem}.json", workdir / f"{stem}.ts.partial"


def _discard_from(workdir, index):
    for path in workdir.glob("chunk-*"):
        suffix = path.suffix
        stem = path.name.split(".", 1)[0]
        if not stem.startswith("chunk-"):
            continue
        try:
            number = int(stem.removeprefix("chunk-"))
        except ValueError:
            path.unlink(missing_ok=True)
            continue
        if number >= index or suffix not in {".ts", ".json"}:
            path.unlink(missing_ok=True)


class FrameExporter:
    """Accept output frames in order. Already durable frames are not encoded again."""

    def __init__(self, runner, workdir, *, width, height, fps, preset, crf, total, identity, progress):
        if total <= 0 or width % 2 or height % 2:
            raise FFmpegError("导出帧计划无效。")
        self.runner = runner
        self.workdir = Path(workdir)
        self.workdir.mkdir(parents=True, exist_ok=True)
        self.width = width
        self.height = height
        self.frame_bytes = width * height * 3 // 2
        self.fps = fps
        self.preset = preset
        self.crf = int(crf)
        self.total = total
        self.identity = identity
        self.progress = progress
        self.pending = []
        self.resume_from, self.chunk_index = self._load_resume()
        self.next_index = self.resume_from

    def _notify(self, value, stage, preview=None):
        try:
            self.progress(value, stage, preview)
        except TypeError:
            self.progress(value, stage)

    def _load_resume(self):
        path = self.workdir / "checkpoint.json"
        try:
            checkpoint = json.loads(path.read_text(encoding="utf-8")) if path.is_file() else None
        except (OSError, ValueError):
            checkpoint = None
        if not isinstance(checkpoint, dict) or checkpoint.get("identity") != self.identity or checkpoint.get("total") != self.total:
            _discard_from(self.workdir, 0)
            path.unlink(missing_ok=True)
            return 0, 0
        durable = 0
        index = 0
        while durable < self.total:
            media, meta, _partial = _chunk_paths(self.workdir, index)
            try:
                info = json.loads(meta.read_text(encoding="utf-8")) if meta.is_file() and media.is_file() else None
            except (OSError, ValueError):
                info = None
            count = info.get("frames") if isinstance(info, dict) else None
            if not isinstance(count, int) or count <= 0 or durable + count > self.total:
                break
            durable += count
            index += 1
        _discard_from(self.workdir, index)
        return durable, index

    def write(self, frame):
        if self.next_index >= self.total:
            raise FFmpegError("导出帧数超过计划。")
        if len(frame) != self.frame_bytes:
            raise FFmpegError("输出帧大小不正确。")
        index = self.next_index
        self.pending.append(frame)
        self.next_index += 1
        if index % 12 == 0 or index + 1 == self.total:
            width, height = write_preview_jpeg(frame, self.width, self.height, self.workdir / "preview.jpg")
            if self.resume_from:
                stage = f"从第 {self.resume_from} 帧继续 · 第 {index + 1} 帧"
            else:
                stage = f"正在逐帧导出 · 第 {index + 1} 帧"
            self._notify(0.05 + 0.9 * (index + 1) / self.total, stage, {"frame": index, "width": width, "height": height})
        if len(self.pending) >= CHUNK_FRAMES:
            self._seal()

    def _seal(self):
        frames = self.pending
        self.pending = []
        if not frames:
            return
        index = self.chunk_index
        self.chunk_index += 1
        media, meta, partial = _chunk_paths(self.workdir, index)
        self._encode(frames, partial)
        with partial.open("rb+") as stream:
            os.fsync(stream.fileno())
        partial.replace(media)
        atomic_json(meta, {"frames": len(frames)})
        atomic_json(self.workdir / "checkpoint.json", {
            "version": 1, "identity": self.identity, "total": self.total, "frames": self.next_index,
        })

    def _encode(self, frames, target):
        fps = self.fps
        args = ["-f", "rawvideo", "-pix_fmt", "yuv420p", "-s", f"{self.width}x{self.height}",
                "-framerate", f"{fps.numerator}/{fps.denominator}", "-i", "pipe:0", "-an",
                "-c:v", "libx264", "-preset", self.preset, "-crf", str(self.crf), "-pix_fmt", "yuv420p",
                "-fps_mode", "passthrough", "-f", "mpegts", "-y", str(target)]
        process = self.runner.popen(args, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        errors = []
        reader = threading.Thread(target=lambda: errors.append(process.stderr.read()), daemon=True)
        reader.start()
        try:
            for frame in frames:
                self.runner.check()
                process.stdin.write(frame)
            process.stdin.close()
            process.wait()
            reader.join(5)
            self.runner.check()
            if process.returncode != 0:
                raise FFmpegError("FFmpeg 编码失败：" + b"".join(errors).decode("utf-8", "replace")[-400:])
        except (BrokenPipeError, OSError) as error:
            self.runner.check()
            raise FFmpegError("FFmpeg 编码进程提前退出。") from error
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
            reader.join(5)
            process.stderr.close()
            self.runner.release(process)

    def finish(self):
        if self.pending:
            self._seal()
        if self.next_index != self.total:
            raise FFmpegError("写入帧数与计划不一致。")
        chunks = []
        remaining = self.total
        index = 0
        while remaining > 0:
            media, meta, _partial = _chunk_paths(self.workdir, index)
            try:
                count = json.loads(meta.read_text(encoding="utf-8")).get("frames")
            except (OSError, ValueError):
                count = None
            if not isinstance(count, int) or count <= 0 or count > remaining or not media.is_file():
                raise FFmpegError("已保存的导出片段不完整，无法继续。")
            chunks.append(media)
            remaining -= count
            index += 1
        listing = self.workdir / "chunks.ffconcat"
        lines = ["ffconcat version 1.0"]
        for media in chunks:
            escaped = media.resolve().as_posix().replace("'", r"'\''")
            lines.append(f"file '{escaped}'")
        listing.write_text("\n".join(lines) + "\n", encoding="utf-8")
        video = self.workdir / "video.ts"
        self.runner.run(["-f", "concat", "-safe", "0", "-i", str(listing), "-map", "0:v:0", "-c", "copy", "-y", str(video)])
        return video


def mux_mp4(runner, video, audio_file, target, *, timescale, audio_rate, audio_channels):
    args = ["-i", str(video)]
    if audio_file:
        args += ["-f", "f32le", "-ar", str(audio_rate), "-ac", str(audio_channels), "-i", str(audio_file)]
    args += ["-map", "0:v:0"]
    if audio_file:
        args += ["-map", "1:a:0", "-c:a", "aac", "-b:a", "192k"]
    args += ["-c:v", "copy", "-video_track_timescale", str(int(timescale)), "-movflags", "+faststart", "-y", str(target)]
    runner.run(args)
