"""Local SAM3 mask for the white-model plate.

The graph reuses the official SAM3 nodes already used by character swap:
CheckpointLoaderSimple sam3.1, CLIPTextEncode, SAM3_Detect, H3RelaySelectMask,
SAM3_VideoTrack, SAM3_TrackToMask, H3RelayRecoverMasks, H3RelayExpandMask.
Each keep-prompt is its own track (max_objects 1) so a pole is not dropped
because the person is larger. Masks are unioned. There is no cloud call and
no model download.

SAM3_Detect and SAM3_VideoTrack in that graph take text conditioning only.
They have no point or box sockets, so this node does not invent any.
Grow and feather are applied later by ffmpeg on the returned mask; the
expand node stays at 0 so the mask is not grown twice.
"""
from __future__ import annotations

import json
import re
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

SAM_CHECKPOINT = "sam3.1_multiplex_fp16.safetensors"
_NAME = re.compile(r"[A-Za-z0-9._-]{1,120}\Z")


class PlateSegmentError(RuntimeError):
    pass


def build_sam3_plate_workflow(video_name, prompts, frames, fps):
    if not isinstance(video_name, str) or not _NAME.fullmatch(video_name):
        raise PlateSegmentError("上传文件名无效。")
    if not isinstance(prompts, list) or not prompts:
        raise PlateSegmentError("SAM3 至少需要一个文字提示。")
    if type(frames) is not int or frames < 1:
        raise PlateSegmentError("帧数无效。")
    rate = float(fps)
    if not rate > 0:
        raise PlateSegmentError("帧率无效。")
    graph = {
        "source": {"class_type": "LoadVideo", "inputs": {"file": video_name}},
        "components": {"class_type": "GetVideoComponents", "inputs": {"video": ["source", 0]}},
        "first_frame": {"class_type": "ImageFromBatch", "inputs": {"image": ["components", 0], "batch_index": 0, "length": 1}},
        "sam": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": SAM_CHECKPOINT}},
    }
    current = None
    for index, prompt in enumerate(prompts):
        prefix = f"p{index}"
        graph[f"{prefix}_text"] = {"class_type": "CLIPTextEncode", "inputs": {"clip": ["sam", 1], "text": prompt}}
        graph[f"{prefix}_detect"] = {"class_type": "SAM3_Detect", "inputs": {
            "model": ["sam", 0], "image": ["first_frame", 0], "conditioning": [f"{prefix}_text", 0],
            "threshold": 0.35, "refine_iterations": 2, "individual_masks": True,
        }}
        graph[f"{prefix}_select"] = {"class_type": "H3RelaySelectMask", "inputs": {
            "masks": [f"{prefix}_detect", 0], "selection": "largest", "index": 0,
        }}
        graph[f"{prefix}_track"] = {"class_type": "SAM3_VideoTrack", "inputs": {
            "model": ["sam", 0], "images": ["components", 0], "initial_mask": [f"{prefix}_select", 0],
            "conditioning": [f"{prefix}_text", 0], "detection_threshold": 0.5, "max_objects": 1, "detect_interval": 1,
        }}
        graph[f"{prefix}_mask"] = {"class_type": "SAM3_TrackToMask", "inputs": {"track_data": [f"{prefix}_track", 0], "object_indices": ""}}
        graph[f"{prefix}_recover"] = {"class_type": "H3RelayRecoverMasks", "inputs": {
            "masks": [f"{prefix}_mask", 0], "images": ["components", 0], "source_frames": frames,
            "model": ["sam", 0], "conditioning": [f"{prefix}_text", 0], "selection": [f"{prefix}_select", 1],
            "recover_empty_frames": True,
        }}
        graph[f"{prefix}_expand"] = {"class_type": "H3RelayExpandMask", "inputs": {
            "masks": [f"{prefix}_recover", 0], "images": ["components", 0], "source_frames": frames, "expansion_px": 0,
        }}
        mask = [f"{prefix}_expand", 0]
        if current is None:
            current = mask
        else:
            union = f"union_{index}"
            graph[union] = {"class_type": "MaskComposite", "inputs": {
                "destination": current, "source": mask, "x": 0, "y": 0, "operation": "add",
            }}
            current = [union, 0]
    graph["mask_image"] = {"class_type": "MaskToImage", "inputs": {"mask": current}}
    graph["mask_video"] = {"class_type": "CreateVideo", "inputs": {"images": ["mask_image", 0], "fps": rate}}
    graph["save"] = {"class_type": "SaveVideo", "inputs": {
        "video": ["mask_video", 0], "filename_prefix": "video/H3_WhitePlateMask", "format": "mp4",
        "format.codec": "h264", "format.codec.encoding": "re-encode", "format.codec.encoding.crf": 16,
    }}
    return graph


