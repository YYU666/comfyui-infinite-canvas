# Frontend stability audit — 2026-11-03

Scope: current candidate source changes and their interactions with canvas persistence, Qwen reference/mask workflows, clipboard/history, queue reconciliation, workflow library exchange, and asynchronous video import. Review used source inspection, pure tests, and synthetic browser fixtures with every HTTP request intercepted. No real project, generation queue, user asset, external website, or model download was modified by this audit.

## Confirmed defects and disposition

| Severity | Defect / trigger | Disposition |
| --- | --- | --- |
| P1 | In the mask editor, Ctrl+Z handled the brush undo and then bubbled to the canvas history listener. A newly created mask node could be removed by the same keypress, destroying the drawing session. Delete/Backspace and duplicate shortcuts could also reach canvas handlers. | Fixed in `src/MaskEditor.jsx`: capture keyboard events within modal lifetime, keep mask undo local, isolate destructive/duplicate shortcuts, contain Tab focus and restore focus on close. Regression against the prior build reproduced disappearance of the editor after Ctrl+Z. |
| P2 | Video-link import was not tracked in the media save barrier. Project switching, leaving the canvas, or refresh while downloading could discard the eventual node. The importer also returned success before a persisted canvas revision. | Fixed in `src/CanvasWorkbench.jsx`: one tracked import per page, shared media barrier and unload protection, navigation guard, mounted operation/project identity checks, synchronous node commit, success only after canvas persistence. Failed saves retain the visible node and explain recovery without redownloading. |
| P2 | Legacy video-reference import validated capacity and generator state only before the asynchronous download. Extra connections, mode changes, deletion, or generation while awaiting the download could produce excess or invalid connections. | Fixed in the same importer: revalidate destination, mode, busy state and 1/3-video limit after the download before writing. |
| P2 | `pasteClipboard`, `addNode`, and file paste did not themselves guard read-only projects; Ctrl+D or paste could create transient nodes that could not be saved. | Reported to parent and parent applied read-only guards in the shared component. End-to-end verification belongs to the integrated candidate run. |
| P2 | History restore during an in-flight immutable asset upload could be overwritten when the asynchronous upload committed to the same node ID. | Reported to parent; parent added the media-write barrier to undo/redo. Integrated candidate run owns final verification. |

## Evidence

- Isolated build: `npx vite build --outDir .cache/frontend-audit-dist` passed. Existing bundle-size warning remains.
- `H3_TEST_DIST_DIR=.cache/frontend-audit-dist node test-qwen-mask-ui.mjs` passed. New checks verify actual brush pixel undo, unchanged node/edge identity after Ctrl+Z/Shift+Z/Y/D/Delete/Backspace, and Tab focus containment, followed by drawing, save/import/reload and Qwen mask submission to the intercepted queue.
- `H3_TEST_DIST_DIR=.cache/frontend-audit-dist node test-video-download-ui.mjs` passed. Covers delayed download/save, project-switch rejection, beforeunload protection, concurrent import rejection, acknowledgement after persistence, reload, deletion of the origin, and a reference capacity change while downloading.
- Pure tests passed: `test-canvas-mask.mjs`, `test-qwen-mask.mjs`, `test-qwen-references.mjs`, `test-auto-save.mjs`, `test-generation-queue.mjs`, `test-canvas-history.mjs`, `test-canvas-clipboard.mjs`, `test-reference-tags.mjs`, `test-refmuse-canvas-bridge.mjs`, `test-project-store-http.mjs`, `test-local-node-tools.mjs`.
- Source checks covered original-mask final compositing, crop/stitch topology, stable reference numbering and dangling-reference rejection, queue completion idempotence/stale-job rejection, and private-free workflow placeholder construction. No additional confirmed defect found in those reviewed paths.

## Local tool distribution review

Normal production/dev builds return an empty local-tool registry before reading the private manifest. An explicit `local-tools` mode loads ignored configuration, and both menu registration and MCP creation enforce the enabled preset set. Saved legacy node definitions remain supported. The update-package builder rejects local manifests, `.h3pack` files, cached output, `dist`, and `node_modules` in the tracked release input.

This is registration/package isolation, not removal of legacy workflow implementations from published source: compatibility code stays to open saved projects. Release communication must preserve that distinction.

## Limits

This audit verifies deterministic behavior and browser interaction on synthetic fixtures. It does not certify visual model quality, all third-party workflow variants, remote-site availability, actual video platform downloads, or long-duration GPU execution. The final build and full integrated suite must run after parallel changes have converged; tomorrow's human interaction test remains the release acceptance step.

Visual transport: zero-payload-local-analysis; model-visible images used: 0.

## Independent interaction review

Reviewed `src/canvas-connections.js`, the shared `connectionPlan`/`onConnect` path, reverse-drag endpoint normalization, click-connection cancellation, dynamic handle remeasurement, enlarged hit areas, and `canvas_connect_nodes` edge acknowledgements. Confirmed that:

- Both UI validation and API mutation use the same planner; invalid type, read-only, busy target, mask-source constraints and reference capacity errors fail before changing edges.
- A generator output resolves only to one already-saved media node matching its current result URL and origin. Missing/ambiguous results fail; connections persist against the media node rather than a future generation.
- Mask guide replacement is blocked while its consumer is running. Qwen first-image crop protections remain in the existing disconnect/reorder paths, and mask source identity remains validated before generation.
- Mode changes remeasure ports; input-first drags normalize source/target roles for feedback. API success waits for the actual planned edge ID, including generator-to-result resolution.
- `node test-canvas-connections.mjs` passed independently. The interaction worker owns pointer hit-area regression fixtures; the parent owns the final integrated browser suite. No additional confirmed blocking defect was identified in this review.
