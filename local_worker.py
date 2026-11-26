"""JSON-line progress and host-verified local worker artifacts."""
import hashlib
import json
from pathlib import Path


ROLES = {
    "model": {".glb", ".obj"}, "proxy": {".glb", ".obj"}, "poster": {".png"},
    "texture": {".png"}, "report": {".json"}, "export": {".glb", ".obj", ".fbx", ".png"},
    "plan": {".json", ".bin"}, "evidence": {".npz"},
}


def worker_progress(stream):
    while line := stream.readline(65537):
        if len(line) > 65536:
            raise ValueError("Worker progress line exceeds limit")
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if isinstance(entry, dict):
            event = {}
            value = entry.get("progress")
            if type(value) in (int, float) and 0 <= value <= 1:
                event["progress"] = value
            if isinstance(entry.get("stage"), str):
                event["stage"] = entry["stage"][:128]
            if event:
                yield event


def _reject_nonfinite(_value):
    raise ValueError("Non-finite worker JSON")


def verified_result(manifest, artifact):
    """The host resolves every claimed filename within its own job directory."""
    if manifest.is_symlink() or manifest.stat().st_size > 4 * 1024**2:
        raise ValueError("Invalid result manifest")
    result = json.loads(manifest.read_text(encoding="utf-8"), parse_constant=_reject_nonfinite)
    if (not isinstance(result, dict) or not isinstance(result.get("metadata"), dict)
            or not isinstance(result.get("quality"), dict) or not isinstance(result.get("warnings"), list)
            or not isinstance(result.get("files"), list) or len(result["files"]) > 64):
        raise ValueError("Invalid result manifest")
    seen = set()
    for entry in result["files"]:
        if not isinstance(entry, dict) or not all(isinstance(entry.get(key), str) for key in ("name", "role", "mime")):
            raise ValueError("Invalid result file descriptor")
        name, role = entry["name"], entry["role"]
        suffix = Path(name).suffix.lower()
        if name in seen or suffix not in ROLES.get(role, set()) or (role == "report" and name != "report.json"):
            raise ValueError("Unsupported or duplicate worker artifact")
        seen.add(name)
        file, url = artifact(name)
        digest = hashlib.sha256()
        with file.open("rb") as stream:
            while chunk := stream.read(1024 * 1024):
                digest.update(chunk)
        entry.update(bytes=file.stat().st_size, sha256=digest.hexdigest(), url=url)
        if suffix == ".fbx":
            entry["mime"] = "application/octet-stream"
    return result
