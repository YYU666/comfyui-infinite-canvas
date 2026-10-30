from __future__ import annotations

import json
import re
import urllib.parse

from agent_protocol import AgentProtocol
from project_store import StoreError
from canvas_page_bridge import CanvasPageBridge


PROJECT_PATH = re.compile(r"/api/agent/projects/(prj_[A-Za-z0-9_-]+)/(state|query|apply|wait|prompt/([0-9a-f]{8})|prompt\.diff)")
RESOURCE_PATH = re.compile(r"/api/agent/resources/(protocol|context|schema)")


class AgentAPI:
    def __init__(self, store, queue_manager=None):
        self.protocol = AgentProtocol(store, queue_manager)
        self.canvas = CanvasPageBridge()

    @staticmethod
    def _json(handler):
        length = int(handler.headers.get("Content-Length", "0"))
        if length <= 0 or length > 10 * 1024 * 1024:
            raise StoreError("BAD_REQUEST", "Agent 请求为空或超过大小限制。")
        try:
            payload = json.loads(handler.rfile.read(length).decode("utf-8"))
        except (UnicodeError, json.JSONDecodeError) as error:
            raise StoreError("BAD_REQUEST", "Agent 请求 JSON 无效。") from error
        if not isinstance(payload, dict):
            raise StoreError("BAD_REQUEST", "Agent 请求必须是 JSON 对象。")
        return payload

    @staticmethod
    def _query(handler):
        return urllib.parse.parse_qs(urllib.parse.urlparse(handler.path).query)

    def handle_get(self, handler, path):
        if not path.startswith("/api/agent/"):
            return False
        try:
            if path == "/api/agent/canvas/current":
                handler.send_json(200, self.canvas.current(self._query(handler).get("projectId", [None])[0]))
                return True
            if re.fullmatch(r"/api/agent/canvas/commands/[A-Za-z0-9_-]{1,100}", path):
                handler.send_json(200, self.canvas.get(path.rsplit("/", 1)[1]))
                return True
            match = PROJECT_PATH.fullmatch(path)
            if match and match.group(2) == "state":
                query = self._query(handler)
                result = self.protocol.state(match.group(1), query.get("view", ["digest"])[0], query.get("since", [None])[0],
                                             query.get("maxChars", [12000])[0], query.get("cursor", [0])[0])
                handler.send_json(200, result)
                return True
            if match and match.group(2).startswith("prompt/"):
                handler.send_json(200, self.protocol.prompt_get(match.group(1), match.group(3)))
                return True
            match = RESOURCE_PATH.fullmatch(path)
            if match:
                from agent_mcp import protocol_resource, schema_resource
                name = match.group(1)
                if name == "protocol":
                    result = protocol_resource()
                elif name == "schema":
                    result = schema_resource()
                else:
                    project_id = self._query(handler).get("projectId", [None])[0]
                    if not project_id:
                        raise StoreError("BAD_REQUEST", "context 资源需要 projectId。")
                    result = self.protocol.state(project_id, "context", max_chars=6000)
                handler.send_json(200, {"uri": f"canvas://{name}", "mimeType": "application/json", "content": result})
                return True
            handler.send_json(404, {"code": "NOT_FOUND", "message": "Agent 接口不存在。", "details": {}})
            return True
        except StoreError as error:
            handler.send_json(error.status, {"code": error.code, "message": error.message, "details": error.details})
            return True
        except (TypeError, ValueError) as error:
            handler.send_json(400, {"code": "BAD_REQUEST", "message": str(error), "details": {}})
            return True

    def handle_post(self, handler, path):
        if not path.startswith("/api/agent/"):
            return False
        try:
            canvas_actions = {"heartbeat": self.canvas.heartbeat, "commands": self.canvas.submit,
                              "result": self.canvas.complete, "release": self.canvas.release}
            if path.startswith("/api/agent/canvas/") and path.rsplit("/", 1)[1] in canvas_actions:
                result = canvas_actions[path.rsplit("/", 1)[1]](self._json(handler))
                handler.send_json(200, result)
                return True
            match = PROJECT_PATH.fullmatch(path)
            if not match:
                handler.send_json(404, {"code": "NOT_FOUND", "message": "Agent 接口不存在。", "details": {}})
                return True
            project_id, action = match.group(1), match.group(2)
            payload = self._json(handler)
            if action == "query":
                result = self.protocol.query(project_id, payload)
            elif action == "apply":
                result = self.protocol.apply(project_id, payload)
            elif action == "wait":
                result = self.protocol.wait(project_id, payload.get("jobs"), payload.get("timeoutMs", 600000))
            elif action == "prompt.diff":
                result = self.protocol.prompt_diff(project_id, payload.get("a"), payload.get("b"))
            else:
                raise StoreError("BAD_REQUEST", "该 Agent 操作只支持 GET。")
            handler.send_json(200, result)
            return True
        except StoreError as error:
            handler.send_json(error.status, {"code": error.code, "message": error.message, "details": error.details})
            return True
        except KeyError as error:
            handler.send_json(404, {"code": "NOT_FOUND", "message": "队列任务不存在。", "details": {"id": str(error)}})
            return True
        except (TypeError, ValueError) as error:
            handler.send_json(400, {"code": "BAD_REQUEST", "message": str(error), "details": {}})
            return True
