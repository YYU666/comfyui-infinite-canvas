"""Read-only Native3D storage inventory. Paths in reports are local and private."""
import argparse
from collections import defaultdict, deque
import hashlib
import json
import os
from pathlib import Path
import re
import stat

JOB_ID = re.compile(r"(?<![A-Za-z0-9_])n3d_[a-f0-9]{32}(?![A-Za-z0-9_])", re.I)
TERMINAL = {"succeeded", "failed", "cancelled"}
MAX_PROJECT_BYTES = 256 * 1024**2
MAX_PREVIEW_SOURCE_BYTES = 16 * 1024**2
CATEGORIES = ("referenced", "unproven", "regenerable")


def files_under(root, report_issue):
    """Yield non-linked regular files without following symlinks or junctions."""
    pending = [root]
    while pending:
        path = pending.pop()
        try:
            info = path.lstat()
            if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT:
                report_issue(path, "linked_path_skipped")
            elif stat.S_ISDIR(info.st_mode):
                pending.extend(path.iterdir())
            elif stat.S_ISREG(info.st_mode):
                yield path, info
            else:
                report_issue(path, "special_file_skipped")
        except OSError:
            report_issue(path, "unreadable_path")


def read_object(path, limit):
    with path.open("rb") as stream:
        data = stream.read(limit + 1)
    if len(data) > limit:
        raise ValueError("oversize JSON")
    value = json.loads(data)
    if not isinstance(value, dict):
        raise ValueError("expected JSON object")
    return value


def string_values(value, *, op_ids=None):
    # Walk legacy and current schemas without coercing other values into strings.
    pending = [value]
    while pending:
        item = pending.pop()
        if isinstance(item, dict):
            if op_ids is not None and isinstance(item.get("opId"), str):
                op_ids.add(item["opId"])
            pending.extend(item.keys())
            pending.extend(item.values())
        elif isinstance(item, list):
            pending.extend(item)
        elif isinstance(item, str):
            yield item


def job_ids(strings):
    return {match.group().lower() for value in strings for match in JOB_ID.finditer(value)}


def is_project_record(path):
    return (
        path.name.lower() == "project.json"
        or (path.name.lower().startswith(".conflict-") and path.suffix.lower() == ".json")
        or (path.parent.name.lower() == "backups" and path.suffix.lower() == ".json")
    )


def collect_projects(roots, issue):
    references = defaultdict(set)
    op_references = defaultdict(set)
    seen = set()
    scanned = 0
    for root in roots:
        if not root.is_dir():
            issue(root, "project_root_unavailable")
            continue
        for path, _ in files_under(root, issue):
            if path in seen or not is_project_record(path):
                continue
            seen.add(path)
            try:
                doc = read_object(path, MAX_PROJECT_BYTES)
            except (OSError, ValueError, RecursionError):
                issue(path, "project_record_unreadable")
                continue
            scanned += 1
            project_id = doc.get("id")
            op_ids = set()
            for job_id in job_ids(string_values(doc, op_ids=op_ids)):
                references[job_id].add(str(path))
            if isinstance(project_id, str):
                # The canvas saves its opId before it sends a job submission.
                for op_id in op_ids:
                    op_references[(project_id, op_id)].add(str(path))
    return scanned, references, op_references


def verified_previews(job, files):
    """Recognize the ordinary UV previews backed by a verified retained model."""
    if job.get("operation") != "uv" or job.get("status") != "succeeded":
        return set()
    result = job.get("result")
    if not isinstance(result, dict) or not isinstance(result.get("files"), list):
        return set()
    models = [entry for entry in result["files"] if isinstance(entry, dict)
              and entry.get("name") == "model.glb" and entry.get("role") == "model"]
    source = files.get("output/model.glb")
    if len(models) != 1 or source is None:
        return set()
    path, info = source
    digest = models[0].get("sha256")
    if not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest):
        return set()
    if not 12 <= info.st_size <= MAX_PREVIEW_SOURCE_BYTES:
        return set()
    candidates = {
        f"uv-previews/{digest}-{mode}-v3.png" for mode in ("seams", "checker")
    } & files.keys()
    if not candidates:
        return set()
    try:
        with path.open("rb") as stream:
            if stream.read(4) != b"glTF":
                return set()
            stream.seek(0)
            source_hash = hashlib.sha256()
            while chunk := stream.read(1024 * 1024):
                source_hash.update(chunk)
            if source_hash.hexdigest() != digest:
                return set()
        verified = set()
        for candidate in candidates:
            path, info = files[candidate]
            if info.st_nlink != 1 or not 67 <= info.st_size <= 8 * 1024**2:
                continue
            with path.open("rb") as stream:
                signature = stream.read(8)
                stream.seek(-12, os.SEEK_END)
                ending = stream.read(12)
            if signature == b"\x89PNG\r\n\x1a\n" and ending == b"\x00\x00\x00\x00IEND\xaeB\x60\x82":
                verified.add(candidate)
        return verified
    except OSError:
        return set()


