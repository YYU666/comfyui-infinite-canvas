# Compact completed image results

`canvas_image_compact` operates through the already mounted current canvas page.
Pass `nodeIds` (1–100 safe generator IDs). `dryRun` defaults to `true`: it reports
`compacted` and `skipped` without changing or saving the project. Explicit
`dryRun:false` applies presentation flags and completes only after the normal
revision-protected project save. A failed save returns `ok:false` and
`localChangesRetained:true`; resolve the existing save error before retrying.

Only completed, unambiguous single-image executions qualify. Each result keeps
its original media ID, file metadata, URL and execution history. Stored edges
retain their endpoints; the visible edge projection carries the historical media
ID. Multi-output executions, ambiguous owners and missing execution identities
keep independent cards. No generation, upload, file deletion or media rewrite
occurs. Undo/redo uses the existing canvas history.

The action rejects a busy or read-only canvas, pending media writes, active
editing, save errors and project switching. The page bridge retains its current
page/session/epoch checks and command deduplication. It accepts only `nodeIds`
and optional boolean `dryRun` for this tool.

Validation uses synthetic Node fixtures, an in-memory Python bridge and one
isolated browser page with every request intercepted. The browser test covers
default preview without save, save/reload, immutable historical edges,
multi-output preservation, stale page/project refusal, busy/read-only refusal
and retained local changes after a save conflict. No live canvas or GPU task is
part of this acceptance.
