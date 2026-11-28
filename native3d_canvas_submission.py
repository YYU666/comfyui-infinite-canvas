"""Bind new Native3D jobs to a saved request from the current workbench page."""
from contextlib import contextmanager
from hmac import compare_digest
from http.cookies import CookieError, SimpleCookie
import json

from project_store import StoreError

DERIVED_TOOLS = {
    "canvas_native3d_repair_lod", "canvas_native3d_retry_lod", "canvas_native3d_retry_stage",
}


def authorize_page(handler, payload):
    if not isinstance(payload, dict) or not all(
        isinstance(payload.get(key), str) and 0 < len(payload[key]) <= 128
        for key in ("projectId", "nodeId", "opId")
    ):
        raise StoreError("BAD_REQUEST", "3D 提交缺少有效的项目、节点或请求标识。")
    server = handler.server
    origin = handler.headers.get("X-Refmuse-Native3D-Page")
    if origin not in ("agent", "manual") or handler.headers.get("Sec-Fetch-Site") != "same-origin":
        raise StoreError("NATIVE3D_PAGE_REQUIRED", "请从当前可操作画布提交 3D 任务。", 403)
    # The launcher API token alone also authenticates CLI clients. It does not
    # grant the browser-only submission path.
    cookies = SimpleCookie()
    try:
        cookies.load(handler.headers.get("Cookie", ""))
    except CookieError:
        pass
    session = cookies.get(f"h3_session_{server.server_port}")
    if not session or not compare_digest(session.value.encode(), server.token.encode()):
        raise StoreError("NATIVE3D_PAGE_REQUIRED", "当前画布缺少有效的浏览器会话。", 403)
    bridge = canvas_bridge(handler)
    if not callable(getattr(bridge, "assert_generation_page", None)):
        raise StoreError("NATIVE3D_PAGE_REQUIRED", "当前画布页桥不可用，请重新打开项目。", 409)
    project_id, node_id, op_id = (payload[k] for k in ("projectId", "nodeId", "opId"))
    proof_text = handler.headers.get("X-Refmuse-Native3D-Proof", "")
    try:
        proof = json.loads(proof_text) if len(proof_text) <= 512 else None
    except ValueError:
        proof = None
    required = {"epoch", "sessionId", "opId"} if origin == "agent" else {"epoch", "sessionId"}
    optional = {"originNodeId"} if origin == "agent" else set()
    if not isinstance(proof, dict) or not required <= proof.keys() or proof.keys() - required - optional:
        raise StoreError("NATIVE3D_PAGE_REQUIRED", "缺少本次生成的画布会话凭据。", 403)
    identity = {"origin": origin, "projectId": project_id, "nodeId": node_id, "opId": op_id}
    derived = "originNodeId" in proof
    if derived:
        origin_id = bridge._id(proof, "originNodeId")
        identity["originNodeId"] = origin_id

    @contextmanager
    def live_page():
        with bridge.lock:
            command = bridge.commands.get(op_id)
            if origin == "manual" and command is not None:
                raise StoreError("NATIVE3D_PAGE_MISMATCH", "该请求属于 Agent 派发，须从原命令执行。", 409)
            if derived:
                base = {key: proof[key] for key in ("epoch", "sessionId")}
                bridge.assert_generation_page(base, project_id, node_id, op_id)
                if (not command or command["status"] != "dispatched" or command["tool"] not in DERIVED_TOOLS
                        or proof["opId"] != op_id or command["args"].get("nodeId") != origin_id
                        or command["projectId"] != project_id or command["sessionId"] != proof["sessionId"]):
                    raise StoreError("NATIVE3D_PAGE_MISMATCH", "专用 3D 动作与原节点或页面凭据不一致。", 409)
                identity["tool"] = command["tool"]
            else:
                bridge.assert_generation_page(proof, project_id, node_id, op_id)
            yield

    with live_page():
        pass
    return identity, proof, live_page


def canvas_bridge(handler):
    return getattr(getattr(handler.server, "agent_api", None), "canvas", None)


def _object(value):
    return value if isinstance(value, dict) else {}


def _output_on_edge(canvas, node_id, target_handle):
    edges = [
        e for e in canvas["edges"]
        if e.get("target") == node_id and e.get("targetHandle") == target_handle
    ]
    if not edges:
        return None, {}
    expected_handle = "ref" if target_handle == "image" else "model"
    if len(edges) != 1 or edges[0].get("sourceHandle") != expected_handle:
        _mismatch("输入连线缺失、类型错误或不唯一。")
    edge = edges[0]
    matches = [n for n in canvas["nodes"] if n.get("id") == edge.get("source")]
    if len(matches) != 1:
        _mismatch("连线来源节点缺失或不唯一。")
    source = matches[0]
    data = source["data"]
    if target_handle == "image":
        if source.get("type") != "media" or data.get("kind") != "image" or data.get("mediaRole") == "mask":
            _mismatch("图生模型需要一张已保存的普通图片素材。")
        return source["id"], data
    if source.get("type") != "native3d" and not (source.get("type") == "media" and data.get("kind") == "model"):
        _mismatch("连线来源不是已保存的模型节点。")
    record_id = _object(edge.get("data")).get("outputRecordId") or data.get("nativeCurrentOutputId")
    if record_id:
        outputs = data.get("nativeOutputRecords")
        records = [r for r in outputs if _object(r).get("recordId") == record_id] if isinstance(outputs, list) else []
        if len(records) != 1:
            _mismatch("连线绑定的历史模型结果缺失或不唯一。")
        record = records[0]
        data = _object(record.get("data"))
        if type(record.get("schemaVersion")) is not int or record["schemaVersion"] != 1 or not record.get("jobId") or record["jobId"] != data.get("sourceJobId") or data.get("operation") != "analyze":
            _mismatch("连线绑定的历史模型结果无效。")
    return source["id"], data