def inspect_jobs(root, issue):
    jobs = {}
    unclassified = 0
    for path, info in files_under(root, issue):
        relative = path.relative_to(root).parts
        if len(relative) < 2 or not JOB_ID.fullmatch(relative[0]):
            unclassified += info.st_size
            continue
        job_id = relative[0]
        record = jobs.setdefault(job_id, {"files": {}, "manifest": {}, "parents": set()})
        record["files"]["/".join(relative[1:])] = (path, info)
    for job_id, job in jobs.items():
        for filename in ("manifest.json", "request.json"):
            if filename not in job["files"]:
                if filename == "manifest.json":
                    issue(root / job_id / filename, "job_manifest_missing")
                continue
            path, _ = job["files"][filename]
            try:
                document = read_object(path, 4 * 1024**2)
                if filename == "manifest.json":
                    if document.get("id") != job_id:
                        raise ValueError("job identity mismatch")
                    job["manifest"] = document
                job["parents"].update(job_ids(string_values(document)) - {job_id})
            except (OSError, ValueError, RecursionError):
                issue(path, "job_record_unreadable")
    return jobs, unclassified


def inventory(jobs_root, project_roots):
    issues = []
    def issue(path, reason):
        issues.append({"path": str(path), "reason": reason})

    scans, refs, op_refs = collect_projects(project_roots, issue)
    if not jobs_root.is_dir():
        issue(jobs_root, "jobs_root_unavailable")
    jobs, outside = inspect_jobs(jobs_root, issue) if jobs_root.is_dir() else ({}, 0)
    for job_id, job in jobs.items():
        manifest = job["manifest"]
        project_id, op_id = manifest.get("projectId"), manifest.get("opId")
        if isinstance(project_id, str) and isinstance(op_id, str):
            refs[job_id].update(op_refs.get((project_id, op_id), ()))

    # Protect upstream job evidence used by retained or in-flight jobs. Keep
    # indirect references separately so the report does not imply a project hit.
    referenced = {job_id for job_id, records in refs.items() if records}
    active = {job_id for job_id, job in jobs.items()
              if job["manifest"].get("status") in ("queued", "running")}
    parents_of = defaultdict(set)
    pending = deque(referenced | active)
    visited = set(pending)
    while pending:
        child = pending.popleft()
        for parent in jobs.get(child, {}).get("parents", ()):
            parents_of[parent].add(child)
            if parent not in visited:
                visited.add(parent)
                pending.append(parent)

    totals = dict.fromkeys(CATEGORIES, 0)
    totals["unproven"] = outside
    rows = []
    for job_id, job in sorted(jobs.items()):
        manifest = job["manifest"]
        status = manifest.get("status")
        # A retained job's files stay in the referenced bucket. Even a known
        # cache can be directly consumed by a project, and this is a live scan.
        keep = job_id in referenced or bool(parents_of[job_id])
        previews = set()
        if not keep and not issues and scans and status in TERMINAL:
            previews = verified_previews(manifest, job["files"])
        sizes = dict.fromkeys(CATEGORIES, 0)
        for name, (_, info) in job["files"].items():
            category = "referenced" if keep else "regenerable" if name in previews else "unproven"
            sizes[category] += info.st_size
            totals[category] += info.st_size
        rows.append({"jobId": job_id, "status": status, "operation": manifest.get("operation"),
                     "logicalBytes": sum(sizes.values()), "bytesByCategory": sizes,
                     "projectRecords": sorted(refs[job_id]), "referencedByJobs": sorted(parents_of[job_id]),
                     "regenerableFiles": sorted(previews)})
    return {
        "schemaVersion": 1,
        "jobsRoot": str(jobs_root),
        "projectRoots": [str(path) for path in project_roots],
        "projectRecordsScanned": scans,
        "jobCount": len(rows),
        "logicalBytes": sum(totals.values()),
        "bytesByCategory": totals,
        "unclassifiedLogicalBytes": outside,
        "observedProjectReferencesWithoutJob": sorted(referenced - jobs.keys()),
        "issues": sorted(issues, key=lambda item: (item["path"], item["reason"])),
        "jobs": sorted(rows, key=lambda row: (-row["logicalBytes"], row["jobId"])),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--jobs-root", type=Path, required=True)
    parser.add_argument("--projects-root", type=Path, action="append", required=True,
                        help="Repeat for every project location, including custom locations.")
    parser.add_argument("--json", action="store_true", help="Include all job and issue details.")
    options = parser.parse_args()
    report = inventory(options.jobs_root.absolute(), [path.absolute() for path in options.projects_root])
    if options.json:
        print(json.dumps(report, ensure_ascii=True, indent=2))
    else:
        print("Native3D read-only storage inventory (logical file sizes)")
        print(f'{report["jobCount"]} jobs, {report["projectRecordsScanned"]} project records, '
              f'{len(report["issues"])} scan issues')
        for label, size in report["bytesByCategory"].items():
            print(f"{label:12} {size:16,d} bytes ({size / 1024**3:.3f} GiB)")
        for row in report["jobs"][:10]:
            print(f'{row["jobId"]} {row["logicalBytes"]:16,d} bytes {row["status"] or "unknown"}')
        print("Use --json for evidence, scope, and scan issues.")
    return 2 if report["issues"] or not report["projectRecordsScanned"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
