# PCG v1 host interface, M2 saved geometry graphs

`pcg/registry.json` is the shared NodeDescriptor v1 source. Descriptor and
operation versions remain 1. The fixed diagnostic and legacy `geometry_stub`
retain their M1 contracts. The stub remains unavailable and readable. M2
introduces five task entries and eighteen fixed atomic operations; game_asset
requires the future bridge and is explicitly unavailable. Registry descriptions,
parameter schemas, ports, examples, readiness and budgets are machine-readable.

Descriptors use closed parameter schemas: finite number/integer, boolean,
bounded string, bounded typed arrays, closed objects, enums and defaults.
Unknown keywords/parameters and dynamic code are rejected. A port type may be a
known type string or an array of known types. `Geometry` expands to Mesh,
PointSet or InstanceSet. Protocol 1 GeometryArtifact and its Field expression
DAG stay separate from protocol 2 evaluated engine values. See
[ENGINE_API.md](ENGINE_API.md) for engine data and all atomic operations.

Canvas nodes have `type:"pcg"`, `data.descriptorId`, `descriptorVersion:1`,
`operationVersion:1` and `parameters`. Edges name literal output/input ports in
`sourceHandle`/`targetHandle`; optional `data.pcgType` must agree. Save first:
preflight and run read only the exact saved project/revision, traversing all
upstream dependencies. They reject cycles, missing/duplicate ports, incompatible
types, unknown operations and unavailable executors. No route accepts a path,
expression, executable, script or alternative request graph. Project JSON and
revision are never changed by execution; the page owns ordinary graph saves.

All routes use the existing host/origin/authentication guards. Project access
requires its writable lock. POST JSON bodies are at most 64 KiB. Errors return
`{code,message,details?}` with HTTP 400/403/409/423/503 as appropriate.

- `GET /api/pcg/registry`: registry directly.
- `POST /api/pcg/preflight`: identity below; returns
  `{ok,identity,descriptorId,inputHash,readiness}` and for geometry graphs also
  `executionOrder`, `dirtyNodes`, `cacheHits`, `isolation`.
- `POST /api/pcg/run`: same identity; HTTP 202 `{task}`. An unavailable executor
  or OS boundary retains a failed task and returns HTTP 409 `{code,message,task}`.
- `POST /api/pcg/wait`: full handle plus optional `timeoutMs` 0..20000,
  default 1000. Returns `{task}`.
- `POST /api/pcg/read`: full handle, returns `{task}`.
- `POST /api/pcg/verify`: full handle, returns
  `{ok,verified,jobId,inputHash,resultHash}` only for a successful current run
  with matching saved input identity, result hashes and immutable files.
- `POST /api/pcg/cancel`: full handle, cancels only that task's owned OS job;
  returns `{task}`. Terminal tasks are unchanged. Stale mutations are refused.
- `POST /api/pcg/export`: full handle plus optional `format:"glb"|"json"`
  (default glb) and `port` (default first geometry output). Returns
  `{ok,artifact}`. A preview is never substituted for the model.
- `GET /api/pcg/tasks/{jobId}`: remaining full handle fields in query.
- `GET /api/pcg/tasks?projectId=...&nodeId=...`: retained tasks, newest first.
- `GET /api/pcg/artifacts/{artifactId}`: complete handle in query. Authenticated
  read of that exact task's managed bytes, with MIME, nosniff and no-store.
  Model/data use attachment disposition. No arbitrary file query exists.

Identity:

```json
{"projectId":"prj_example","nodeId":"pcg-1","revision":2,"descriptorVersion":1,"operationVersion":1,"runId":"run-001"}
```

Complete handle (copy every actual field from run):

```json
{"projectId":"prj_example","nodeId":"pcg-1","revision":2,"descriptorVersion":1,"operationVersion":1,"runId":"run-001","jobId":"pcg_0123456789abcdef0123456789abcdef","inputHash":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}
```

Task fields are identity, jobId/inputHash/descriptorId, status, progress,
result/resultHash/error and stale. Status is queued/running/succeeded/failed/
cancelled. `runId` is idempotent only for exactly matching identity and inputs.
A changed revision or newer run for the same node makes old handles stale;
old tasks remain readable, but cannot verify, export or publish over a newer run.
Failures are retained. Capacity is 256 retained tasks and four admitted tasks. M2 geometry executes
one task at a time per runtime; other admitted geometry tasks remain queued
and can be cancelled without affecting the active task. Host close cancels both
active and waiting tasks. The M1 diagnostic admission behavior is preserved.
Storage limits are
64 MiB retained full final values and a separate 32 MiB/256-entry LRU cache.

Geometry `task.result` contains `outputs` (counts, bounds, attribute domains,
source bindings and at most 64 deterministic samples per value), `assets` and
`report` and `stagePreviews`. Every evaluated step has bounded output summaries,
run/job/input/output identity and timing. Every geometry step has an actual SVG
asset with `producerNodeId`. All stage previews are rendered and checked against
a 16 MiB aggregate budget before any publication; over-budget graphs fail
explicitly rather than dropping stages. Full arrays never appear in read/wait/list by default. Report includes
actual `computedNodes`, `cacheHits`, per-node `elapsedMs`, output byte sizes and
worker/host elapsed time and `queueWaitMs`. Artifact records contain artifactId, SHA256, byte
count, format/MIME, port, job/run/input/project/revision identity, bounded summary
and an authenticated API URL. GLB has `role:"model"`, native JSON `role:"data"`,
and a fixed-camera SVG `role:"preview"`. SVG is only a static read-only preview.

Graph worker protocol 2 receives bounded approved values through stdio in the
verified OS boundary. There is no ordinary-process geometry fallback. Worker
values, types, Field source/topology/domain bindings, trace sets and hashes are
validated again by the host. Only the host writes immutable job-owned outputs;
files are SHA256 checked on download and verification. Protocol 1 remains the
separate trusted fixed diagnostic worker.

Pure cache keys include operation/version, normalized parameters, full explicit
input content and Field/Selection bindings. Project revision is excluded from
pure keys, so unrelated saves reuse work. Each host cache isolates projects and
returns copies. Preflight predicts dirty dependencies; execution reports actual
sets. Cache reuse never supplies assets from another project or run.
