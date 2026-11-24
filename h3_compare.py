"""Read-only provenance and presentation timestamps for an H3 refine result."""

import functools
import json
import re
from fractions import Fraction
from pathlib import Path

from video_edit_ffmpeg import FFmpegError, Runner, _parse_framecrc

MAX_COMPARE_FRAMES = 4096
H3_REFINE_PREFIX = "video/H3_HD_Refine"
VIDEO_SUFFIXES = {".mp4", ".mov", ".mkv", ".webm"}


def _media_path(root, name):
    if not isinstance(name, str):
        return None
    parts = name.replace("\\", "/").split("/")
    if any(not part or part in {".", ".."} or ":" in part or "\0" in part
           or part.endswith((".", " ")) for part in parts):
        return None
    base = Path(root).resolve()
    try:
        path = base.joinpath(*parts).resolve()
    except (OSError, ValueError):
        return None
    if base not in path.parents or path.suffix.lower() not in VIDEO_SUFFIXES or not path.is_file():
        return None
    return path


def _media_ref(root, path, kind):
    relative = path.parent.relative_to(Path(root).resolve()).as_posix()
    return {
        "type": kind,
        "filename": path.name,
        "subfolder": "" if relative == "." else relative,
    }


def _identity(path):
    stat = path.stat()
    return stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns


@functools.lru_cache(maxsize=32)
def _embedded_graph(path, identity):
    # ffmetadata escapes literal backslashes, =, ; and # in a tag value.
    metadata = Runner().run(["-i", str(path), "-map_metadata", "0", "-f", "ffmetadata", "-"], timeout=12)
    for line in metadata.decode("utf-8", "replace").splitlines():
        key, sep, value = line.partition("=")
        if key != "prompt" or not sep or len(value) > 262144:
            continue
        try:
            graph = json.loads(re.sub(r"\\(.)", r"\1", value))
        except ValueError:
            return None
        return graph if isinstance(graph, dict) else None
    return None


def refine_source(graph):
    def node_inputs(node_id, class_type):
        node = graph.get(node_id) if isinstance(graph, dict) else None
        if not isinstance(node, dict) or node.get("class_type") != class_type or not isinstance(node.get("inputs"), dict):
            return {}
        return node["inputs"]

    save = node_inputs("save", "SaveVideo")
    video = node_inputs("video", "CreateVideo")
    components = node_inputs("components", "GetVideoComponents")
    probe = node_inputs("probe", "GetImageSizeAndCount")
    scale = node_inputs("upscale", "MinimaxH3LatentUpscaler3D")
    if (save.get("filename_prefix") != H3_REFINE_PREFIX or save.get("video") != ["video", 0]
            or video.get("fps") != ["components", 2] or components.get("video") != ["source", 0]
            or probe.get("image") != ["components", 0] or not scale):
        return None
    name = node_inputs("source", "LoadVideo").get("file")
    return name.removesuffix(" [input]") if isinstance(name, str) and name else None


@functools.lru_cache(maxsize=32)
def _decode_timeline(path, identity):
    # Preserve the demuxer's timebase and absolute PTS. Audio and container
    # duration can be longer than the video and are not used for seeks.
    out = Runner().run([
        "-copyts", "-i", str(path), "-map", "0:v:0", "-an", "-fps_mode", "passthrough",
        "-enc_time_base", "demux", "-frames:v", str(MAX_COMPARE_FRAMES + 1),
        "-c:v", "wrapped_avframe", "-f", "framecrc", "-",
    ], timeout=20)
    streams, rows = _parse_framecrc(out.decode("utf-8", "replace"))
    if 0 not in streams or not rows.get(0):
        raise ValueError("video frames unavailable")
    pts = sorted(rows[0])
    if len(pts) > MAX_COMPARE_FRAMES:
        raise ValueError("frame count limit exceeded")
    width, height = map(int, streams[0]["dimensions"].split("x"))
    step = Fraction(streams[0]["tb"])
    times = tuple(row[0] * step for row in pts)
    duration = times[-1] + pts[-1][1] * step - times[0] if pts[-1][1] > 0 else None
    return width, height, times, duration


def _rational(time):
    return {"num": time.numerator, "den": time.denominator} if time is not None else None