def _mismatch(message):
    raise StoreError("NATIVE3D_CANVAS_MISMATCH", message, 409)


def _check_derivation(canvas, data, parameters, page, find_job):
    if "originNodeId" not in page:
        return
    anchor_id = page["originNodeId"]
    origins = [n for n in canvas["nodes"] if n.get("id") == anchor_id and n.get("type") == "native3d"]
    if len(origins) != 1 or page["nodeId"] == anchor_id or data.get("operation") != "source_lod":
        _mismatch("找不到派发专用 3D 动作的原节点和衍生节点。")
    if page["tool"] != "canvas_native3d_repair_lod":
        if _object(data.get("nativeLODStageRetry")).get("originResultId") != anchor_id or not parameters.get("retryJobId"):
            _mismatch("保存的单档重试未绑定到指令指定的结果。")
        return
    candidate = _object(data.get("nativeLocalRepair")).get("sourceJobId")
    anchor_data = origins[0]["data"]
    job_id = anchor_data.get("sourceJobId") or anchor_data.get("nativeJobId")
    anchor_job = find_job(job_id) if isinstance(job_id, str) else None
    earlier = _object(_object(anchor_job).get("parameters")).get("localRepairJobId")
    if (not candidate or candidate != parameters.get("localRepairJobId")
            or candidate not in (job_id, earlier)):
        _mismatch("保存的局部修复未绑定到指令指定的候选或其原任务。")


def check_saved_submission(document, payload, encoded, page, proof, find_job):
    for key in ("projectId", "nodeId", "opId"):
        if payload[key] != page[key]:
            _mismatch("保存的项目、节点或请求标识与页面不一致。")
    canvas = document["canvas"]
    nodes = [n for n in canvas["nodes"] if n.get("id") == payload["nodeId"] and n.get("type") == "native3d"]
    if len(nodes) != 1:
        _mismatch("项目中没有唯一、已保存的 3D 作业节点。")
    data = nodes[0]["data"]
    run = _object(data.get("nativeRun"))
    if (data.get("operation") != payload["operation"] or data.get("status") != "submitting"
            or run.get("opId") != payload["opId"] or run.get("requestOrigin") != page["origin"]
            or run.get("page") != proof
            or json.dumps(run.get("submission"), sort_keys=True) != encoded
            or json.dumps(run.get("parameters"), sort_keys=True) != json.dumps(payload.get("parameters"), sort_keys=True)):
        _mismatch("节点尚未保存待提交的本次来源与参数，或它们已改变。")
    _check_derivation(canvas, data, payload.get("parameters", {}), page, find_job)
    if payload["operation"] == "analyze":
        pending = _object(data.get("nativePendingSource"))
        imported = pending.get("path") if isinstance(pending.get("path"), str) else None
        own_path = imported or data.get("assetPath")
        model_edge = any(
            edge.get("target") == payload["nodeId"] and edge.get("targetHandle") == "model"
            for edge in canvas["edges"]
        )
        # Match sourceFor: an analyze node with no saved import reads the model wire.
        if not data.get("sourceJobId") and not imported and not data.get("assetPath") and model_edge:
            source_id, source = _output_on_edge(canvas, payload["nodeId"], "model")
        else:
            source_id = payload["nodeId"]
            source = {"assetPath": own_path, "originalAssetPath": imported or data.get("originalAssetPath")}
    else:
        handle = "image" if payload["operation"] == "image_to_3d" else "model"
        source_id, source = _output_on_edge(canvas, payload["nodeId"], handle)
    primary = payload["source"]["assetPath"]
    if not source_id or source_id != run.get("sourceId") or source.get("assetPath") != primary or run.get("sourceAssetPath") != primary:
        _mismatch("保存的模型连线与本次提交来源不一致。")
    if payload["operation"] == "material_wear" and (
        _object(source.get("metadata")).get("operation") != "bake"
        or source.get("sourceJobId") != payload["parameters"].get("bakeJobId")
    ):
        _mismatch("曲率磨损必须连接与本次参数一致的真实烘焙输出。")
    if "highAssetPath" in payload["source"]:
        _, high = _output_on_edge(canvas, payload["nodeId"], "high")
        expected = high.get("assetPath") or source.get("originalAssetPath") or primary
        if payload["source"]["highAssetPath"] != expected:
            _mismatch("保存的高模连线与本次提交来源不一致。")
