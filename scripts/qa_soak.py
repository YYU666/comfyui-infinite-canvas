"""Reproducible isolated scale/soak acceptance for H3 Workbench.

Creates synthetic projects and media only below --root. The fake upstream never
runs ComfyUI or submits GPU work. A normal invocation still takes eight hours:

    python scripts/qa_soak.py --root .qa-soak

Use tiny --hours/--projects/--asset-total-bytes values only for a script smoke
test; such a run is not release acceptance.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import http.client
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import sysconfig
import threading
import time
import traceback
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import psutil


MIB = 1024 * 1024
GIB = 1024 ** 3


def utc_now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temporary, path)


def percentile95(values):
    if not values:
        return None
    ordered = sorted(values)
    return ordered[max(0, math.ceil(len(ordered) * 0.95) - 1)]


class FakeComfyHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path == "/queue":
            body = b'{"queue_running":[],"queue_pending":[]}'
        elif path == "/system_stats":
            body = b'{"system":{"os":"nt"},"devices":[]}'
        else:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


class Soak:
    def __init__(self, args):
        self.args = args
        self.root = args.root.resolve()
        self.workbench = Path(__file__).resolve().parent.parent
        # Windows venv launchers may create a child with a different PID. The
        # backend must use the base interpreter so health/PID checks stay exact.
        self.python = getattr(sys, "_base_executable", sys.executable)
        self.runtime = self.root / "runtime"
        self.projects = self.root / "projects"
        self.progress_path = self.root / "progress.json"
        self.report_path = self.root / "report.json"
        self.samples_path = self.root / "samples.jsonl"
        self.backend_log_path = self.root / "backend.log"
        self.fake = None
        self.backend = None
        self.backend_log = None
        self.instance = None
        self.origin = None
        self.token = None
        self.env = None
        self.projects_info = {}
        self.list_latencies = []
        self.save_latencies = []
        self.recoveries = []
        self.orphan = None
        self.started_monotonic = None
        self.next_restart = None
        self.initial_revisions = {}

    def progress(self, **values):
        write_json(self.progress_path, {"updatedAt": utc_now(), **values})

    def request(self, method, path, payload=None, timeout=60):
        body = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers = {"X-H3-Token": self.token}
        if body is not None:
            headers["Content-Type"] = "application/json"
        connection = http.client.HTTPConnection("127.0.0.1", self.instance["port"], timeout=timeout)
        try:
            connection.request(method, path, body=body, headers=headers)
            response = connection.getresponse()
            data = response.read()
        finally:
            connection.close()
        if not 200 <= response.status < 300:
            raise RuntimeError(f"{method} {path}: HTTP {response.status}: {data[:1000]!r}")
        return json.loads(data) if data else None

    def upload(self, project_id, size, seed):
        path = f"/api/projects/{project_id}/assets/synthetic-{seed}.mp4"
        connection = http.client.HTTPConnection("127.0.0.1", self.instance["port"], timeout=300)
        chunk = hashlib.sha256(seed.encode("ascii")).digest() * (MIB // 32)
        try:
            connection.putrequest("PUT", path)
            connection.putheader("X-H3-Token", self.token)
            connection.putheader("Content-Type", "video/mp4")
            connection.putheader("Content-Length", str(size))
            connection.endheaders()
            remaining = size
            while remaining:
                block = chunk[:min(len(chunk), remaining)]
                connection.send(block)
                remaining -= len(block)
            response = connection.getresponse()
            data = response.read()
        finally:
            connection.close()
        if response.status != 201:
            raise RuntimeError(f"upload {project_id}: HTTP {response.status}: {data[:1000]!r}")
        return json.loads(data)

    def start_backend(self):
        self.runtime.mkdir(parents=True, exist_ok=True)
        self.projects.mkdir(parents=True, exist_ok=True)
        instance_path = self.runtime / "instance.json"
        instance_path.unlink(missing_ok=True)
        self.env = {
            **os.environ,
            "PYTHONPATH": os.pathsep.join([sysconfig.get_paths()["purelib"], os.environ.get("PYTHONPATH", "")]),
            "H3_COMFY_ROOT": str(self.root / "unused-comfy-root"),
            "H3_COMFY_URL": f"http://127.0.0.1:{self.fake.server_port}",
            "H3_WORKBENCH_DATA_DIR": str(self.root / "data"),
            "H3_WORKBENCH_RUNTIME_DIR": str(self.runtime),
            "H3_PROJECTS_ROOT": str(self.projects),
            "H3_WORKBENCH_NO_BROWSER": "1",
            "H3_WORKBENCH_TEST_MODE": "1",
        }
        self.backend_log = (self.backend_log_path).open("a", encoding="utf-8")
        started = time.monotonic()
        self.backend = subprocess.Popen(
            [self.python, str(self.workbench / "video_workbench_launcher.py")],
            cwd=self.workbench, env=self.env, stdout=self.backend_log,
            stderr=subprocess.STDOUT, creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0,
        )
        for _ in range(300):
            if self.backend.poll() is not None:
                raise RuntimeError(f"isolated backend exited {self.backend.returncode}; see {self.backend_log_path}")
            try:
                self.instance = json.loads(instance_path.read_text(encoding="utf-8"))
                if self.instance.get("pid") == self.backend.pid:
                    break
            except (OSError, json.JSONDecodeError):
                pass
            time.sleep(0.1)
        else:
            raise RuntimeError("timed out waiting for isolated instance.json")
        self.origin = f"http://127.0.0.1:{self.instance['port']}"
        self.token = self.instance["token"]
        connection = http.client.HTTPConnection("127.0.0.1", self.instance["port"], timeout=5)
        try:
            connection.request("GET", "/api/health")
            response = connection.getresponse()
            health = json.loads(response.read())
        finally:
            connection.close()
        if not health.get("ok") or health.get("pid") != self.backend.pid:
            raise RuntimeError(f"unexpected isolated health: {health}")
        if Path(health["projectsRoot"]).resolve() != self.projects:
            raise RuntimeError("isolated backend escaped its synthetic project root")
        return time.monotonic() - started

    def stop_backend(self):
        if not self.backend:
            return
        if self.backend.poll() is None:
            subprocess.run([self.python, str(self.workbench / "stop.py")], cwd=self.workbench,
                           env=self.env, timeout=30, check=True,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                self.backend.wait(timeout=20)
            except subprocess.TimeoutExpired:
                self.backend.kill()
                self.backend.wait(timeout=10)
                raise RuntimeError("isolated backend required a forced kill")
        if self.backend_log:
            self.backend_log.close()
            self.backend_log = None
        self.backend = None

    def seed(self):
        total = self.args.asset_total_bytes
        base, extra = divmod(total, self.args.projects)
        if base <= 0 or base + (1 if extra else 0) > 2 * GIB:
            raise ValueError("per-project synthetic assets must be between 1 byte and 2 GiB")
        uploaded = 0
        for index in range(self.args.projects):
            seed = f"{index:03d}"
            document = self.request("POST", "/api/projects", {"name": f"Soak {seed}"})
            project_id = document["id"]
            size = base + (1 if index < extra else 0)
            result = self.upload(project_id, size, seed)
            asset = result["asset"]
            document = self.request("GET", f"/api/projects/{project_id}")
            document["canvas"]["nodes"] = [{
                "id": "synthetic-media", "type": "media",
                "position": {"x": 0, "y": 0},
                "data": {"kind": "video", "assetPath": asset["path"], "label": "synthetic"},
            }]
            document = self.request("PUT", f"/api/projects/{project_id}", document)
            self.request("POST", f"/api/projects/{project_id}/close", {})
            self.projects_info[project_id] = {"asset": asset, "revision": document["revision"]}
            uploaded += size
            self.initial_revisions[project_id] = document["revision"]
            self.progress(status="seeding", projects=len(self.projects_info), syntheticAssetBytes=uploaded,
                          syntheticAssetTargetBytes=total)
            print(f"seeded {len(self.projects_info)}/{self.args.projects} projects, {uploaded}/{total} bytes", flush=True)
        if uploaded != total:
            raise AssertionError((uploaded, total))
        write_json(self.root / "seed.json", {"projects": self.projects_info, "syntheticAssetBytes": uploaded})

    def collect_orphan_evidence(self):
        project_id = next(iter(self.projects_info))
        protected = self.projects_info[project_id]["asset"]
        preview = self.request("POST", f"/api/projects/{project_id}/assets/collect",
                               {"dryRun": True, "minAgeDays": 0})
        if preview["candidates"]:
            raise AssertionError("referenced synthetic asset was offered for collection")
        # Resolve by ID rather than relying on list ordering.
        row = next(row for row in self.request("GET", "/api/projects")["projects"] if row["id"] == project_id)
        project_path = Path(row["path"])
        orphan = project_path / "assets" / ("0" * 64 + ".mp4")
        orphan.write_bytes(b"synthetic orphan")
        dry_run = self.request("POST", f"/api/projects/{project_id}/assets/collect",
                               {"dryRun": True, "minAgeDays": 0})
        if [item["path"] for item in dry_run["candidates"]] != [f"assets/{orphan.name}"]:
            raise AssertionError(f"unexpected orphan preview: {dry_run}")
        removed = self.request("POST", f"/api/projects/{project_id}/assets/collect",
                               {"dryRun": False, "minAgeDays": 0, "confirm": "DELETE_ORPHANS"})
        protected_file = project_path / protected["path"]
        if orphan.exists() or not protected_file.is_file() or protected_file.stat().st_size != protected["bytes"]:
            raise AssertionError("orphan collection did not preserve the referenced asset")
        self.orphan = {"projectId": project_id, "previewCandidates": len(dry_run["candidates"]),
                       "removedBytes": removed["bytes"], "protectedAssetBytes": protected_file.stat().st_size,
                       "protectedAssetPreserved": True}
        self.request("POST", f"/api/projects/{project_id}/close", {})

    def sample(self, sample_index):
        started = time.perf_counter()
        rows = self.request("GET", "/api/projects")["projects"]
        self.list_latencies.append((time.perf_counter() - started) * 1000)
        if len(rows) != self.args.projects or len({row["id"] for row in rows}) != self.args.projects:
            raise AssertionError("project list count or identity changed")
        by_id = {row["id"]: row for row in rows}
        for offset in range(min(5, len(rows))):
            project_id = rows[(sample_index * 5 + offset) % len(rows)]["id"]
            document = self.request("GET", f"/api/projects/{project_id}")
            viewport = document["canvas"].setdefault("viewport", {})
            viewport["x"] = int(viewport.get("x", 0)) + 1
            started = time.perf_counter()
            saved = self.request("PUT", f"/api/projects/{project_id}", document)
            self.save_latencies.append((time.perf_counter() - started) * 1000)
            self.request("POST", f"/api/projects/{project_id}/close", {})
            if saved["revision"] != document["revision"] + 1:
                raise AssertionError("revision did not advance exactly once")
            by_id[project_id]["revision"] = saved["revision"]
        process = psutil.Process(self.backend.pid)
        memory = process.memory_info()
        queue_path = self.runtime / "queue.json"
        queue_bytes = queue_path.stat().st_size if queue_path.is_file() else 0
        queue = json.loads(queue_path.read_text(encoding="utf-8")) if queue_bytes else {"jobs": []}
        job_ids = [job.get("id") or job.get("jobId") for job in queue.get("jobs", [])]
        if len(job_ids) != len(set(job_ids)):
            raise AssertionError("duplicate queue job identities")
        revisions = {project_id: row["revision"] for project_id, row in by_id.items()}
        sample = {
            "at": utc_now(), "index": sample_index,
            "elapsedSeconds": time.monotonic() - self.started_monotonic,
            "projects": len(rows),
            "listMs": self.list_latencies[-1],
            "saveMsLastBatch": self.save_latencies[-min(5, len(rows)):],
            "revisionSum": sum(revisions.values()),
            "rssBytes": memory.rss, "vmsBytes": memory.vms,
            "handles": process.num_handles() if hasattr(process, "num_handles") else None,
            "threads": process.num_threads(), "queueJsonBytes": queue_bytes,
            "queueJobs": len(job_ids),
        }
        with self.samples_path.open("a", encoding="utf-8") as output:
            output.write(json.dumps(sample, ensure_ascii=False) + "\n")
        self.progress(status="running", sample=sample, listP95Ms=percentile95(self.list_latencies),
                      saveP95Ms=percentile95(self.save_latencies))
        print(json.dumps({"sample": sample_index, "elapsedSeconds": round(sample["elapsedSeconds"], 1),
                          "listMs": round(sample["listMs"], 2), "rssMiB": round(memory.rss / MIB, 1),
                          "handles": sample["handles"], "revisionSum": sample["revisionSum"]}), flush=True)
        return revisions

    def restart_and_verify(self, revisions):
        before = dict(revisions)
        stopped = time.monotonic()
        self.stop_backend()
        startup = self.start_backend()
        rows = self.request("GET", "/api/projects")["projects"]
        after = {row["id"]: row["revision"] for row in rows}
        if before != after:
            raise AssertionError("project IDs or revisions changed across isolated restart")
        recovery = {"at": utc_now(), "startupSeconds": startup,
                    "totalRecoverySeconds": time.monotonic() - stopped,
                    "projects": len(after), "revisionIdentityPreserved": True}
        self.recoveries.append(recovery)
        print(json.dumps({"restart": recovery}), flush=True)

    def final_report(self, status, error=None):
        rows = self.request("GET", "/api/projects")["projects"] if self.backend else []
        revisions = {row["id"]: row["revision"] for row in rows}
        asset_errors = []
        for project_id, info in self.projects_info.items():
            row = next((row for row in rows if row["id"] == project_id), None)
            if not row:
                asset_errors.append({"projectId": project_id, "error": "project missing"})
                continue
            asset = info["asset"]
            path = Path(row["path"]) / asset["path"]
            if not path.is_file() or path.stat().st_size != asset["bytes"]:
                asset_errors.append({"projectId": project_id, "error": "asset missing or size changed"})
        samples = []
        if self.samples_path.is_file():
            samples = [json.loads(line) for line in self.samples_path.read_text(encoding="utf-8").splitlines() if line]
        takes = []
        for row in rows:
            document = self.request("GET", f"/api/projects/{row['id']}")
            for shot in document.get("shots", []):
                take_ids = [take.get("id") for take in shot.get("takes", [])]
                if len(take_ids) != len(set(take_ids)):
                    raise AssertionError(f"duplicate Take in {row['id']}/{shot.get('id')}")
                takes.extend((row["id"], shot.get("id"), take_id) for take_id in take_ids)
        report = {
            "schemaVersion": 1, "status": status,
            "startedAt": samples[0]["at"] if samples else utc_now(), "finishedAt": utc_now(),
            "configuration": {
                "projects": self.args.projects, "syntheticAssetBytes": self.args.asset_total_bytes,
                "requestedHours": self.args.hours, "sampleIntervalSeconds": self.args.interval_seconds,
                "upstream": "synthetic empty ComfyUI HTTP fixture; no GPU jobs submitted",
            },
            "samples": len(samples),
            "actualSoakSeconds": samples[-1]["elapsedSeconds"] if samples else 0,
            "listP95Ms": percentile95(self.list_latencies),
            "saveP95Ms": percentile95(self.save_latencies),
            "listMaxMs": max(self.list_latencies, default=None),
            "saveMaxMs": max(self.save_latencies, default=None),
            "memoryRssStartBytes": samples[0]["rssBytes"] if samples else None,
            "memoryRssEndBytes": samples[-1]["rssBytes"] if samples else None,
            "memoryRssPeakBytes": max((sample["rssBytes"] for sample in samples), default=None),
            "handlesStart": samples[0]["handles"] if samples else None,
            "handlesEnd": samples[-1]["handles"] if samples else None,
            "handlesPeak": max((sample["handles"] for sample in samples if sample["handles"] is not None), default=None),
            "queueJsonStartBytes": samples[0]["queueJsonBytes"] if samples else None,
            "queueJsonEndBytes": samples[-1]["queueJsonBytes"] if samples else None,
            "queueJsonPeakBytes": max((sample["queueJsonBytes"] for sample in samples), default=None),
            "revisionStartSum": sum(self.initial_revisions.values()), "revisionEndSum": sum(revisions.values()),
            "recoveries": self.recoveries, "orphanBehavior": self.orphan,
            "finalProjects": len(rows), "finalTakeCount": len(takes), "assetErrors": asset_errors,
            "error": error,
        }
        report["passed"] = bool(status == "completed" and self.projects_info and not error and not asset_errors
                                and len(rows) == self.args.projects and self.recoveries
                                and self.orphan and self.orphan["protectedAssetPreserved"])
        write_json(self.report_path, report)
        self.progress(status=status, passed=report["passed"], report=str(self.report_path), error=error)
        return report

    def run(self):
        self.root.mkdir(parents=True, exist_ok=True)
        if any(self.root.iterdir()):
            raise RuntimeError(f"refusing non-empty QA root: {self.root}")
        self.fake = ThreadingHTTPServer(("127.0.0.1", 0), FakeComfyHandler)
        threading.Thread(target=self.fake.serve_forever, daemon=True).start()
        error = None
        try:
            self.start_backend()
            self.seed()
            self.collect_orphan_evidence()
            self.started_monotonic = time.monotonic()
            deadline = self.started_monotonic + self.args.hours * 3600
            midpoint = self.started_monotonic + self.args.hours * 1800
            restarted = False
            sample_index = 0
            revisions = dict(self.initial_revisions)
            while True:
                revisions = self.sample(sample_index)
                sample_index += 1
                now = time.monotonic()
                if now >= deadline:
                    break
                if not restarted and now >= midpoint:
                    self.restart_and_verify(revisions)
                    restarted = True
                time.sleep(max(0, min(self.args.interval_seconds, deadline - time.monotonic())))
            if not restarted:
                self.restart_and_verify(revisions)
            report = self.final_report("completed")
            print(json.dumps(report, ensure_ascii=False), flush=True)
        except Exception as exc:
            error = "".join(traceback.format_exception_only(type(exc), exc)).strip()
            traceback.print_exc()
            try:
                self.final_report("failed", error=error)
            except Exception:
                traceback.print_exc()
            raise
        finally:
            try:
                self.stop_backend()
            finally:
                self.fake.shutdown()
                self.fake.server_close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--projects", type=int, default=100)
    parser.add_argument("--asset-total-bytes", type=int, default=50 * GIB)
    parser.add_argument("--hours", type=float, default=8)
    parser.add_argument("--interval-seconds", type=float, default=60)
    args = parser.parse_args()
    if args.projects < 2 or args.hours <= 0 or args.interval_seconds <= 0:
        parser.error("projects must be >=2; hours and interval must be positive")
    Soak(args).run()


if __name__ == "__main__":
    main()
