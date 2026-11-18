"""Local, cancellable speech transcription for project video assets.

The editor process extracts mono audio with its normal FFmpeg runner. The
optional CPU speech runtime is a separate Python interpreter, so video edits
and export still work when the speech dependency is unavailable.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

SAMPLE_RATE = 16000
MAX_SEGMENTS = 4096
MAX_SEGMENT_TEXT = 1024
MAX_RESULT_BYTES = 1024 * 1024
MODEL_IDS = ("small", "base", "tiny")
WORKER_PATH = Path(__file__).resolve()


class TranscriptError(RuntimeError):
    pass


def _is_model(directory):
    return all((directory / name).is_file() for name in ("model.bin", "config.json", "tokenizer.json"))


def _local_model():
    if configured := os.environ.get("H3_VIDEO_TRANSCRIPT_MODEL"):
        directory = Path(configured).expanduser()
        if not directory.is_absolute() or not _is_model(directory):
            raise TranscriptError("指定的本地转写模型不完整，请检查 H3_VIDEO_TRANSCRIPT_MODEL。")
        return directory

    home = Path(os.environ.get("HF_HOME") or (Path.home() / ".cache" / "huggingface"))
    hub = Path(os.environ.get("HF_HUB_CACHE") or (home / "hub")).expanduser()
    for size in MODEL_IDS:
        model = hub / f"models--Systran--faster-whisper-{size}"
        snapshots = model / "snapshots"
        try:
            revision = (model / "refs" / "main").read_text(encoding="ascii").strip()
        except (OSError, UnicodeError):
            revision = ""
        if re.fullmatch(r"[0-9a-f]{40}", revision) and _is_model(directory := snapshots / revision):
            return directory
        if snapshots.is_dir():
            for directory in sorted(snapshots.iterdir()):
                if directory.is_dir() and _is_model(directory):
                    return directory
    raise TranscriptError("未找到本地 Faster-Whisper 模型，请在工作台启动配置中指定模型目录。")


def _runtime():
    configured = os.environ.get("H3_VIDEO_TRANSCRIPT_PYTHON")
    executable = Path(configured or sys.executable).expanduser()
    if not executable.is_absolute() or not executable.is_file():
        raise TranscriptError("未找到转写 Python，请检查 H3_VIDEO_TRANSCRIPT_PYTHON。")
    return executable


def _speech_process(runner, executable, model, audio, *, timeout=3600):
    runner.check()
    # Ignore Python environment overrides and exclude the working/script
    # directory from imports while allowing a user's installed speech package.
    command = [str(executable), "-E", "-P", "-X", "utf8", str(WORKER_PATH), str(model), str(audio)]
    env = {**os.environ, "HF_HUB_OFFLINE": "1", "HF_HUB_DISABLE_TELEMETRY": "1", "TRANSFORMERS_OFFLINE": "1"}
    try:
        process = subprocess.Popen(command, shell=False, env=env, stdin=subprocess.DEVNULL,
                                   stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                   creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except OSError as error:
        raise TranscriptError("无法启动本地转写运行时，请检查 Python 配置。") from error
    deadline = time.monotonic() + timeout
    try:
        while True:
            runner.check()
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TranscriptError("本地语音转写超时。")
            try:
                output, _ = process.communicate(timeout=min(remaining, 0.25))
                break
            except subprocess.TimeoutExpired:
                continue
        runner.check()
        if process.returncode == 2:
            raise TranscriptError("转写运行时未安装 faster-whisper，请配置工作台的转写 Python。")
        if process.returncode == 3:
            raise TranscriptError("转写段落数量或文本长度超过上限，请拆分录屏后重试。")
        if process.returncode:
            raise TranscriptError("本地语音转写失败，请检查模型及 CPU 运行时。")
        if len(output) > MAX_RESULT_BYTES:
            raise TranscriptError("转写结果超过大小上限，请拆分录屏后重试。")
        try:
            return json.loads(output)
        except (ValueError, UnicodeError) as error:
            raise TranscriptError("本地转写返回了无效的结果。") from error
    finally:
        if process.poll() is None:
            process.kill()
        process.communicate()


def _source_segments(payload, offset_ms, duration_ms):
    if not isinstance(payload, dict):
        raise TranscriptError("本地转写返回了无效的结果。")
    language = payload.get("language")
    segments = payload.get("segments")
    if (not isinstance(language, str) or not re.fullmatch(r"[a-z]{2,3}", language)
            or not isinstance(segments, list) or len(segments) > MAX_SEGMENTS):
        raise TranscriptError("本地转写返回了无效的语言或段落。")
    mapped = []
    for segment in segments:
        if not isinstance(segment, dict):
            raise TranscriptError("本地转写返回了无效的段落。")
        start, end, text = segment.get("startMs"), segment.get("endMs"), segment.get("text")
        if (type(start) is not int or type(end) is not int or not 0 <= start < end
                or not isinstance(text, str) or len(text) > MAX_SEGMENT_TEXT):
            raise TranscriptError("本地转写返回了无效的时间或文本。")
        first, last = max(0, start + offset_ms), min(duration_ms, end + offset_ms)
        if first < last and text.strip():
            mapped.append({"startMs": first, "endMs": last, "text": text.strip()})
    return {"language": language, "durationMs": duration_ms, "segments": sorted(mapped, key=lambda part: part["startMs"])}


def transcribe_video(runner, file, info, workdir, *, max_seconds):
    if not info["frameCount"] or info["audioOffset"] is None:
        raise TranscriptError("语音转写需要带音轨的视频。")
    if info["duration"] > max_seconds:
        raise TranscriptError("语音转写支持最长 1 小时的视频。")
    model = _local_model()
    executable = _runtime()
    workdir.mkdir(parents=True, exist_ok=True)
    audio = workdir / "transcript.wav"
    try:
        # Reset only the starting timestamp and retain later input gaps. The
        # probe's first-audio offset is reapplied relative to the first video frame.
        runner.run(["-i", str(file), "-map", "0:a:0", "-vn", "-af",
                    f"asetpts=PTS-STARTPTS,aresample={SAMPLE_RATE}:async=1:first_pts=0",
                    "-ac", "1", "-c:a", "pcm_s16le", "-t", str(max_seconds), "-y", str(audio)], timeout=600)
        payload = _speech_process(runner, executable, model, audio)
    finally:
        audio.unlink(missing_ok=True)
    return _source_segments(payload, round(info["audioOffset"] * 1000), round(info["duration"] * 1000))


def _worker(model_dir, audio):
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        return 2

    try:
        model = WhisperModel(model_dir, device="cpu", compute_type="int8", local_files_only=True,
                             cpu_threads=min(8, os.cpu_count() or 1))
        segments, info = model.transcribe(audio, vad_filter=True)
        result = []
        size = 100
        for segment in segments:
            start, end = round(segment.start * 1000), round(segment.end * 1000)
            text = segment.text.strip()
            if not text or start >= end:
                continue
            item = {"startMs": start, "endMs": end, "text": text}
            size += len(json.dumps(item, ensure_ascii=False).encode("utf-8")) + 2
            if len(result) >= MAX_SEGMENTS or len(text) > MAX_SEGMENT_TEXT or size > MAX_RESULT_BYTES:
                return 3
            result.append(item)
        output = json.dumps({"language": info.language, "segments": result}, ensure_ascii=False)
        sys.stdout.buffer.write(output.encode("utf-8"))
        return 0
    except Exception:
        return 1


if __name__ == "__main__":
    raise SystemExit(_worker(*sys.argv[1:]) if len(sys.argv) == 3 else 1)
