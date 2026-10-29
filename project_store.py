from __future__ import annotations

import datetime as dt
import hashlib
import json
import mimetypes
import os
import re
import shutil
import threading
import time
import uuid
import zipfile
from pathlib import Path, PurePosixPath

from scripts.validate_project import validate_project
from workbench_lifecycle import APP_VERSION, atomic_write_json, utc_now

MAX_ASSET_BYTES = 2 * 1024 * 1024 * 1024
ASSET_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".mp4", ".mov", ".webm", ".mp3", ".wav", ".m4a", ".aac"}
INVALID_NAME = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
RESERVED_NAMES = {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}


class StoreError(Exception):
    def __init__(self, code, message, status=400, details=None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status
        self.details = details or {}


class RevisionConflict(StoreError):
    def __init__(self, revision, conflict):
        super().__init__("REVISION_CONFLICT", "项目已被其他窗口更新，修改已保存为冲突副本。", 409, {"revision": revision, "conflict": conflict})


def default_projects_root():
    configured = os.environ.get("H3_PROJECTS_ROOT")
    if configured:
        return Path(configured)
    return Path(os.environ.get("USERPROFILE", str(Path.home()))) / "Documents" / "H3 Workbench"


def validate_name(name):
    name = str(name or "").strip()
    if not name or len(name) > 80 or INVALID_NAME.search(name) or name.endswith((" ", ".")) or name.split(".")[0].upper() in RESERVED_NAMES:
        raise StoreError("BAD_REQUEST", "项目名称不能为空，且不能包含 Windows 非法字符或以空格、点结尾。")
    return name


def new_document(name, canvas=None, template="blank", defaults=None):
    now = utc_now()
    settings = {"ratio": "16:9", "resolution": "480P", "duration": 5}
    if defaults:
        settings.update({key: defaults[key] for key in ("ratio", "resolution", "duration") if key in defaults})
    settings["template"] = template
    document = {
        "schemaVersion": 3,
        "id": f"prj_{uuid.uuid4().hex}",
        "name": validate_name(name),
        "revision": 1,
        "createdAt": now,
        "updatedAt": now,
        "appVersion": APP_VERSION,
        "settings": settings,
        "characters": [], "outfits": [], "locations": [], "shots": [],
        "canvas": canvas or {"nodes": [], "edges": [], "viewport": {"x": 0, "y": 0, "zoom": 1}},
        "assets": [],
    }
    from agent_handles import ensure_agent_handles
    ensure_agent_handles(document)
    return document


def _validated(document):
    errors = validate_project(document)
    if errors:
        raise StoreError("BAD_REQUEST", "project.json 校验失败，已拒绝打开或保存。", details={"errors": errors})
    return document


def _migrate(document):
    if document.get("schemaVersion") == 3:
        from agent_handles import ensure_agent_handles
        changed = ensure_agent_handles(document)
        return _validated(document), changed
    if document.get("schemaVersion") not in (None, 1, 2):
        raise StoreError("BAD_REQUEST", "不支持的项目 schema 版本，未修改原文件。")
    canvas = document.get("canvas")
    if not isinstance(canvas, dict) or not isinstance(canvas.get("nodes"), list) or not isinstance(canvas.get("edges", []), list):
        raise StoreError("BAD_REQUEST", "旧项目缺少有效画布，未修改原文件。")
    now = utc_now()
    migrated = {
        "schemaVersion": 3,
        "id": str(document.get("id") or f"prj_{uuid.uuid4().hex}"),
        "name": validate_name(document.get("name") or "导入项目"),
        "revision": max(1, int(document.get("revision") or 0) + 1),
        "createdAt": _iso_time(document.get("createdAt")) or now,
        "updatedAt": now,
        "appVersion": APP_VERSION,
        "settings": {"ratio": "16:9", "resolution": "480P", "duration": 5},
        "characters": [], "outfits": [], "locations": [], "shots": [],
        "canvas": {"nodes": canvas["nodes"], "edges": canvas.get("edges", []), "viewport": canvas.get("viewport", {"x": 0, "y": 0, "zoom": 1})},
        "assets": document.get("assets", []),
    }
    if not migrated["id"].startswith("prj_"):
        migrated["id"] = f"prj_{uuid.uuid4().hex}"
    from agent_handles import ensure_agent_handles
    ensure_agent_handles(migrated)
    return _validated(migrated), True


def _iso_time(value):
    if isinstance(value, str) and value:
        return value
    if isinstance(value, (int, float)):
        return dt.datetime.fromtimestamp(value / 1000, dt.timezone.utc).isoformat()
    return None


def _writer_running(pid):
    if pid == os.getpid():
        return True
    if os.name == "nt":
        import ctypes
        kernel = ctypes.windll.kernel32
        kernel.OpenProcess.restype = ctypes.c_void_p
        handle = kernel.OpenProcess(0x00100000, False, pid)  # SYNCHRONIZE
        if not handle:
            return False
        try:
            return kernel.WaitForSingleObject(handle, 0) == 0x00000102  # WAIT_TIMEOUT
        finally:
            kernel.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def _safe_project_file(path):
    path = path.resolve()
    for temporary in path.parent.glob(f".{path.name}.*.tmp"):
        match = re.fullmatch(rf"\.{re.escape(path.name)}\.(\d+)\.tmp", temporary.name)
        if match and not _writer_running(int(match.group(1))):
            # A killed writer cannot finish os.replace; its committed JSON and
            # backups remain intact, so only the abandoned temporary is removed.
            temporary.unlink(missing_ok=True)
    if not path.is_file():
        raise StoreError("NOT_FOUND", "项目不存在或尚未打开。", 404)
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise StoreError("BAD_REQUEST", f"project.json 无法读取：{exc}") from exc
    return path, document


class ProjectStore:
    def __init__(self, root=None, owner_id=None, defaults=None):
        self.root = Path(root or default_projects_root()).resolve()
        self.owner_id = owner_id or f"backend-{os.getpid()}-{uuid.uuid4().hex[:8]}"
        self.defaults = dict(defaults or {})
        self._locks = {}
        self._locks_guard = threading.Lock()
        self._held = set()
        self._opened_paths = {}
        self._read_only = set()
        self._heartbeat_stop = threading.Event()
        self._heartbeat_thread = None

    def _guard(self, path):
        key = str(path.resolve()).lower()
        with self._locks_guard:
            return self._locks.setdefault(key, threading.RLock())

    def _project_path(self, project_id):
        if not re.fullmatch(r"prj_[A-Za-z0-9_-]+", str(project_id)):
            raise StoreError("BAD_REQUEST", "项目 ID 无效。")
        if self.root.is_dir():
            for candidate in self.root.iterdir():
                path = candidate / "project.json"
                if not candidate.is_dir() or candidate.name.startswith(".") or not path.is_file():
                    continue
                try:
                    document = json.loads(path.read_text(encoding="utf-8"))
                except (OSError, UnicodeError, json.JSONDecodeError):
                    continue
                if document.get("id") == project_id:
                    return path
        external = self._opened_paths.get(project_id)
        if external and external.is_file():
            return external
        raise StoreError("NOT_FOUND", "项目不存在或尚未打开。", 404)

    def _read(self, path, migrate=True):
        path, document = _safe_project_file(path)
        document, changed = _migrate(document) if migrate else (document, False)
        if changed:
            backup = path.parent / "backups" / f"project-r{document['revision'] - 1}-before-v3.json"
            backup.parent.mkdir(parents=True, exist_ok=True)
            if not backup.exists():
                shutil.copy2(path, backup)
            atomic_write_json(path, document)
        return document

    def _write(self, path, document, expected_revision=None, backup=True):
        with self._guard(path):
            _, current = _safe_project_file(path)
            current_revision = int(current.get("revision", 0))
            if expected_revision is not None and current_revision != expected_revision:
                conflict = path.parent / f".conflict-{time.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:6]}.json"
                atomic_write_json(conflict, document)
                raise RevisionConflict(current_revision, conflict.name)
            document = dict(document)
            document["revision"] = current_revision + 1
            document["updatedAt"] = utc_now()
            document["appVersion"] = APP_VERSION
            _validated(document)
            if backup:
                backup_path = path.parent / "backups" / f"project-r{current_revision}.json"
                backup_path.parent.mkdir(parents=True, exist_ok=True)
                atomic_write_json(backup_path, current)
            atomic_write_json(path, document)
            backups = sorted(path.parent.glob("backups/project-r*.json"), key=lambda item: item.stat().st_mtime, reverse=True)
            for old in backups[20:]:
                old.unlink(missing_ok=True)
            return document

    def create(self, name, canvas=None, template="blank", directory=None):
        document = new_document(name, canvas, template, self.defaults)
        path = Path(directory).expanduser() if directory else self.root / document["name"]
        if not path.is_absolute():
            path = self.root / path
        path = path.resolve()
        if path == self.root or path.exists():
            raise StoreError("BAD_REQUEST", "同名项目或目标文件夹已存在，未覆盖任何内容。")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.mkdir()
        for child in ("assets", "backups", "outputs", "exports", ".cache"):
            (path / child).mkdir()
        atomic_write_json(path / "project.json", document)
        return document

    def list(self):
        if not self.root.is_dir():
            return []
        rows = []
        for candidate in self.root.iterdir():
            path = candidate / "project.json"
            if not candidate.is_dir() or candidate.name.startswith(".") or not path.is_file():
                continue
            try:
                document = self._read(path)
                size = sum(item.stat().st_size for item in candidate.rglob("*") if item.is_file() and ".lock" not in item.parts)
                rows.append(self.summary(document, candidate, size))
            except StoreError as exc:
                rows.append({"id": None, "name": candidate.name, "path": str(candidate), "invalid": True, "error": exc.message})
        return sorted(rows, key=lambda item: item.get("updatedAt", ""), reverse=True)

    @staticmethod
    def summary(document, path, size=0):
        cover = next((node.get("data", {}).get("assetPath") for node in document["canvas"]["nodes"]
                      if node.get("type") == "media" and node.get("data", {}).get("kind") == "image"
                      and node.get("data", {}).get("assetPath")), None)
        return {
            "id": document["id"], "name": document["name"], "path": str(path),
            "createdAt": document["createdAt"], "updatedAt": document["updatedAt"], "revision": document["revision"],
            "nodeCount": len(document["canvas"]["nodes"]), "edgeCount": len(document["canvas"]["edges"]),
            "shotCount": len(document["shots"]), "bytes": size,
            "thumbnail": f"/api/projects/{document['id']}/{cover}" if cover else None,
        }

    def get(self, project_id):
        path = self._project_path(project_id)
        return self._read(path)

    def _set_read_only(self, path, read_only):
        path = Path(path).resolve()
        owns_lock = any(lock_path == path.parent / ".lock" and owner == self.owner_id for lock_path, owner in self._held)
        if read_only and not owns_lock:
            self._read_only.add(path)
        elif not read_only:
            self._read_only.discard(path)

    def _require_writable(self, path):
        if Path(path).resolve() in self._read_only:
            raise StoreError("READ_ONLY", "当前项目以只读方式打开，服务端已拒绝写操作。", 403)

    def open(self, project_id, owner_id=None, read_only=False):
        path = self._project_path(project_id)
        self._set_read_only(path, read_only)
        if not read_only:
            self.acquire_lock(path, owner_id)
        return self._read(path)

    def open_path(self, directory, owner_id=None, read_only=False):
        path = (Path(directory).expanduser().resolve() / "project.json")
        document = self._read(path)
        self._set_read_only(path, read_only)
        if not read_only:
            self.acquire_lock(path, owner_id)
        self._opened_paths[document["id"]] = path
        return document

    def save(self, project_id, document, expected_revision):
        path = self._project_path(project_id)
        self._require_writable(path)
        self.acquire_lock(path)
        if str(document.get("id")) != project_id or document.get("schemaVersion") != 3:
            raise StoreError("BAD_REQUEST", "项目 ID 或 schema 版本不一致。")
        return self._write(path, document, int(expected_revision))

    def release(self, project_id):
        path = self._project_path(project_id)
        lock_path = path.parent / ".lock"
        with self._guard(path):
            for held_path, owner in list(self._held):
                if held_path != lock_path:
                    continue
                try:
                    lock = json.loads(lock_path.read_text(encoding="utf-8"))
                    if lock.get("owner") == owner:
                        lock_path.unlink(missing_ok=True)
                except (OSError, UnicodeError, json.JSONDecodeError):
                    pass
                self._held.discard((held_path, owner))
            self._read_only.discard(path.resolve())
        return {"closed": True, "id": project_id}

    def acquire_lock(self, path, owner_id=None):
        owner = owner_id or self.owner_id
        path = Path(path).resolve()
        with self._guard(path):
            lock_path = path.parent / ".lock"
            now = time.time()
            try:
                lock = json.loads(lock_path.read_text(encoding="utf-8"))
            except (OSError, UnicodeError, json.JSONDecodeError):
                lock = None
            if lock and lock.get("owner") != owner:
                fresh = now - float(lock.get("heartbeat", 0)) < 30
                try:
                    owner_alive = _writer_running(int(lock.get("pid", 0)))
                except (TypeError, ValueError):
                    owner_alive = False
                if fresh or owner_alive:
                    raise StoreError("LOCKED", "项目正由另一个实例编辑，请以只读方式打开。", 423, {"owner": lock.get("owner")})
            atomic_write_json(lock_path, {"owner": owner, "pid": os.getpid(), "heartbeat": now})
            self._held.add((lock_path, owner))
            if not self._heartbeat_thread or not self._heartbeat_thread.is_alive():
                self._heartbeat_stop.clear()
                self._heartbeat_thread = threading.Thread(target=self._heartbeat, daemon=True)
                self._heartbeat_thread.start()
            return {"owner": owner, "heartbeat": now, "readOnly": False}

    def _heartbeat(self):
        while not self._heartbeat_stop.wait(10):
            for lock_path, owner in list(self._held):
                try:
                    lock = json.loads(lock_path.read_text(encoding="utf-8"))
                    if lock.get("owner") == owner:
                        atomic_write_json(lock_path, {**lock, "heartbeat": time.time()})
                except (OSError, UnicodeError, json.JSONDecodeError):
                    continue

    def close(self):
        self._heartbeat_stop.set()
        for lock_path, owner in list(self._held):
            try:
                lock = json.loads(lock_path.read_text(encoding="utf-8"))
                if lock.get("owner") == owner:
                    lock_path.unlink(missing_ok=True)
            except (OSError, UnicodeError, json.JSONDecodeError):
                pass
        self._held.clear()

    def duplicate(self, project_id):
        source = self._project_path(project_id).parent
        document = self._read(source / "project.json")
        target = (source.parent / f"{document['name']} 副本").resolve()
        if target.exists():
            raise StoreError("BAD_REQUEST", "副本文件夹已存在。")
        shutil.copytree(source, target, ignore=shutil.ignore_patterns(".lock", ".conflict-*", "exports"))
        document.update(id=f"prj_{uuid.uuid4().hex}", name=validate_name(document["name"] + " 副本"), revision=1, createdAt=utc_now(), updatedAt=utc_now())
        atomic_write_json(target / "project.json", document)
        for backup in (target / "backups").glob("*.json"):
            backup.unlink()
        return document

    def delete(self, project_id):
        source = self._project_path(project_id).parent
        trash = self.root / ".trash"
        trash.mkdir(parents=True, exist_ok=True)
        target = trash / f"{source.name}-{int(time.time())}-{uuid.uuid4().hex[:6]}"
        shutil.move(str(source), str(target))
        return {"deleted": True, "trashPath": str(target), "restoreAfter": None}

    def restore(self, trash_name):
        if Path(trash_name).name != trash_name or not trash_name:
            raise StoreError("BAD_REQUEST", "回收站项目名无效。")
        source = self.root / ".trash" / trash_name
        document = self._read(source / "project.json")
        target = self.root / document["name"]
        if target.exists():
            raise StoreError("BAD_REQUEST", "原位置已有同名项目，未覆盖。")
        shutil.move(str(source), str(target))
        return self._read(target / "project.json")

    def list_trash(self):
        trash = self.root / ".trash"
        if not trash.is_dir():
            return []
        rows = []
        for candidate in trash.iterdir():
            try:
                document = self._read(candidate / "project.json")
                size = sum(item.stat().st_size for item in candidate.rglob("*") if item.is_file() and ".lock" not in item.parts)
                rows.append({**self.summary(document, candidate, size), "trashName": candidate.name,
                             "deletedAt": dt.datetime.fromtimestamp(candidate.stat().st_mtime, dt.timezone.utc).isoformat()})
            except StoreError:
                continue
        return sorted(rows, key=lambda item: item["deletedAt"], reverse=True)

    def purge_trash(self, days=30):
        cutoff = time.time() - days * 86400
        removed = []
        trash = self.root / ".trash"
        if trash.is_dir():
            for item in trash.iterdir():
                if item.is_dir() and item.stat().st_mtime < cutoff:
                    shutil.rmtree(item)
                    removed.append(item.name)
        return removed

    def put_asset(self, project_id, filename, source, content_type=None):
        path = self._project_path(project_id)
        self._require_writable(path)
        self.acquire_lock(path)
        extension = Path(filename).suffix.lower()
        if extension not in ASSET_EXTENSIONS:
            raise StoreError("UNSUPPORTED_MEDIA", "素材类型不在白名单内。", 415)
        assets = path.parent / "assets"
        temporary = assets / f".upload-{uuid.uuid4().hex}.tmp"
        assets.mkdir(exist_ok=True)
        digest = hashlib.sha256()
        size = 0
        try:
            with temporary.open("wb") as target:
                while True:
                    chunk = source.read(1024 * 1024)
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > MAX_ASSET_BYTES:
                        raise StoreError("BAD_REQUEST", "单个素材不能超过 2 GB。")
                    digest.update(chunk)
                    target.write(chunk)
                target.flush()
                os.fsync(target.fileno())
            sha256 = digest.hexdigest()
            relative = f"assets/{sha256}{extension}"
            final = path.parent / relative
            if final.exists():
                temporary.unlink()
            else:
                os.replace(temporary, final)
            document = self._read(path)
            if not any(item["path"] == relative for item in document["assets"]):
                document["assets"].append({"path": relative, "sha256": sha256, "bytes": size, "mime": content_type or mimetypes.guess_type(filename)[0] or "application/octet-stream"})
                document = self._write(path, document, document["revision"])
            return {"asset": next(item for item in document["assets"] if item["path"] == relative), "revision": document["revision"]}
        finally:
            temporary.unlink(missing_ok=True)

    @staticmethod
    def _asset_references(document):
        references = set()

        def walk(value):
            if isinstance(value, dict):
                for child in value.values():
                    walk(child)
            elif isinstance(value, list):
                for child in value:
                    walk(child)
            elif isinstance(value, str):
                match = re.search(r"(?:^|/)(assets/[0-9a-f]{64}\.[a-z0-9]+)(?=$|[?#])", value.replace("\\", "/"), re.IGNORECASE)
                if match:
                    references.add(match.group(1).lower())

        for key, value in document.items():
            # The asset catalogue records uploads, not canvas references.
            if key != "assets":
                walk(value)
        return references

    def collect_orphans(self, project_id, dry_run=True, min_age_days=30):
        try:
            age = float(min_age_days)
        except (TypeError, ValueError) as exc:
            raise StoreError("BAD_REQUEST", "孤儿素材保留天数必须是数字。") from exc
        if not 0 <= age <= 3650:
            raise StoreError("BAD_REQUEST", "孤儿素材保留天数必须在 0–3650 之间。")
        path = self._project_path(project_id)
        self.acquire_lock(path)
        with self._guard(path):
            document = self._read(path)
            protected = self._asset_references(document)
            history = list((path.parent / "backups").glob("*.json")) + list(path.parent.glob(".conflict-*.json"))
            for historical in history:
                try:
                    protected.update(self._asset_references(json.loads(historical.read_text(encoding="utf-8"))))
                except (OSError, UnicodeError, json.JSONDecodeError) as exc:
                    raise StoreError("BAD_REQUEST", f"历史副本 {historical.name} 无法读取，已中止素材清理。") from exc
            cutoff = time.time() - age * 86400
            candidates = []
            for file_path in (path.parent / "assets").iterdir():
                if not re.fullmatch(r"[0-9a-f]{64}\.[a-z0-9]+", file_path.name, re.IGNORECASE):
                    continue
                if file_path.is_symlink() or not file_path.is_file():
                    continue
                relative = f"assets/{file_path.name}".lower()
                if relative in protected:
                    continue
                stat = file_path.stat()
                if stat.st_mtime > cutoff:
                    continue
                candidates.append({"path": f"assets/{file_path.name}", "bytes": stat.st_size})
            candidates.sort(key=lambda item: item["path"])
            result = {
                "dryRun": bool(dry_run), "minAgeDays": age, "protected": len(protected),
                "candidates": candidates, "bytes": sum(item["bytes"] for item in candidates),
                "removed": [], "errors": [], "revision": document["revision"],
            }
            if dry_run or not candidates:
                return result
            removed_paths = set()
            for candidate in candidates:
                try:
                    (path.parent / candidate["path"]).unlink()
                    removed_paths.add(candidate["path"])
                    result["removed"].append(candidate)
                except OSError as exc:
                    result["errors"].append({**candidate, "error": str(exc)})
            if removed_paths:
                document["assets"] = [item for item in document["assets"] if item["path"] not in removed_paths]
                document = self._write(path, document, document["revision"])
                result["revision"] = document["revision"]
            result["bytes"] = sum(item["bytes"] for item in result["removed"])
            return result

    def asset_file(self, project_id, relative):
        path = self._project_path(project_id)
        pure = PurePosixPath(str(relative).replace("\\", "/"))
        if pure.is_absolute() or ".." in pure.parts or len(pure.parts) != 2 or pure.parts[0] != "assets":
            raise StoreError("BAD_REQUEST", "素材路径无效。", 400)
        file_path = (path.parent / pure).resolve()
        if file_path.parent != (path.parent / "assets").resolve() or not file_path.is_file() or file_path.is_symlink():
            raise StoreError("NOT_FOUND", "素材不存在。", 404)
        return file_path

    @staticmethod
    def range_response(file_path, range_header=None):
        size = file_path.stat().st_size
        start, end = 0, size - 1
        status = 200
        if range_header:
            match = re.fullmatch(r"bytes=(\d*)-(\d*)", range_header.strip())
            if not match or (not match.group(1) and not match.group(2)):
                raise StoreError("BAD_REQUEST", "Range 请求无效。", 400)
            if not match.group(1):
                length = int(match.group(2))
                if length <= 0:
                    raise StoreError("BAD_REQUEST", "Range 请求无效。", 400)
                start = max(0, size - length)
            else:
                start = int(match.group(1))
                if match.group(2):
                    end = int(match.group(2))
            if start >= size or end < start:
                raise StoreError("BAD_REQUEST", "Range 超出文件范围。", 416, {"contentRange": f"bytes */{size}"})
            end = min(end, size - 1)
            status = 206
        length = max(0, end - start + 1)
        headers = {"Accept-Ranges": "bytes", "Content-Length": str(length), "Content-Type": mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"}
        if status == 206:
            headers["Content-Range"] = f"bytes {start}-{end}/{size}"
        return status, headers, start, length

    def export(self, project_id):
        path = self._project_path(project_id)
        document = self._read(path)
        exports = path.parent / "exports"
        exports.mkdir(exist_ok=True)
        target = exports / f"{document['name']}-r{document['revision']}.zip"
        with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.write(path, "project.json")
            for folder in ("assets", "outputs"):
                base = path.parent / folder
                if base.is_dir():
                    for item in base.rglob("*"):
                        if item.is_file() and not item.is_symlink():
                            archive.write(item, item.relative_to(path.parent).as_posix())
        return target

    def import_zip(self, archive_path):
        archive_path = Path(archive_path).resolve()
        with zipfile.ZipFile(archive_path) as archive:
            members = archive.infolist()
            if "project.json" not in archive.namelist():
                raise StoreError("BAD_REQUEST", "项目包缺少 project.json。")
            total = 0
            for member in members:
                pure = PurePosixPath(member.filename)
                mode = member.external_attr >> 16
                windows_drive = re.match(r"^[A-Za-z]:", member.filename)
                if (
                    pure.is_absolute() or ".." in pure.parts or not pure.parts
                    or "\\" in member.filename or member.filename.startswith("/") or windows_drive
                    or (mode & 0o170000) == 0o120000
                ):
                    raise StoreError("BAD_REQUEST", "项目包包含不安全路径。")
                total += member.file_size
                if total > MAX_ASSET_BYTES * 4:
                    raise StoreError("BAD_REQUEST", "项目包超过导入大小限制。")
            document = json.loads(archive.read("project.json").decode("utf-8"))
            document, _ = _migrate(document)
            target = (self.root / document["name"]).resolve()
            if self.root not in target.parents or target.exists():
                raise StoreError("BAD_REQUEST", "导入目标无效或同名项目已存在。")
            temporary = self.root / f".import-{uuid.uuid4().hex}"
            temporary_root = temporary.resolve()
            try:
                for member in members:
                    if member.is_dir():
                        continue
                    destination = (temporary / PurePosixPath(member.filename)).resolve()
                    if destination == temporary_root or temporary_root not in destination.parents:
                        raise StoreError("BAD_REQUEST", "项目包成员落点超出导入目录。")
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    with archive.open(member) as source, destination.open("wb") as output:
                        shutil.copyfileobj(source, output, 1024 * 1024)
                for folder in ("assets", "backups", "outputs", "exports", ".cache"):
                    (temporary / folder).mkdir(exist_ok=True)
                document["updatedAt"] = utc_now()
                _validated(document)
                atomic_write_json(temporary / "project.json", document)
                os.replace(temporary, target)
                return document
            finally:
                if temporary.exists():
                    shutil.rmtree(temporary)
