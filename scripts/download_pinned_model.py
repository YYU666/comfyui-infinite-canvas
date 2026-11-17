"""Explicit opt-in downloads from the reviewed source lock, with mandatory SHA-256."""
import argparse
import hashlib
import json
from pathlib import Path
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from extension_dependencies import ModelDownloads
from model_sources import locked_sources
from workflow_extensions import ExtensionStore


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--comfy-root", type=Path, required=True)
    parser.add_argument("--model-root", type=Path)
    parser.add_argument("--path", required=True)
    parser.add_argument("--confirm-download", required=True, help="Repeat the exact model path after user authorization")
    args = parser.parse_args()
    if args.confirm_download != args.path:
        parser.error("Download confirmation must match --path")
    source = locked_sources().get(args.path)
    if source is None:
        parser.error("No reviewed, pinned official source for this model")
    manager = ModelDownloads(args.comfy_root, model_root=args.model_root)
    target = manager.root / source["path"]
    ExtensionStore._regular_path(target)
    if target.exists():
        with target.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        if target.stat().st_size != source["bytes"] or digest != source["sha256"]:
            raise ValueError("Existing model differs from lock; stopped without overwriting")
        print(json.dumps({"status": "already-verified", "path": source["path"], "sha256": digest, "repository": source['repository'], "revision": source['revision'], "bytes": source['bytes']}))
        return 0
    report = {"models": [{"id": "model", "download": source}]}
    job = manager.start(report, ["model"])
    last = None
    while job["status"] in ("queued", "running"):
        progress = job["downloadedBytes"] // (16 * 1024 * 1024)
        if progress != last:
            print(json.dumps({"status": job["status"], "downloadedBytes": job["downloadedBytes"], "totalBytes": job["totalBytes"]}), flush=True)
            last = progress
        time.sleep(1)
        job = manager.get(job["jobId"])
    print(json.dumps(job, ensure_ascii=True))
    return 0 if job["status"] == "completed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
