"""Local paint-brush library. Standard library only; files stay under DATA_DIR."""

from __future__ import annotations

import base64
import json
import re
import secrets
import urllib.parse
from pathlib import Path

BRUSH_ID = re.compile(r"^(?:builtin-[a-z0-9-]{1,40}|br_[0-9a-f]{16})$")
CUSTOM_ID = re.compile(r"^br_[0-9a-f]{16}$")
MAX_PNG_BYTES = 2 * 1024 * 1024
MAX_BODY = 8 * 1024 * 1024

BUILTIN_BRUSHES = [
    {"id": "builtin-hard-round", "name": "硬圆勾线笔", "group": "内置"},
    {"id": "builtin-soft-air", "name": "软边喷枪", "group": "内置"},
    {"id": "builtin-pencil-2b", "name": "2B 素描铅笔", "group": "内置"},
    {"id": "builtin-charcoal", "name": "炭笔肌理笔", "group": "内置"},
    {"id": "builtin-flat-paint", "name": "扁平厚涂笔", "group": "内置"},
    {"id": "builtin-watercolor", "name": "水彩晕染笔", "group": "内置"},
    {"id": "builtin-marker", "name": "平头马克笔", "group": "内置"},
    {"id": "builtin-pixel", "name": "像素硬笔", "group": "内置"},
]


class BrushError(Exception):
    def __init__(self, message, status=400, code="BAD_BRUSH"):
        super().__init__(message)
        self.message = message
        self.status = status
        self.code = code


def _clamp(value, low, high, default):
    try:
        number = float(value)
    except (TypeError, ValueError):
        number = default
    return max(low, min(high, number))


def sanitize_params(raw):
    source = raw if isinstance(raw, dict) else {}
    return {
        "size": round(_clamp(source.get("size", 16), 1, 500, 16)),
        "hardness": round(_clamp(source.get("hardness", 80), 0, 100, 80)),
        "spacing": round(_clamp(source.get("spacing", 12), 1, 200, 12)),
        "opacity": round(_clamp(source.get("opacity", 100), 1, 100, 100)),
        "flow": round(_clamp(source.get("flow", 100), 1, 100, 100)),
        "minDiameter": round(_clamp(source.get("minDiameter", 20), 1, 100, 20)),
        "smoothing": round(_clamp(source.get("smoothing", 20), 0, 100, 20)),
        "angle": round(_clamp(source.get("angle", 0), 0, 360, 0)),
        "sizeJitter": round(_clamp(source.get("sizeJitter", 0), 0, 100, 0)),
        "angleJitter": round(_clamp(source.get("angleJitter", 0), 0, 180, 0)),
        "scatter": round(_clamp(source.get("scatter", 0), 0, 2, 0), 3),
        "pressureSize": bool(source.get("pressureSize", False)),
        "pressureOpacity": bool(source.get("pressureOpacity", False)),
        "followDirection": bool(source.get("followDirection", False)),
        "blendMode": source.get("blendMode") if source.get("blendMode") in {"normal", "multiply", "screen", "add", "overlay", "soft-light"} else "normal",
    }


def _text(value, limit, fallback):
    if not isinstance(value, str):
        return fallback
    cleaned = value.replace("\x00", "").strip()
    if not cleaned or "/" in cleaned or "\\" in cleaned or ".." in cleaned:
        raise BrushError("笔刷名称无效。")
    return cleaned[:limit]


def _png_bytes(value):
    if not isinstance(value, str) or len(value) > MAX_PNG_BYTES * 2:
        raise BrushError("笔刷图案不是有效的 PNG。")
    try:
        data = base64.b64decode(value, validate=True)
    except Exception as exc:
        raise BrushError("笔刷图案不是有效的 PNG。") from exc
    if len(data) < 24 or len(data) > MAX_PNG_BYTES or not data.startswith(b"\x89PNG\r\n\x1a\n") or b"IEND" not in data[-24:]:
        raise BrushError("笔刷图案不是有效的 PNG。")
    return data


