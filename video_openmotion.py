"""Transfer one canvas export to a local OpenMotion workspace and back."""
from __future__ import annotations

import hashlib
import http.client
import json
import os
import re
import shutil
import tempfile
import zipfile
from urllib.parse import urlencode

from project_store import StoreError
from video_edit_document import EditDocumentError
from video_edit_ffmpeg import FFmpegError, probe


_UUID = re.compile(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}")
_SHA256 = re.compile(r"[0-9a-f]{64}")
_SOURCE = re.compile(r"assets/[0-9a-f]{64}\.mp4")
_ZIP_LIMIT = 500_000_000
_MP4_LIMIT = 2 * 1024 ** 3
_JSON_LIMIT = 8 * 1024 ** 2
_ACTIONS = {
    "create": {"assetPath"}, "link": {"remoteProjectId"}, "inspect": set(),
    "render": {"requestId", "audio", "versionId", "expectedRevision"}, "import": {"exportId", "revision"},
}


def _valid(pattern, value):
    return isinstance(value, str) and bool(pattern.fullmatch(value))


def _error(code, message, status=400):
    return StoreError(code, message, status)


def _rows(value):
    return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []


class OpenMotionClient:
    def __init__(self, configured_origin):
        if not configured_origin:
            raise _error("OPENMOTION_DISABLED", "请在工作台启动环境中设置 H3_OPENMOTION_ORIGIN，指向本机 OpenMotion Studio。", 503)
        match = re.fullmatch(r"http://127\.0\.0\.1:([0-9]{1,5})/?", configured_origin)
        if not match or not 1 <= int(match[1]) <= 65535:
            raise _error("OPENMOTION_CONFIG", "H3_OPENMOTION_ORIGIN 必须是 http://127.0.0.1:端口。", 503)
        self.port = int(match[1])
        self.origin = f"http://127.0.0.1:{self.port}"

    def request(self, method, route, *, body=None, content_type=None, length=None, read=None):
        # An explicit literal address and http.client keep this request off proxy
        # settings and prevent redirection to another process or network host.
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=120)
        headers = {"Origin": self.origin}
        if content_type:
            headers.update({"Content-Type": content_type, "Content-Length": str(length)})
        try:
            conn.request(method, route, body=body, headers=headers)
            with conn.getresponse() as response:
                if response.status not in (200, 201, 202):
                    raw = response.read(4096)
                    try:
                        failure = json.loads(raw)
                    except (UnicodeError, ValueError):
                        failure = None
                    reason = re.match(rb'\{"error":"([A-Z][A-Z0-9_]{2,60})(?=[:" ])', raw)
                    code = reason[1].decode('ascii') if reason else ""
                    if code in ("VERSION_CONFLICT", "REQUEST_ID_CONFLICT"):
                        raise _error("OPENMOTION_VERSION_CONFLICT", "OpenMotion 工程版本已变化，请刷新后重试。", 409)
                    if isinstance(failure, dict) and failure.get("applied") is False:
                        raise _error("OPENMOTION_REQUEST_REJECTED", f"OpenMotion 未应用此请求（HTTP {response.status}）。", 422)
                    detail = f"，{code}" if code else ""
                    raise _error("OPENMOTION_REMOTE", f"OpenMotion 未完成请求（HTTP {response.status}{detail}）。", 502)
                if read:
                    return read(response)
                raw = response.read(_JSON_LIMIT + 1)
                result = json.loads(raw) if len(raw) <= _JSON_LIMIT else None
                if not isinstance(result, dict) or result.get("error"):
                    raise _error("OPENMOTION_RESPONSE", "OpenMotion 返回了无效的响应。", 502)
                return result
        except (OSError, ValueError, http.client.HTTPException) as error:
            raise _error("OPENMOTION_UNAVAILABLE", "无法连接或读取本机 OpenMotion。请检查 Studio 后重试。", 503) from error
        finally:
            conn.close()

    def call(self, name, args):
        body = json.dumps({"name": name, "arguments": args}, ensure_ascii=False).encode("utf-8")
        return self.request("POST", "/motion-api/phase1/call", body=body, content_type="application/json", length=len(body))

    def get_project(self, project_id, export_id=None):
        args = {"projectId": project_id}
        if export_id:
            args["exportJobId"] = export_id
        detail = self.call("openmotion_get_project", args)
        if detail.get("projectId") != project_id or not _valid(_UUID, detail.get("sessionId")):
            raise _error("OPENMOTION_RESPONSE", "OpenMotion 工程身份无法核对。", 502)
        return detail

    def import_project(self, source, info, request_id):
        width, height = info["width"], info["height"]
        seconds = f'{float(info["duration"]):.9f}'.rstrip("0").rstrip(".")
        audio = 'data-has-audio="true" data-volume="1"' if info["audioOffset"] is not None else "muted"
        html = f'''<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>Refmuse 画布剪辑</title>
<style>html,body{{margin:0;background:#000}}#main{{position:relative;width:{width}px;height:{height}px}}#recording{{width:100%;height:100%;object-fit:contain}}</style></head>
<body><div id="main" data-composition-id="main" data-width="{width}" data-height="{height}" data-start="0" data-duration="{seconds}">
<video id="recording" class="clip" src="assets/recording.mp4" data-start="0" data-duration="{seconds}" data-track-index="0" {audio} playsinline></video>
</div><script>window.__timelines = {{}};</script></body></html>
'''
        # ZIP entries and their metadata must be repeatable for the request ID
        # to recover safely after a response is lost.
        folder = f"Refmuse {source.stem[:8]}"
        with tempfile.TemporaryFile() as archive:
            with zipfile.ZipFile(archive, "w", allowZip64=False) as package:
                package.writestr(zipfile.ZipInfo(f"{folder}/index.html"), html)
                media_entry = zipfile.ZipInfo(f"{folder}/assets/recording.mp4")
                with source.open("rb") as video, package.open(media_entry, "w") as member:
                    shutil.copyfileobj(video, member, 1024 * 1024)
            length = archive.tell()
            if length > _ZIP_LIMIT:
                raise _error("OPENMOTION_TOO_LARGE", "OpenMotion 工程包不能超过 500 MB。", 413)
            archive.seek(0)
            result = self.request("POST", "/motion-api/project-archives/import?" + urlencode({"requestId": request_id}),
                                  body=archive, content_type="application/zip", length=length)
        projects = result.get("projects")
        new_project = projects[0] if isinstance(projects, list) and len(projects) == 1 else None
        if not isinstance(new_project, dict) or not _valid(_UUID, new_project.get("projectId")):
            raise _error("OPENMOTION_RESPONSE", "OpenMotion 未返回导入的工程身份。", 502)
        return new_project["projectId"]

    def fetch_export(self, export_id, expected_sha256, target):
        def copy(response):
            if response.headers.get_content_type() != "video/mp4":
                raise _error("OPENMOTION_RESPONSE", "OpenMotion 导出的文件不是 MP4。", 502)
            if int(response.getheader("Content-Length", "0")) > _MP4_LIMIT:
                raise _error("OPENMOTION_TOO_LARGE", "回传成片不能超过 2 GB。", 413)
            digest = hashlib.sha256()
            size = 0
            while chunk := response.read(1024 * 1024):
                size += len(chunk)
                if size > _MP4_LIMIT:
                    raise _error("OPENMOTION_TOO_LARGE", "回传成片不能超过 2 GB。", 413)
                digest.update(chunk)
                target.write(chunk)
            if not size or digest.hexdigest() != expected_sha256:
                raise _error("OPENMOTION_HASH", "回传 MP4 与 OpenMotion 已校验的文件不一致。", 422)
            target.seek(0)

        self.request("GET", f"/api/exports/{export_id}/file", read=copy)


