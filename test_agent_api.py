from __future__ import annotations

import io
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))

from agent_api import AgentAPI
from agent_mcp import WorkbenchClient
from project_api import ProjectAPI
from project_store import ProjectStore
from queue_api import QueueAPI
from test_agent_protocol import FakeAdapter
from video_workbench_launcher import WorkbenchHandler, WorkbenchServer
from workbench_queue import QueueManager


class AgentTransportTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        root = Path(self.temporary.name)
        self.store = ProjectStore(root / "projects", "agent-api-test")
        self.project = self.store.create("传输验收")
        self.pid = self.project["id"]
        self.queue = QueueManager(root / "queue.json", adapter=FakeAdapter(), poll_interval=0.01)
        self.queue.start()
        self.server = WorkbenchServer(("127.0.0.1", 0), WorkbenchHandler)
        self.server.token = "agent-api-token"
        self.server.project_store = self.store
        self.server.project_api = ProjectAPI(self.store)
        self.server.queue_manager = self.queue
        self.server.queue_api = QueueAPI(self.queue)
        self.server.agent_api = AgentAPI(self.store, self.queue)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.origin = f"http://127.0.0.1:{self.server.server_port}"
        self.client = WorkbenchClient(self.origin, self.server.token)
        self.runtime = root / "runtime"
        self.runtime.mkdir()
        (self.runtime / "instance.json").write_text(json.dumps({"port": self.server.server_port, "token": self.server.token}), encoding="utf-8")
        self.env = {**os.environ, "H3_WORKBENCH_RUNTIME_DIR": str(self.runtime), "H3_PROJECT_ID": self.pid}

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.queue.stop()
        self.store.close()
        self.temporary.cleanup()

    def test_http_client_full_chain_and_resources(self):
        state = self.client.call_tool("state", {"projectId": self.pid})
        self.assertIn("nodes=0", state["digest"])
        applied = self.client.call_tool("apply", {"projectId": self.pid, "opId": "http-full", "ops": [
            {"op": "shot.create", "name": "HTTP 镜头", "prompt": "正面看向镜头"},
            {"op": "generate", "target": "s1"},
        ]})
        job = next(row["job"] for row in applied["results"] if "job" in row)
        waited = self.client.call_tool("wait", {"projectId": self.pid, "jobs": [job], "timeoutMs": 2000})
        self.assertEqual(waited["jobs"][0]["takes"], ["t1"])
        self.client.call_tool("apply", {"projectId": self.pid, "opId": "http-select", "ops": [{"op": "take.select", "shot": "s1", "take": "t1"}]})
        image = io.BytesIO()
        Image.new("RGB", (4, 4)).save(image, "PNG")
        asset = self.store.put_asset(self.pid, "result.png", io.BytesIO(image.getvalue()), "image/png")["asset"]["path"]
        document = self.store.get(self.pid)
        document["shots"][0]["takes"][0]["asset"] = asset
        self.store.save(self.pid, document, document["revision"])
        exported = self.client.call_tool("apply", {"projectId": self.pid, "opId": "http-export", "ops": [{"op": "delivery.export"}]})
        self.assertEqual(exported["results"][0]["export"]["count"], 1)
        protocol = self.client.request("GET", "/api/agent/resources/protocol")
        self.assertEqual(protocol["uri"], "canvas://protocol")
        context = self.client.request("GET", f"/api/agent/resources/context?projectId={self.pid}")
        self.assertEqual(context["content"]["project"]["id"], self.pid)
        page = self.client.call_tool("query", {"projectId": self.pid, "source": "nodes", "fields": ["handle", "title"], "limit": 1, "maxChars": 200})
        self.assertEqual(len(page["rows"]), 1)

    def test_cli_and_mcp_stdio_without_browser(self):
        root = Path(__file__).resolve().parent
        cli = subprocess.run([sys.executable, str(root / "agent_cli.py"), "state", "--project", self.pid], env=self.env,
                             capture_output=True, text=True, encoding="utf-8", timeout=10, check=True)
        self.assertIn("nodes=0", json.loads(cli.stdout)["digest"])
        requests = [
            {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}},
            {"jsonrpc": "2.0", "id": 3, "method": "resources/read", "params": {"uri": "canvas://context"}},
            {"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "state", "arguments": {"projectId": self.pid}}},
        ]
        process = subprocess.run([sys.executable, str(root / "agent_mcp.py")], input="".join(json.dumps(item) + "\n" for item in requests),
                                 env=self.env, capture_output=True, text=True, encoding="utf-8", timeout=10, check=True)
        responses = [json.loads(line) for line in process.stdout.splitlines() if line.strip()]
        self.assertEqual(len(responses), 4, process.stderr)
        self.assertEqual(responses[0]["result"]["serverInfo"]["name"], "h3-workbench")
        self.assertEqual([tool["name"] for tool in responses[1]["result"]["tools"]], ["state", "query", "apply", "wait"])
        self.assertEqual(responses[2]["result"]["contents"][0]["uri"], "canvas://context")
        self.assertIn("nodes=0", responses[3]["result"]["content"][0]["text"])


if __name__ == "__main__":
    unittest.main()