class PaintBrushAPI:
    def __init__(self, directory):
        self.root = Path(directory)
        self.root.mkdir(parents=True, exist_ok=True)
        if self.root.is_symlink():
            raise BrushError("笔刷库目录不能是符号链接。", 500, "BRUSH_STORAGE")
        self.root = self.root.resolve()

    def _custom_paths(self, brush_id):
        if not CUSTOM_ID.fullmatch(brush_id):
            raise BrushError("笔刷编号无效，已拒绝路径穿越。")
        meta = (self.root / f"{brush_id}.json").resolve()
        stamp = (self.root / f"{brush_id}.png").resolve()
        if meta.parent != self.root or stamp.parent != self.root or meta.is_symlink() or stamp.is_symlink():
            raise BrushError("笔刷编号无效，已拒绝路径穿越。")
        return meta, stamp

    def _read_custom(self, brush_id):
        meta, stamp = self._custom_paths(brush_id)
        if not meta.is_file() or not stamp.is_file():
            raise BrushError("找不到这支笔刷。", 404, "NOT_FOUND")
        try:
            payload = json.loads(meta.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise BrushError("笔刷记录已损坏。", 500, "BRUSH_STORAGE") from exc
        payload["builtin"] = False
        payload["stampUrl"] = f"/api/paint/brushes/{brush_id}/stamp"
        return payload

    def list_brushes(self):
        brushes = [{"id": item["id"], "name": item["name"], "group": item["group"], "builtin": True, "stampUrl": None, "params": {}} for item in BUILTIN_BRUSHES]
        for path in sorted(self.root.glob("br_*.json")):
            if not CUSTOM_ID.fullmatch(path.stem) or path.is_symlink():
                continue
            try:
                brushes.append(self._read_custom(path.stem))
            except BrushError:
                continue
        return brushes

    def create(self, payload):
        if not isinstance(payload, dict):
            raise BrushError("笔刷参数无效。")
        name = _text(payload.get("name"), 80, "")
        if not name:
            raise BrushError("笔刷名称无效。")
        group = _text(payload.get("group") or "导入", 32, "导入")
        png = _png_bytes(payload.get("pngBase64"))
        params = sanitize_params(payload.get("params"))
        brush_id = f"br_{secrets.token_hex(8)}"
        meta, stamp = self._custom_paths(brush_id)
        record = {"id": brush_id, "name": name, "group": group, "builtin": False, "params": params}
        meta.write_text(json.dumps(record, ensure_ascii=False), encoding="utf-8")
        stamp.write_bytes(png)
        record["stampUrl"] = f"/api/paint/brushes/{brush_id}/stamp"
        return record

    def update(self, brush_id, payload):
        if brush_id.startswith("builtin-"):
            raise BrushError("内置笔刷不能修改。", 403, "BUILTIN_BRUSH")
        current = self._read_custom(brush_id)
        if not isinstance(payload, dict):
            raise BrushError("笔刷参数无效。")
        if "name" in payload:
            current["name"] = _text(payload.get("name"), 80, "")
        if "group" in payload:
            current["group"] = _text(payload.get("group"), 32, "导入")
        if "params" in payload:
            current["params"] = sanitize_params(payload.get("params"))
        meta, _stamp = self._custom_paths(brush_id)
        stored = {key: current[key] for key in ("id", "name", "group", "builtin", "params")}
        meta.write_text(json.dumps(stored, ensure_ascii=False), encoding="utf-8")
        return current

    def delete(self, brush_id):
        if brush_id.startswith("builtin-"):
            raise BrushError("内置笔刷不能删除。", 403, "BUILTIN_BRUSH")
        meta, stamp = self._custom_paths(brush_id)
        if not meta.is_file():
            raise BrushError("找不到这支笔刷。", 404, "NOT_FOUND")
        meta.unlink()
        if stamp.is_file() and not stamp.is_symlink():
            stamp.unlink()
        return {"ok": True, "id": brush_id}

    def stamp_bytes(self, brush_id):
        if brush_id.startswith("builtin-"):
            raise BrushError("内置笔刷图案由前端生成。", 404, "NOT_FOUND")
        _meta, stamp = self._custom_paths(brush_id)
        if not stamp.is_file():
            raise BrushError("找不到这支笔刷。", 404, "NOT_FOUND")
        return stamp.read_bytes()

    def handle(self, handler, method, path):
        if not path.startswith("/api/paint/brushes"):
            return False
        try:
            if path == "/api/paint/brushes" and method == "GET":
                handler.send_json(200, {"brushes": self.list_brushes()})
                return True
            if path == "/api/paint/brushes" and method == "POST":
                handler.send_json(201, self.create(self._body(handler)))
                return True
            if path == "/api/paint/brushes":
                handler.send_json(405, {"code": "METHOD_NOT_ALLOWED", "message": "该笔刷接口不支持此方法。"})
                return True
            rest = urllib.parse.unquote(path[len("/api/paint/brushes/"):])
            stamp = rest.endswith("/stamp")
            brush_id = rest[:-6] if stamp else rest
            if "/" in brush_id or "\\" in brush_id or not BRUSH_ID.fullmatch(brush_id or ""):
                handler.send_json(400, {"code": "BAD_BRUSH_ID", "message": "笔刷编号无效，已拒绝路径穿越。"})
                return True
            if stamp and method == "GET":
                self._send_bytes(handler, 200, self.stamp_bytes(brush_id), "image/png")
                return True
            if method == "PATCH":
                handler.send_json(200, self.update(brush_id, self._body(handler)))
                return True
            if method == "DELETE":
                handler.send_json(200, self.delete(brush_id))
                return True
            if method == "GET":
                handler.send_json(200, self._read_custom(brush_id) if not brush_id.startswith("builtin-") else next(item for item in self.list_brushes() if item["id"] == brush_id))
                return True
            handler.send_json(405, {"code": "METHOD_NOT_ALLOWED", "message": "该笔刷接口不支持此方法。"})
            return True
        except BrushError as exc:
            handler.send_json(exc.status, {"code": exc.code, "message": exc.message})
            return True
        except StopIteration:
            handler.send_json(404, {"code": "NOT_FOUND", "message": "找不到这支笔刷。"})
            return True

    @staticmethod
    def _body(handler):
        try:
            length = int(handler.headers.get("Content-Length", "0"))
        except ValueError as exc:
            raise BrushError("笔刷参数无效。") from exc
        if length < 0 or length > MAX_BODY:
            raise BrushError("笔刷请求过大。", 413, "BRUSH_TOO_LARGE")
        raw = handler.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeError, ValueError) as exc:
            raise BrushError("笔刷参数无效。") from exc
        return payload

    @staticmethod
    def _send_bytes(handler, status, body, content_type):
        sender = getattr(handler, "send_bytes", None)
        if sender:
            sender(status, body, content_type)
            return
        handler.send_response(status)
        handler.send_header("Content-Type", content_type)
        handler.send_header("Content-Length", str(len(body)))
        handler.end_headers()
        handler.wfile.write(body)