class OpenMotionBridge:
    def __init__(self, jobs):
        self.jobs = jobs

    @staticmethod
    def node_data(store, project_id, node_id):
        node = next((item for item in store.get(project_id)["canvas"]["nodes"]
                     if item.get("id") == node_id and item.get("type") == "videoEdit"), None)
        if node is None:
            raise _error("OPENMOTION_NODE", "找不到已保存的视频编辑节点。", 404)
        return node.get("data", {})

    @staticmethod
    def verified(job, project_id):
        verification = job.get("verification") if isinstance(job, dict) else None
        return (isinstance(verification, dict) and verification.get("status") == "passed"
                and _valid(_SHA256, verification.get("sha256")) and job.get("state") == "completed"
                and job.get("projectId") == project_id and _valid(_UUID, job.get("id")))

    @staticmethod
    def summary(client, detail):
        project_id, session_id = detail["projectId"], detail["sessionId"]
        jobs = _rows(detail.get("exports"))
        return {
            "remoteProjectId": project_id,
            "origin": client.origin,
            "versionId": detail.get("currentVersionId"),
            "expectedRevision": detail.get("revision"),
            "studioUrl": f"{client.origin}/?{urlencode({'session': session_id, 'project': project_id})}#project/{project_id}",
            "active": next(({"state": job.get("state"), "stage": job.get("stage")} for job in jobs
                            if job.get("state") in ("pending", "running", "cancelling")), None),
            "failed": bool(jobs and jobs[0].get("state") in ("failed", "cancelled")),
            "exports": [{"id": job["id"], "createdAt": job.get("createdAt"),
                         "current": job.get("versionId") == detail.get("currentVersionId")}
                        for job in jobs if OpenMotionBridge.verified(job, project_id)][:25],
        }

    @staticmethod
    def bound_project(data, origin):
        binding = data.get("openMotion")
        if not isinstance(binding, dict) or not _valid(_UUID, binding.get("remoteProjectId")) or binding.get("origin") != origin:
            raise _error("OPENMOTION_LINK", "请先关联当前本机 OpenMotion 工程。", 409)
        return binding["remoteProjectId"]

    def handle(self, action, payload):
        if set(payload) != {"projectId", "nodeId"} | _ACTIONS[action]:
            raise _error("BAD_REQUEST", "OpenMotion 请求字段无效。")
        project_id, node_id = self.jobs._identity(payload)
        client = OpenMotionClient(os.environ.get("H3_OPENMOTION_ORIGIN", "").strip())
        with self.jobs.lock:
            store = self.jobs.store
            data = self.node_data(store, project_id, node_id)
            if action != "inspect":
                path = store._project_path(project_id)
                store._require_writable(path)
                store.acquire_lock(path)
            if action == "create":
                asset = payload["assetPath"]
                if not _valid(_SOURCE, asset) or data.get("editResultAssetPath") != asset:
                    raise _error("OPENMOTION_SOURCE", "请先保存此节点导出的 MP4。", 409)
                source = store.asset_file(project_id, asset)
            elif action == "link":
                remote_id = payload["remoteProjectId"]
                if not _valid(_UUID, remote_id):
                    raise _error("BAD_REQUEST", "请输入本机 OpenMotion 工程的 UUID。")
            else:
                remote_id = self.bound_project(data, client.origin)

        if action == "create":
            if source.stat().st_size > _ZIP_LIMIT - 65_536:
                raise _error("OPENMOTION_TOO_LARGE", "OpenMotion 工程包不能超过 500 MB。", 413)
            try:
                info = probe(self.jobs.runner_factory(), source)
            except (FFmpegError, EditDocumentError) as error:
                raise _error("OPENMOTION_SOURCE", "无法读取画布导出的 MP4。", 422) from error
            if not info["frameCount"] or not 0 < info["duration"] <= 3600:
                raise _error("OPENMOTION_SOURCE", "请使用片长在一小时以内的 MP4。", 422)
            identity = f"{store.root}\n{project_id}\n{node_id}\n{asset}"
            request_id = "refmuse_" + hashlib.sha256(identity.encode("utf-8")).hexdigest()
            remote_id = client.import_project(source, info, request_id)

        if action == "import":
            return self.import_export(client, store, project_id, node_id, remote_id, payload)
        if action == "render":
            return self.render(client, remote_id, payload)

        detail = client.get_project(remote_id)
        summary = self.summary(client, detail)
        if action in ("create", "link"):
            catalog = client.call("openmotion_get_project", {"sessionId": detail["sessionId"]})
            title = next((item.get("title") for item in _rows(catalog.get("projects")) if item.get("id") == remote_id), None)
            summary["title"] = title[:180] if isinstance(title, str) else f"OpenMotion 工程 {remote_id[:8]}"
        with self.jobs.lock:
            if store is not self.jobs.store:
                raise _error("OPENMOTION_PROJECT_MOVED", "画布项目位置已切换，请重试。", 409)
        return summary

    @staticmethod
    def render(client, project_id, payload):
        request_id, audio = payload["requestId"], payload["audio"]
        revision, version_id = payload["expectedRevision"], payload["versionId"]
        if not _valid(_UUID, request_id) or audio not in ("required", "silent", "optional"):
            raise _error("BAD_REQUEST", "渲染请求或音轨设置无效。")
        if not _valid(_SHA256, revision) or not _valid(_UUID, version_id):
            raise _error("BAD_REQUEST", "渲染请求缺少有效的 OpenMotion 版本。")
        # OpenMotion compares the complete payload on replay. An already
        # accepted render can be recovered even after Studio saves another
        # version. A first submission against a stale version is rejected.
        result = client.call("openmotion_export_request", {"projectId": project_id, "requestId": request_id,
                             "versionId": version_id, "expectedRevision": revision, "audio": audio})
        job = result.get("job") or {}
        if result.get("projectId") != project_id or not _valid(_UUID, job.get("id")):
            raise _error("OPENMOTION_RESPONSE", "OpenMotion 渲染任务身份无法核对。", 502)
        return {"remoteProjectId": project_id, "active": {"state": job.get("state"), "stage": job.get("stage")}, "renderId": job["id"]}

    def import_export(self, client, store, project_id, node_id, remote_id, payload):
        export_id, revision = payload["exportId"], payload["revision"]
        if not _valid(_UUID, export_id) or type(revision) is not int or revision < 1:
            raise _error("BAD_REQUEST", "回传任务 ID 或画布版本无效。")
        job = client.get_project(remote_id, export_id).get("exportJob")
        if not self.verified(job, remote_id) or job.get("id") != export_id:
            raise _error("OPENMOTION_UNVERIFIED", "请选择已完成且通过技术校验的 OpenMotion 成片。", 409)
        with tempfile.TemporaryFile() as video:
            client.fetch_export(export_id, job["verification"]["sha256"], video)
            with self.jobs.lock:
                if store is not self.jobs.store:
                    raise _error("OPENMOTION_PROJECT_MOVED", "画布项目位置已切换，请重试。", 409)
                data = self.node_data(store, project_id, node_id)
                if self.bound_project(data, client.origin) != remote_id:
                    raise _error("OPENMOTION_LINK", "关联的 OpenMotion 工程已改变，请重新选择成片。", 409)
                return store.put_asset(project_id, f"openmotion-{export_id[:8]}.mp4", video, "video/mp4", expected_revision=revision)
