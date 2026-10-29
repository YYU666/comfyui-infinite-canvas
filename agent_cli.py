from __future__ import annotations

import argparse
import json
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from agent_mcp import WorkbenchClient, protocol_resource, schema_resource
from agent_io import configure_utf8


def parser():
    root = argparse.ArgumentParser(description="H3 Agent 协议 v2：无需浏览器操作本地项目。")
    root.add_argument("--url")
    root.add_argument("--token")
    commands = root.add_subparsers(dest="command", required=True)
    for name in ("state", "query", "apply", "wait", "shot-create", "generate", "take-select", "export", "prompt-get", "prompt-diff"):
        command = commands.add_parser(name)
        if name not in {"prompt-get", "prompt-diff"}:
            command.add_argument("--project", required=True)
        if name == "state":
            command.add_argument("--view", default="digest")
            command.add_argument("--since", type=int)
            command.add_argument("--max-chars", type=int, default=12000)
        elif name in {"query", "apply"}:
            command.add_argument("--json", required=True, help="JSON 字符串或 @文件路径")
        elif name == "wait":
            command.add_argument("--jobs", required=True, help="逗号分隔的任务 ID")
            command.add_argument("--timeout-ms", type=int, default=600000)
        elif name == "shot-create":
            command.add_argument("--character")
            command.add_argument("--outfit")
            command.add_argument("--location")
            command.add_argument("--prompt", required=True)
            command.add_argument("--name")
            command.add_argument("--duration", type=float, default=5)
        elif name == "generate":
            command.add_argument("--shot", required=True)
            command.add_argument("--wait", action="store_true")
            command.add_argument("--timeout-ms", type=int, default=600000)
        elif name == "take-select":
            command.add_argument("--shot", required=True)
            command.add_argument("--take", required=True)
        elif name == "export":
            command.add_argument("--takes", help="可选，逗号分隔；默认导出选用 Take")
        elif name == "prompt-get":
            command.add_argument("project")
            command.add_argument("hash")
        elif name == "prompt-diff":
            command.add_argument("project")
            command.add_argument("a")
            command.add_argument("b")
    commands.add_parser("protocol")
    commands.add_parser("schema")
    return root


def json_value(value):
    if value.startswith("@"):
        with open(value[1:], "r", encoding="utf-8") as handle:
            return json.load(handle)
    return json.loads(value)


def main(argv=None):
    args = parser().parse_args(argv)
    if args.command in {"protocol", "schema"}:
        result = protocol_resource() if args.command == "protocol" else schema_resource()
    else:
        client = WorkbenchClient(args.url, args.token)
        base = f"/api/agent/projects/{getattr(args, 'project', None)}"
        if args.command == "state":
            from urllib.parse import urlencode
            query = urlencode({key: value for key, value in {"view": args.view, "since": args.since, "maxChars": args.max_chars}.items() if value is not None})
            result = client.request("GET", f"{base}/state?{query}")
        elif args.command in {"query", "apply"}:
            result = client.request("POST", f"{base}/{args.command}", json_value(args.json))
        elif args.command == "wait":
            result = client.request("POST", f"{base}/wait", {"jobs": args.jobs.split(","), "timeoutMs": args.timeout_ms})
        elif args.command == "shot-create":
            operation = {"op": "shot.create", "character": args.character, "outfit": args.outfit, "location": args.location,
                         "prompt": args.prompt, "name": args.name, "duration": args.duration}
            result = client.request("POST", f"{base}/apply", {"opId": f"shot-{uuid.uuid4().hex}", "ops": [operation]})
        elif args.command == "generate":
            result = client.request("POST", f"{base}/apply", {"opId": f"generate-{uuid.uuid4().hex}", "ops": [{"op": "generate", "target": args.shot}]})
            if args.wait:
                job = next(item["job"] for item in result["results"] if "job" in item)
                result = client.request("POST", f"{base}/wait", {"jobs": [job], "timeoutMs": args.timeout_ms})
        elif args.command == "take-select":
            result = client.request("POST", f"{base}/apply", {"opId": f"select-{uuid.uuid4().hex}", "ops": [{"op": "take.select", "shot": args.shot, "take": args.take}]})
        elif args.command == "export":
            operation = {"op": "delivery.export"}
            if args.takes:
                operation["takeIds"] = args.takes.split(",")
            result = client.request("POST", f"{base}/apply", {"opId": f"export-{uuid.uuid4().hex}", "ops": [operation]})
        elif args.command == "prompt-get":
            result = client.request("GET", f"/api/agent/projects/{args.project}/prompt/{args.hash}")
        elif args.command == "prompt-diff":
            result = client.request("POST", f"/api/agent/projects/{args.project}/prompt.diff", {"a": args.a, "b": args.b})
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    configure_utf8()
    try:
        main()
    except (RuntimeError, ValueError, OSError, json.JSONDecodeError) as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(1)