def _summary(timeline):
    width, height, times, duration = timeline
    intervals = {b - a for a, b in zip(times, times[1:])}
    fps = 1 / next(iter(intervals)) if len(intervals) == 1 and 0 not in intervals else None
    return {
        "width": width, "height": height, "frameCount": len(times),
        "duration": _rational(duration), "firstPts": _rational(times[0]), "fps": _rational(fps),
    }


def synchronize(source, refined):
    left, right = source[2], refined[2]
    if left[0] != 0 or right[0] != 0:
        return {"reason": "nonzero-start"}
    if len(left) != len(right):
        return {"reason": "frame-count"}
    if left != right or any(b <= a for a, b in zip(left, left[1:])):
        return {"reason": "timestamps"}
    if source[3] is None or refined[3] is None or source[3] != refined[3]:
        return {"reason": "video-end"}
    # A constant cadence comes back as one rational stride. The rare matched
    # VFR pair carries only one common PTS list.
    intervals = {b - a for a, b in zip(left, left[1:])}
    clock = {"count": len(left), "end": _rational(source[3])}
    if len(intervals) == 1:
        clock["step"] = _rational(intervals.pop())
    else:
        clock["times"] = [float(time) for time in left]
    return {"clock": clock}


def inspect_h3_result(data, input_root, output_root):
    """Use only the saved result and its own embedded graph as provenance."""
    result = {"refined": None, "source": None, "provenance": None}
    if not isinstance(data, dict):
        return {**result, "reason": "result-kind"}
    filename = data.get("filename")
    subfolder = data.get("subfolder", "")
    if (data.get("kind") != "video" or data.get("type") != "output"
            or not isinstance(subfolder, str) or not isinstance(filename, str) or "/" in filename or "\\" in filename
            or not filename.startswith("H3_HD_Refine_")):
        return {**result, "reason": "result-kind"}
    relative = "/".join(filter(None, (subfolder, filename)))
    output = _media_path(output_root, relative)
    if output is None:
        return {**result, "reason": "result-missing"}
    result["refined"] = _media_ref(output_root, output, "output")
    try:
        output_key = _identity(output)
        graph = _embedded_graph(output, output_key)
    except (FFmpegError, OSError):
        return {**result, "reason": "receipt-unreadable"}
    source_name = refine_source(graph)
    if not source_name:
        return {**result, "reason": "receipt-missing"}
    result["provenance"] = "embedded-workflow"
    source = _media_path(input_root, source_name)
    if source is None:
        return {**result, "reason": "source-missing"}
    result["source"] = _media_ref(input_root, source, "input")
    try:
        source_key = _identity(source)
        if source_key[1] > output_key[1]:
            return {**result, "reason": "source-newer"}
        source_timeline = _decode_timeline(source, source_key)
        output_timeline = _decode_timeline(output, output_key)
        if _identity(source) != source_key or _identity(output) != output_key:
            return {**result, "reason": "media-changed"}
    except (FFmpegError, OSError, ValueError, KeyError):
        return {**result, "reason": "probe-unavailable"}
    result["source"].update(_summary(source_timeline))
    result["refined"].update(_summary(output_timeline))
    sw, sh = source_timeline[:2]
    rw, rh = output_timeline[:2]
    result["aspectDiffers"] = sw * rh != rw * sh
    return {**result, **synchronize(source_timeline, output_timeline)}


def serve_h3_compare(handler, path, store, input_root, output_root):
    """Mount after the workbench auth gate. No new project/media write path."""
    if path != "/api/h3-compare":
        return False
    from urllib.parse import parse_qs, urlsplit
    from project_store import StoreError

    query = parse_qs(urlsplit(handler.path).query)
    if set(query) != {"projectId", "nodeId"} or any(
        len(values) != 1 or len(values[0]) > 256 for values in query.values()
    ):
        handler.send_json(400, {"message": "请指定一个已保存的二采结果节点。"})
        return True
    try:
        project = store.get(query["projectId"][0])
    except StoreError as error:
        handler.send_json(error.status, {"code": error.code, "message": str(error)})
        return True
    node = next((node for node in project["canvas"]["nodes"] if node.get("id") == query["nodeId"][0]), None)
    if node is None:
        handler.send_json(404, {"message": "此结果节点尚未保存或已经移除。"})
        return True
    handler.send_json(200, inspect_h3_result(node.get("data") or {}, input_root, output_root))
    return True