class ComfySam3Segmenter:
    """Queue the plate workflow on the local ComfyUI. Tests replace this."""

    def __init__(self, origin="http://127.0.0.1:8188", timeout=30):
        self.origin = origin.rstrip("/")
        self.timeout = timeout

    def __call__(self, video_path, document, info, workdir, progress, cancelled):
        progress(0.08, "正在把视频交给本机 SAM3")
        if cancelled():
            from video_edit_ffmpeg import Cancelled
            raise Cancelled()
        name = f"h3plate-{uuid.uuid4().hex[:12]}.mp4"
        self._upload(Path(video_path), name)
        workflow = build_sam3_plate_workflow(name, list(document["keepPrompts"]), info["frameCount"], float(info["fps"]))
        prompt_id = self._json("/prompt", {"prompt": workflow, "client_id": uuid.uuid4().hex})["prompt_id"]
        progress(0.2, "SAM3 正在跟踪人物和杆子")
        entry = self._wait(prompt_id, progress, cancelled)
        return self._download(entry, Path(workdir) / "mask.mp4")

    def _upload(self, path, name):
        boundary = "----h3plate" + uuid.uuid4().hex
        body = bytearray()
        for key, value in (("overwrite", "true"), ("type", "input")):
            body += f"--{boundary}\r\nContent-Disposition: form-data; name=\"{key}\"\r\n\r\n{value}\r\n".encode()
        header = (
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"{name}\"\r\n"
            "Content-Type: video/mp4\r\n\r\n"
        ).encode()
        body += header + path.read_bytes() + f"\r\n--{boundary}--\r\n".encode()
        self._read("/upload/image", bytes(body), {"Content-Type": f"multipart/form-data; boundary={boundary}"})

    def _json(self, path, payload):
        raw = self._read(path, json.dumps(payload).encode("utf-8"), {"Content-Type": "application/json"})
        try:
            return json.loads(raw) if raw.strip() else {}
        except json.JSONDecodeError as error:
            raise PlateSegmentError("ComfyUI 返回的不是 JSON。") from error

    def _read(self, path, data=None, headers=None, timeout=None):
        request = urllib.request.Request(self.origin + path, data=data, headers=headers or {})
        try:
            with urllib.request.urlopen(request, timeout=timeout or self.timeout) as response:
                return response.read()
        except urllib.error.HTTPError as error:
            detail = error.read()[:240].decode("utf-8", "replace").replace("\n", " ")
            raise PlateSegmentError(f"ComfyUI 返回 HTTP {error.code}。{detail}") from error
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            raise PlateSegmentError("无法连接本机 ComfyUI。绿幕白模的分割使用官方 SAM3，需要 ComfyUI 已在本机运行。") from error

    def _wait(self, prompt_id, progress, cancelled):
        import time
        from video_edit_ffmpeg import Cancelled
        while True:
            if cancelled():
                self._cancel(prompt_id)
                raise Cancelled()
            raw = self._read(f"/history/{prompt_id}")
            try:
                history = json.loads(raw) if raw.strip() else {}
            except json.JSONDecodeError as error:
                raise PlateSegmentError("ComfyUI 返回的不是 JSON。") from error
            entry = history.get(prompt_id) if isinstance(history, dict) else None
            if entry:
                status = entry.get("status") or {}
                if status.get("status_str") == "error":
                    raise PlateSegmentError("SAM3 分割失败。请确认本机已注册官方 SAM3 节点，且 sam3.1_multiplex_fp16 已安装。")
                if status.get("completed") or status.get("status_str") == "success":
                    return entry
            progress(0.45, "SAM3 正在跟踪人物和杆子")
            time.sleep(0.5)

    def _cancel(self, prompt_id):
        try:
            self._json("/queue", {"delete": [prompt_id]})
        except PlateSegmentError:
            return

    def _download(self, entry, target):
        chosen = None
        for node in (entry.get("outputs") or {}).values():
            if not isinstance(node, dict):
                continue
            for key in ("videos", "gifs", "images"):
                for item in node.get(key) or []:
                    if isinstance(item, dict) and item.get("filename"):
                        chosen = item
        if not chosen:
            raise PlateSegmentError("SAM3 没有返回遮罩视频。")
        query = urllib.parse.urlencode({
            "filename": chosen["filename"],
            "subfolder": chosen.get("subfolder") or "",
            "type": chosen.get("type") or "output",
        })
        target.write_bytes(self._read("/view?" + query, timeout=120))
        return target
