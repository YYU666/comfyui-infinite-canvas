# Independent demo session API

`DemoSession(root: Path, samples_root: Path | None = None)` owns its synthetic
ProjectStore, unchanged M2 runtime, immutable asset cache and execution thread.
The administrator chooses roots during construction; public methods accept
managed IDs and bounded numeric recipe parameters only. Network roots are
rejected before filesystem access.

- `snapshot()` returns `contractVersion:1`, `instanceId`, monotonic `revision`
  and `selectionEpoch`, `autoFollow`, `closed`, `run`, `desired`, `catalog`,
  `graph` and bounded real `events`. No paths, tokens or full geometry arrays.
- `select(asset_id)` chooses a managed catalog asset, advances selectionEpoch,
  and disables autoFollow during an active run. Returns a snapshot.
- `start(recipe='rock', seed=0, roughness=.2, count=100, minDistance=0)` saves
  a declared atomic graph and begins real stage execution in a background thread.
  It rejects an active/cancelling run, resets autoFollow and returns a snapshot.
- `cancel(run_id)` accepts only the current run identity, requests cancellation
  of its own task and returns a snapshot. A new run waits for terminal cancellation.
- `read_asset(asset_id)` returns `(GLB_bytes, metadata)` only for managed IDs.
- `close()` cancels its own run, joins execution and closes its own runtime/store.

`run` includes runId, recipe/parameters, status, stageIndex/stageCount,
currentNodeId, currentTask (complete M2 handle when present), completedStages,
error and declared graph identity. Status is running/cancelling/succeeded/failed/
cancelled. Completed stages retain bounded output statistics and actual M2
computed/cache sets and task identity. Each geometry stage is exported immediately
after that real M2 task succeeds; Field stages retain the last geometry and expose
bounded Field statistics. There is no completed-run playback simulation.

`desired` is the selected asset metadata or null; it is not a viewer-loaded ACK.
The service owns displayed identity separately. Asset metadata includes assetId,
SHA256, bytes, geometryType/counts/bounds, producerNodeId, runId/jobId/inputHash
and sourceIdentity. `catalog` is a bounded list of these records. Every selection
change advances selectionEpoch so the service can reject late viewer responses.
Manual selection during a run stops later stage completion from changing desired;
a new start restores automatic following.

Catalog limits are 512 asset records and 128 MiB unique cached GLB bytes.
Existing owned cache files are hash/GLB verified and counted after restart;
unrecognized files or exceeded limits fail construction. Recipe seed is an integer
0..2147483647, roughness 0..0.9, count 0..10000 and minDistance 0..1000000.
Assets are content-addressed inside the service-owned cache, verified on read,
and cannot be addressed through public paths. Sample import reads only approved
GLB references from `samples_root/EVIDENCE.json`, verifies hashes and bounded
GLB structure, and accepts the approved evidence absolute paths only when lexically beneath the
configured samples_root, and rejects escapes, traversal, links and external
resources. Each GLB assetsLocal hash must match one result.assets GLB and its
complete original M2 handle; source labels and summaries are retained.
Invalid configured evidence fails construction. No samples_root means an empty
catalog until the first completed geometry stage. OS isolation unavailability
causes an explicit failed run; there is no fallback executor.
