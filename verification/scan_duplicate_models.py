from __future__ import annotations

import argparse
from collections import defaultdict
from hashlib import sha256
import json
from pathlib import Path

EXTENSIONS = {".safetensors", ".ckpt", ".pt", ".pth", ".bin", ".gguf", ".onnx"}


def digest(path):
    """Sample 17 ranges for triage; a matching sample is not a full-file hash."""
    value = sha256()
    size = path.stat().st_size
    sample_size = 8 * 1024 * 1024
    with path.open("rb") as stream:
        for index in range(17):
            stream.seek(index * max(0, size - sample_size) // 16)
            value.update(stream.read(sample_size))
    return value.hexdigest()


def scan(roots):
    paths = []
    for root in roots:
        for path in root.rglob("*"):
            if path.is_file() and path.suffix.lower() in EXTENSIONS:
                paths.append(path)
    groups = defaultdict(list)
    for path in paths:
        print(f"Hashing {path}", flush=True)
        groups[(path.stat().st_size, digest(path))].append(path)
    return [
        {"bytes": size, "sample_sha256": sample_hash, "paths": [str(path) for path in matches]}
        for (size, sample_hash), matches in groups.items() if len(matches) >= 2
    ]


def main():
    parser = argparse.ArgumentParser(description="按抽样哈希查找可能重复的模型；不会移动或删除文件")
    parser.add_argument("--model-root", type=Path, action="append", required=True, help="模型根目录，可重复传入")
    parser.add_argument("--output", type=Path, help="可选：将 JSON 报告写入此路径")
    args = parser.parse_args()
    results = scan([path.resolve() for path in args.model_root])
    rendered = json.dumps(results, ensure_ascii=False, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered, encoding="utf-8")
    print(rendered)


if __name__ == "__main__":
    main()
