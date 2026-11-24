"""Admission and idempotency for page-prepared video jobs."""
from copy import deepcopy
import re

from project_store import StoreError


def prepared_video_submission(store, jobs, payload, prefix, node_types):
    """Resolve one stable job ID. Call with the job manager lock held."""
    if "requestId" not in payload:
        return None, False  # Existing local integrations retain the legacy API.
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
    record = node and node.get("data", {}).get("videoSubmission")
    intent = {key: value for key, value in payload.items() if key != "requestId"}
    if (not isinstance(record, dict) or record.get("phase") != "prepared"
            or record.get("id") != job_id or record.get("requestId") != request_id
            or record.get("intent") != intent):
        raise StoreError("VIDEO_PREPARATION_REQUIRED", "请先保存画布上的视频作业准备记录。", 409)
    return job_id, False


def video_submission_fields(payload):
    return {"_submission": deepcopy(payload)} if "requestId" in payload else {}
