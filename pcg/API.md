# PCG M1 interface

`pcg/registry.json` is the sole NodeDescriptor v1 source for the browser, tools,
host and fixed stdio worker. Root keys are `descriptorVersion`, `namespace`,
`pluginVersion`, `nodes`. Each descriptor has `id`, `descriptorVersion`,
`pluginVersion`, `operationVersion`, `label`, `category`, `parameters` (closed
JSON schema), `inputs`, `outputs`, `budget`, `permissions`, `readiness`,
`examples`, `errors`. Ports use `{name,type,required}`. No runtime permissions
are granted. Geometry is deliberately unavailable in M1.

Canvas nodes use `type: "pcg"`, with `data` containing `descriptorId`,
`descriptorVersion: 1`, `operationVersion: 1`, and `parameters`. Edges use the
literal output/input port name in `sourceHandle`/`targetHandle`; optional
`data.pcgType` must agree. Save the graph before preflight/run. `revision`
means the saved project revision. No API accepts code, executable or a path
outside the managed artifact contract.

All routes live under `/api/pcg`; existing host, origin, token and JSON content
guards apply. All project operations require a writable project lock. Errors
use HTTP 400/403/409/423/503 with `{code,message,details?}`. Unknown JSON fields,
versions, parameters, ports and types are rejected. Request bodies are at most
64 KiB. No PCG endpoint mutates project JSON or attaches a result to a node.
The page owns its ordinary revision-aware graph saves and preview status.

* `GET /registry` returns the registry directly.
* `POST /preflight` and `POST /run` accept the identity below. Parameters and
  input edges come from the saved graph, never from a parallel request graph.
* `POST /wait`, `/read`, `/verify` accept the complete task handle below;
  `/wait` additionally accepts `timeoutMs` from 0 through 20000 (default 1000).
* `GET /tasks/{jobId}` accepts the remaining handle fields in its query.
* `GET /tasks?projectId=...&nodeId=...` lists this node's retained tasks newest
  first for reload recovery, including full handles and a `stale` flag.

Identity example:

```json
{"projectId":"prj_example","nodeId":"pcg-1","revision":2,"descriptorVersion":1,"operationVersion":1,"runId":"run-001"}
```

Preflight succeeds with `{ok:true,identity,descriptorId,inputHash,readiness}`.
Run returns HTTP 202 `{task}`. Task fields are the identity above, `jobId`,
`inputHash`, `descriptorId`, `status`, `progress`, `result`, `error`,
`resultHash`, `stale`. `status` is queued/running/succeeded/failed. A geometry run returns
HTTP 409 `{code:"EXECUTOR_UNAVAILABLE",message,task}` and retains the failed
task. All terminal failures are retained for the lifetime of this host.

Complete task handle example (copy values from run):

```json
{"projectId":"prj_example","nodeId":"pcg-1","revision":2,"descriptorVersion":1,"operationVersion":1,"runId":"run-001","jobId":"pcg_0123456789abcdef0123456789abcdef","inputHash":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}
```

Wait/read return `{task}`. Verify succeeds only for an actual successful worker
report, with `{ok:true,verified:true,jobId,inputHash,resultHash}`. A current
project revision change marks read/wait results stale and rejects verification.
Preflight/run reject obsolete revisions. Handles
cannot cross project, node, run, version or input identities. A repeated
project/runId with the same full input returns the same job; any changed
identity/input is `IDEMPOTENCY_CONFLICT`. Restarting the host invalidates old
handles. Capacity exhaustion is explicit; no retained task is silently evicted.

Diagnostic output is `{report:{contractVersion:1,type:"DiagnosticReport",
operation:"refmuse.pcg.diagnostic",label,inputCount,inputTypes,workerPid,
inputHash}}`. It reports actual contract checks from a separate process. It
contains no geometry, preview mesh, export or implied modeling result.

Connected inputs require an available, successful, current upstream result
of the exact port type. Stub connections remain visible but preflight reports
`EXECUTOR_UNAVAILABLE`; missing output is `INPUT_UNAVAILABLE`. Recover by
disconnecting the unavailable input or using the diagnostic without inputs.
For revision/identity errors save/read the current graph and start a new runId.
For worker failures inspect the retained error and explicitly start a new run.

Strict value contracts and asset identity are defined by `pcg_contracts.py`.
All values use contractVersion 1. Geometry has metre/right-handed/Y-up
coordinates, topology identity, and separate Point/Face/Corner counts.
Attributes/Selection bind artifact/hash/topology, exact domain and value type.
Fields are finite typed DAGs (constant/attribute/add/multiply), never expressions.
Geometry and instance envelopes require ordered min/max bounds; producer plugin,
version and commit; node/job/run/revision plus recipe/input SHA256 provenance;
UV set names, normal domain, material IDs and strictly diagnostic-only quality.
Artifact IDs are `pcg_<sha256>`. Instances have unique stable `instanceIds`, their
own ordering `topologyId`, the same explicit coordinates, and bounded row-major
affine 4x4 transforms. `instance_context` binds Instance-domain attributes to
that instance artifact and ordering rather than a geometry Point domain.
Assets are immutable SHA256 identities registered in the same project's assets
list, flat content-addressed `assets/<sha256>.pcg.json`, with bounded byte size;
links, reparse points, hard links, unknown formats and hash changes are refused.
Stored PCG JSON containers are closed `{contractVersion:1,format,payload}`;
`format` must match the artifact and `payload` must be a bounded object. M1
checks storage and envelope contracts without interpreting geometry payloads.

M1 provides process separation, not OS sandbox isolation. The worker has a
fixed command, no listener, no dynamic loading or geometry implementation.
