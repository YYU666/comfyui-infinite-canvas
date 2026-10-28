from collections import defaultdict
from hashlib import sha256
import json
from pathlib import Path

ROOTS = [
    Path(r"C:\ComfyUI_windows_portable\ComfyUI\models"),
    Path(r"D:\H3-Models"),
]
EXTENSIONS = {".safetensors", ".ckpt", ".pt", ".pth", ".bin", ".gguf", ".onnx"}


def digest(path):
    value = sha256()
    size = path.stat().st_size
    sample_size = 8 * 1024 * 1024
    with path.open("rb") as stream:
        for index in range(17):
            stream.seek(index * max(0, size - sample_size) // 16)
            value.update(stream.read(sample_size))
    return value.hexdigest()


paths = []
for root in ROOTS:
    for path in root.rglob("*"):
        if path.is_file() and path.suffix.lower() in EXTENSIONS:
            paths.append(path)

groups = defaultdict(list)
for path in paths:
    print(f"Hashing {path}", flush=True)
    groups[(path.stat().st_size, digest(path))].append(path)

results = []
for (size, sample_hash), matches in groups.items():
    if len(matches) < 2:
        continue
    results.append({
        "bytes": size,
        "sample_sha256": sample_hash,
        "paths": [str(path) for path in matches],
    })

output = Path(__file__).with_name("duplicate-model-hashes.json")
output.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps(results, ensure_ascii=False, indent=2))
