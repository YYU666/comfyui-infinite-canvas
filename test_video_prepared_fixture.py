"""Attach a real saved node preparation to lower-level FFmpeg fixtures."""
from uuid import uuid4

from project_store import StoreError
from video_job_submission import VIDEO_JOB_FIELDS


def submit_fixture(jobs, payload):
    request_id = uuid4().hex
    types = {
        "VideoEditJobs": ("ved", "videoEdit"),
        "VideoRhythmJobs": ("vry", "videoSpeed" if payload.get("operation") == "speed" else "videoTimeRemap"),
        "VideoChromaJobs": ("vck", "videoChromaKey"),
        "VideoPlateJobs": ("vwp", "videoWhitePlate"),
    }
    prefix, node_type = types[type(jobs).__name__]
    project_id = payload.get("projectId")
    try:
        project = jobs.store.get(project_id)
    except StoreError:
        return jobs.submit({**payload, "requestId": request_id})
    node_id = payload["nodeId"]
    record = {"id": f"{prefix}_{request_id}", "requestId": request_id, "phase": "prepared", "intent": payload}
    nodes = project["canvas"]["nodes"]
    nodes[:] = [node for node in nodes if node["id"] != node_id]
    nodes.append({"id": node_id, "type": node_type, "position": {"x": 0, "y": 0}, "data": {"videoSubmission": record, VIDEO_JOB_FIELDS[prefix]: record["id"]}})
    jobs.store.save(project_id, project, project["revision"])
    return jobs.submit({**payload, "requestId": request_id})
