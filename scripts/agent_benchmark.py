from __future__ import annotations

import copy
import io
import json
import sys
import tempfile
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from agent_mcp import TOOLS
from agent_protocol import AgentProtocol, estimate_tokens
from project_domain import DEFAULTS
from project_store import ProjectStore
from workbench_lifecycle import utc_now
from workbench_queue import QueueManager


class Adapter:
    def submit(self, workflow, client_id):
        return "benchmark-prompt"

    def poll(self, prompt_id):
        entry = {"status": {"completed": True}, "outputs": {"save": {"images": [{"filename": "benchmark.png", "type": "output"}]}}}
        return {"status": "done", "history": entry, "outputs": entry["outputs"]}

    def cancel(self, prompt_id):
        return None


def main():
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        store = ProjectStore(root / "projects", "benchmark")
        queue = QueueManager(root / "queue.json", adapter=Adapter(), poll_interval=0.01)
        queue.start()
        try:
            nodes = []
            for index in range(200):
                kind = "generator" if index % 4 == 0 else "media"
                nodes.append({"id": f"fixture-{index}", "type": kind, "position": {"x": index * 20, "y": 0},
                              "data": {"title": f"N{index}", "mode": "reference" if kind == "generator" else None,
                                       "kind": "image" if kind == "media" else None, "name": "input.png", "status": "idle", "prompt": "基准提示词" * 200}})
            document = store.create("Agent 基准", {"nodes": nodes, "edges": [], "viewport": {"x": 0, "y": 0, "zoom": 1}})
            image = io.BytesIO()
            Image.new("RGB", (2, 2)).save(image, "PNG")
            asset = store.put_asset(document["id"], "fixture.png", io.BytesIO(image.getvalue()), "image/png")["asset"]["path"]
            document = store.get(document["id"])
            for index in range(5):
                document["characters"].append({**copy.deepcopy(DEFAULTS["characters"]), "id": f"c{index + 1}", "name": f"角色{index + 1}"})
            take_number = 0
            for index in range(20):
                takes = []
                for _ in range(3 if index < 10 else 2):
                    take_number += 1
                    takes.append({"id": f"t{take_number}", "asset": asset, "poster": None, "recipe": {"seed": take_number},
                                  "rating": 0, "selected": False, "rejected": False, "notes": "", "tags": [], "createdAt": utc_now()})
                document["shots"].append({**copy.deepcopy(DEFAULTS["shots"]), "id": f"s{index + 1}", "number": f"S{index + 1:02d}",
                                          "name": f"镜头{index + 1}", "params": {"ratio": "16:9", "resolution": "480P", "duration": 5, "seed": 0, "turbo": False}, "takes": takes})
            document = store.save(document["id"], document, document["revision"])
            protocol = AgentProtocol(store, queue)
            digest = protocol.state(document["id"])
            query = protocol.query(document["id"], {"fields": ["handle", "title", "status"], "limit": 5})
            receipt = protocol.apply(document["id"], {"opId": "benchmark-set", "ops": [{"op": "set", "target": "g1", "settings": {"seed": 1}}]})
            applied = protocol.apply(document["id"], {"opId": "benchmark-four", "ops": [
                {"op": "create", "preset": "text_video", "prompt": "基准"},
                {"op": "connect", "from": "m1", "to": "g51", "port": "guide"},
                {"op": "set", "target": "g51", "settings": {"seed": 2}},
                {"op": "generate", "target": "g51"},
            ]})
            job = next(row["job"] for row in applied["results"] if "job" in row)
            waited = protocol.wait(document["id"], job, 2000)
            metrics = {"fixture": {"nodes": 200, "shots": 20, "characters": 5, "takes": 50},
                       "digestTokens": digest["meta"]["estTokens"], "queryTokens": query["meta"]["estTokens"],
                       "receiptTokens": receipt["meta"]["estTokens"], "apply4Tokens": applied["meta"]["estTokens"],
                       "waitTokens": waited["meta"]["estTokens"], "toolSchemaTokens": estimate_tokens({"tools": TOOLS})}
            limits = {"digestTokens": 100, "queryTokens": 150, "receiptTokens": 30, "apply4Tokens": 200, "waitTokens": 50, "toolSchemaTokens": 600}
            assert all(metrics[key] <= limit for key, limit in limits.items()), metrics
            print(json.dumps({"ok": True, **metrics}, ensure_ascii=False))
        finally:
            queue.stop()
            store.close()


if __name__ == "__main__":
    main()
