from __future__ import annotations

import copy
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from project_store import ProjectStore

WRITER = """
import sys, time
from pathlib import Path
sys.path.insert(0, str(Path(sys.argv[1])))
from project_store import ProjectStore
store = ProjectStore(sys.argv[2], 'crash-writer')
doc = store.get(sys.argv[3])
doc['canvas']['nodes'] = [{'id': 'bulk', 'data': 'x' * 2000000}]
for _ in range(1000):
    doc = store.save(doc['id'], doc, doc['revision'])
"""


def main():
    with tempfile.TemporaryDirectory(prefix="h3-crash-") as temporary:
        store = ProjectStore(temporary)
        document = store.create("崩溃测试")
        path = Path(temporary) / "崩溃测试" / "project.json"
        process = subprocess.Popen([sys.executable, "-c", WRITER, str(ROOT), temporary, document["id"]], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            backups = list(path.parent.glob("backups/project-r*.json"))
            if len(backups) >= 2:
                break
            if process.poll() is not None:
                raise RuntimeError("写入进程提前退出")
            time.sleep(0.05)
        else:
            process.kill()
            raise RuntimeError("未观察到原子写入")
        process.kill()
        process.wait(timeout=5)
        current = json.loads(path.read_text(encoding="utf-8"))
        assert current["schemaVersion"] == 3 and current["revision"] >= 2
        assert not list(path.parent.glob(".project.json.*.tmp"))
        assert all(json.loads(item.read_text(encoding="utf-8"))["schemaVersion"] == 3 for item in path.parent.glob("backups/*.json"))
        store.close()
        print(json.dumps({"ok": True, "jsonReadable": True, "revision": current["revision"], "backups": len(list(path.parent.glob('backups/*.json')))}, ensure_ascii=False))


if __name__ == "__main__":
    main()
