"""Attach a real saved node preparation to lower-level FFmpeg fixtures."""
from uuid import uuid4

from project_store import StoreError
from video_job_submission import VIDEO_JOB_FIELDS


def prepare_fixture(jobs, payload, *, analysis=False, mock_store=False):
    request_id = uuid4().hex
    types = {
        "VideoEditJobs": ("ved", "videoEdit"),
        "VideoRhythmJobs": ("vry", "videoSpeed" if payload.get("operation") == "speed" else "videoTimeRemap"),
        "VideoChromaJobs": ("vck", "videoChromaKey"),
        "VideoPlateJobs": ("vwp", "videoWhitePlate"),
        "VideoRepairJobs": ("vrp", "videoLocalRepair"),
    }
    prefix, node_type = types[type(jobs).__name__]
    request = {**payload, "requestId": request_id}
    project_id = payload.get("projectId")
    try:
        project = {"canvas": {"nodes": []}} if mock_store else jobs.store.get(project_id)
    except StoreError:
        return request
    node_id = payload["nodeId"]
    record = {"id": f"{prefix}_{request_id}", "requestId": request_id, "phase": "prepared", "intent": payload}
    nodes = project["canvas"]["nodes"]
    nodes[:] = [node for node in nodes if node["id"] != node_id]
    record_field = "videoAnalysisSubmission" if analysis else "videoSubmission"
    job_field = "videoAnalysisJobId" if analysis else VIDEO_JOB_FIELDS[prefix]
    nodes.append({"id": node_id, "type": node_type, "position": {"x": 0, "y": 0}, "data": {record_field: record, job_field: record["id"]}})
    if mock_store:
        jobs.store.get.return_value = project
    else:
        jobs.store.save(project_id, project, project["revision"])
    return request


def submit_fixture(jobs, payload, *, mock_store=False):
    return jobs.submit(prepare_fixture(jobs, payload, mock_store=mock_store))
