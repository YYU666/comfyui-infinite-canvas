from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from agent_protocol import AgentProtocol
from agent_workflow import build_video_workflow

ROOT = Path(__file__).resolve().parent
FIXTURE = ROOT / "fixtures" / "video-workflow-contract.json"


class AgentWorkflowContractTests(unittest.TestCase):
    def test_frontend_and_agent_build_identical_shared_h3_workflows(self):
        cases = json.loads(FIXTURE.read_text(encoding="utf-8"))
        node = os.environ.get("NODE_BINARY") or shutil.which("node") or shutil.which("node.exe")
        self.assertTrue(node, "工作流合同测试需要 Node.js 20.19+，也可通过 NODE_BINARY 指定路径。")
        completed = subprocess.run(
            [node, str(ROOT / "scripts" / "export_video_workflow_contract.mjs")],
            cwd=ROOT, check=True, capture_output=True, text=True, encoding="utf-8", timeout=30,
        )
        frontend = {item["name"]: item["graph"] for item in json.loads(completed.stdout)}
        self.assertEqual(set(frontend), {item["name"] for item in cases})
        for case in cases:
            with self.subTest(case=case["name"]):
                expected = build_video_workflow(case["options"], case["references"] if case["mode"] == "reference" else [])
                self.assertEqual(frontend[case["name"]], expected)

    def test_output_identity_matches_javascript_contract(self):
        job = {"id": "job-1", "shotId": "s1", "attempts": 2, "comfyPromptId": "prompt-1"}
        output = {"filename": "中文 结果.png", "subfolder": "shots/a", "type": "output"}
        identity = AgentProtocol._output_identity("prj_1", job, output)
        self.assertEqual(identity, '["prj_1","s1","job-1",2,"prompt-1","中文 结果.png","shots/a","output"]')
        self.assertEqual(AgentProtocol._external_asset(output),
                         "comfy://view?filename=%E4%B8%AD%E6%96%87+%E7%BB%93%E6%9E%9C.png&subfolder=shots%2Fa&type=output")


if __name__ == "__main__":
    unittest.main()
