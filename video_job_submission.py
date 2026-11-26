"""Admission and idempotency for page-prepared video jobs."""
from copy import deepcopy
import re

from project_store import StoreError
from workbench_security import valid_token


VIDEO_JOB_FIELDS = {
    "ved": "videoEditJobId",
    "vry": "rhythmJobId",
    "vck": "chromaJobId",
    "vwp": "plateJobId",
    "vrp": "repairJobId",
}


def prepared_video_submission(store, jobs, payload, prefix, node_types, *, page=None, job_field=None, record_field="videoSubmission"):
    """Resolve one stable job ID. Call with the job manager lock held."""
    if "requestId" not in payload:
        raise StoreError("VIDEO_PREPARATION_REQUIRED", "请从画布保存准备记录后再提交视频作业。", 409)
    request_id = payload["requestId"]
    if not isinstance(request_id, str) or not re.fullmatch(r"[a-f0-9]{32}", request_id):
        raise StoreError("BAD_REQUEST", "视频提交标识无效。", 400)
    job_id = f"{prefix}_{request_id}"
    project_id, node_id = payload["projectId"], payload["nodeId"]
    if job_id in jobs:
        if jobs[job_id].get("_submission") != payload:
            raise StoreError("VIDEO_SUBMISSION_CONFLICT", "该视频提交标识已用于不同的作业。", 409)
        return job_id, True
    project = store.get(project_id)
    node = next((n for n in project.get("canvas", {}).get("nodes", [])
                 if n["id"] == node_id and n["type"] in node_types), None)
    data = node.get("data", {}) if node else {}
    record = data.get(record_field)
    intent = {key: value for key, value in payload.items() if key != "requestId"}
    if (not isinstance(record, dict) or record.get("phase") != "prepared"
            or data.get(job_field or VIDEO_JOB_FIELDS[prefix]) != job_id
            or record.get("id") != job_id or record.get("requestId") != request_id
            or record.get("intent") != intent
            or (page is not None and record.get("page") != page)):
        raise StoreError("VIDEO_PREPARATION_REQUIRED", "请先保存画布上的视频作业准备记录。", 409)
    return job_id, False


def video_submission_fields(payload):
    return {"_submission": deepcopy(payload)}


def submit_video_from_page(handler, jobs, request, *, submit=None, tool="canvas_generate_node"):
    """New jobs require a browser cookie plus the live, saved canvas proof."""
    if (handler.headers.get("Sec-Fetch-Site") != "same-origin"
            or not valid_token({"Cookie": handler.headers.get("Cookie", "")}, handler.server.token, handler.server.server_port)):
        raise StoreError("VIDEO_PAGE_REQUIRED", "请从当前可写画布提交视频任务。", 403)
    server = handler.server
    page = request.get("page")
    if (not isinstance(page, dict) or not {"epoch", "sessionId"} <= page.keys()
            or page.keys() - {"epoch", "sessionId", "opId"}):
        raise StoreError("VIDEO_PAGE_REQUIRED", "视频提交缺少本次画布会话证明。", 403)
    payload = {key: value for key, value in request.items() if key != "page"}
    project_id, node_id = payload.get("projectId"), payload.get("nodeId")
    if not all(isinstance(value, str) and value for value in (project_id, node_id)):
        raise StoreError("BAD_REQUEST", "视频提交缺少项目或节点。", 400)
    bridge = getattr(getattr(server, "agent_api", None), "canvas", None)
    if not callable(getattr(bridge, "assert_generation_page", None)):
        raise StoreError("VIDEO_PAGE_REQUIRED", "当前画布页桥不可用，请重新打开项目。", 409)
    # Keep the manager -> project order used by local repair commits and the
    # project -> page order used by queue admission. Hold through worker creation.
    path = jobs.store._project_path(project_id)
    with jobs.lock, jobs.store._guard(path), bridge.lock:
        jobs.store._require_writable(path)
        bridge.assert_generation_page(page, project_id, node_id, page.get("opId", payload.get("requestId")), tool=tool)
        return (submit or jobs.submit)(payload, page=page)
