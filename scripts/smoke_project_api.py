from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from scripts.smoke_lifecycle import wait_for_instance


def call(base, method, path, payload=None, headers=None):
    request_headers = dict(headers or {})
    if isinstance(payload, (dict, list)):
        payload = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        request_headers["Content-Type"] = "application/json"
    request = urllib.request.Request(base + path, data=payload, method=method, headers=request_headers)
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            body = response.read()
            return response.status, dict(response.headers), json.loads(body) if body and response.headers.get("Content-Type", "").startswith("application/json") else body
    except urllib.error.HTTPError as error:
        body = error.read()
        return error.code, dict(error.headers), json.loads(body) if body else None


def main():
    with tempfile.TemporaryDirectory(prefix="h3-project-api-") as temporary:
        runtime = Path(temporary) / "runtime"
        projects = Path(temporary) / "projects"
        environment = os.environ.copy()
        environment.update(H3_WORKBENCH_RUNTIME_DIR=str(runtime), H3_PROJECTS_ROOT=str(projects), H3_WORKBENCH_NO_BROWSER="1")
        process = subprocess.Popen([sys.executable, str(ROOT / "video_workbench_launcher.py")], cwd=ROOT, env=environment)
        try:
            instance, _ = wait_for_instance(runtime / "instance.json", process)
            base = f"http://127.0.0.1:{instance['port']}"
            status, _, document = call(base, "POST", "/api/projects", {"name": "接口项目", "template": "blank"})
            assert status == 201 and document["schemaVersion"] == 3
            project_id = document["id"]
            status, _, rows = call(base, "GET", "/api/projects")
            assert status == 200 and len(rows["projects"]) == 1
            updated = dict(document, name="接口项目-已保存")
            status, _, saved = call(base, "PUT", f"/api/projects/{project_id}", updated, {"If-Match": "1"})
            assert status == 200 and saved["revision"] == 2
            status, _, conflict = call(base, "PUT", f"/api/projects/{project_id}", document, {"If-Match": "1"})
            assert status == 409 and conflict["code"] == "REVISION_CONFLICT"
            external = dict(saved, name="外部修改", revision=3)
            (projects / "接口项目" / "project.json").write_text(json.dumps(external, ensure_ascii=False), encoding="utf-8")
            status, _, external_conflict = call(base, "PUT", f"/api/projects/{project_id}", saved, {"If-Match": "2"})
            assert status == 409 and external_conflict["details"]["revision"] == 3
            status, _, asset = call(base, "PUT", f"/api/projects/{project_id}/assets/{urllib.parse.quote('参考.png')}", b"0123456789", {"Content-Type": "image/png"})
            assert status == 201
            name = asset["asset"]["path"].split("/", 1)[1]
            status, headers, body = call(base, "GET", f"/api/projects/{project_id}/assets/{name}", headers={"Range": "bytes=2-5"})
            assert status == 206 and body == b"2345" and headers["Content-Range"] == "bytes 2-5/10"
            status, _, missing = call(base, "GET", f"/api/projects/{project_id}/assets/..%2Fsecret")
            assert status == 400
            status, _, exported = call(base, "POST", f"/api/projects/{project_id}/export", {})
            assert status == 200
            package = Path(temporary) / "package.zip"
            shutil.copy2(exported["path"], package)
            status, _, backup = call(base, "POST", "/api/projects/migration-backup", package.read_bytes(), {"Content-Type": "application/zip"})
            assert status == 201 and Path(backup["path"]).is_file()
            status, _, deleted = call(base, "DELETE", f"/api/projects/{project_id}")
            assert status == 200 and deleted["deleted"]
            status, _, trash = call(base, "GET", "/api/projects/trash")
            assert status == 200 and len(trash["projects"]) == 1
            status, _, restored = call(base, "POST", "/api/projects/restore", {"name": trash["projects"][0]["trashName"]})
            assert status == 200 and restored["id"] == project_id
            status, _, deleted = call(base, "DELETE", f"/api/projects/{project_id}")
            assert status == 200
            status, _, imported = call(base, "POST", "/api/projects/import", {"path": str(package)})
            assert status == 201 and imported["id"] == project_id
            status, _, duplicate = call(base, "POST", f"/api/projects/{project_id}/duplicate", {})
            assert status == 201 and duplicate["id"] != project_id
            status, _, video_project = call(base, "POST", "/api/projects", {"name": "大视频", "template": "blank"})
            assert status == 201
            large = Path(temporary) / "large.mp4"
            with large.open("wb") as output:
                output.truncate(200 * 1024 * 1024)
            with large.open("rb") as source:
                status, _, video_asset = call(base, "PUT", f"/api/projects/{video_project['id']}/assets/large.mp4", source, {"Content-Type": "video/mp4", "Content-Length": str(large.stat().st_size)})
            assert status == 201 and video_asset["asset"]["bytes"] == 200 * 1024 * 1024
            video_name = video_asset["asset"]["path"].split("/", 1)[1]
            status, headers, body = call(base, "GET", f"/api/projects/{video_project['id']}/assets/{video_name}", headers={"Range": "bytes=150000000-150000015"})
            assert status == 206 and body == bytes(16) and headers["Content-Range"] == f"bytes 150000000-150000015/{200 * 1024 * 1024}"
            stopped = subprocess.run([sys.executable, str(ROOT / "stop.py")], cwd=ROOT, env=environment, timeout=15)
            assert stopped.returncode == 0 and process.wait(timeout=10) == 0
            listed = subprocess.run([sys.executable, str(ROOT / "h3wb.py"), "--root", str(projects), "list", "--json"], capture_output=True, text=True, encoding="utf-8", timeout=15)
            assert listed.returncode == 0 and len(json.loads(listed.stdout)) == 3
            created = subprocess.run([sys.executable, str(ROOT / "h3wb.py"), "--root", str(projects), "new", "CLI项目", "--template", "outfit"], capture_output=True, text=True, encoding="utf-8", timeout=15)
            assert created.returncode == 0 and json.loads(created.stdout)["ok"]
            validated = subprocess.run([sys.executable, str(ROOT / "h3wb.py"), "validate", str(projects / "CLI项目")], capture_output=True, text=True, encoding="utf-8", timeout=15)
            assert validated.returncode == 0 and json.loads(validated.stdout)["schemaVersion"] == 3
            print(json.dumps({"ok": True, "crud": True, "conflict409": True, "range206": True, "range200MB": True, "importExport": True, "cli": True}, ensure_ascii=False))
        finally:
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=5)


if __name__ == "__main__":
    main()
