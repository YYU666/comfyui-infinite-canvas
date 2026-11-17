# Local PCG demo viewer API

This separate, read-only viewer uses repository-authored ES modules and browser WebGL2. It fetches no models, images, materials, shaders, URLs, or external resources. The page supplies an already authorized same-origin GLB ArrayBuffer.

## CPU decoder

`parseGlb(arrayBuffer)` in `pcg_demo_viewer/glb.js` returns:

- `meshes[].primitives[]`: Float32Array `positions`, optional Float32Array `normals` / `uvs`, optional Uint32Array `indices`, glTF `mode` (0 points or 4 triangles), `vertexCount`, `triangleCount`, `pointCount`, local `bounds`.
- `instances[]`: mesh index, stable node name, Float64Array column-major `worldMatrix`, Float32Array column-major `normalMatrix`. Nested node TRS and affine matrices compose in scene order. A node cannot have multiple parents or be cyclic.
- `bounds`: conservative world AABB across every visible instance and primitive. Empty scenes have zero bounds. Finite coordinates are meters, right handed, Y up.
- `metrics`: visible unique `meshCount`, full `instanceCount`, unique used `primitiveCount`, estimated actual instanced `drawCalls`, rendered `triangleCount` / `pointCount`, unique used `vertexCount`, estimated `gpuBytes`.

The subset is GLB 2.0 with a single internal BIN buffer, packed float32 VEC3 positions/normals, float32 VEC2 UVs, uint16 or uint32 scalar indices, points/triangles, and node TRS or affine matrix transforms. Missing triangle normals are computed from the actual triangles. Bounds are derived from arrays, not trusted accessor metadata. Materials, texture/image resources, extensions, buffer URIs, sparse/strided accessors, animations, skins, other primitive modes, and unknown properties are rejected. There is no generic format fallback or silent geometry sampling.

Limits: 64 MiB GLB; 8 MiB JSON; 64 MiB aggregate decoded accessor data; 64 meshes; 128 total primitives; 360000 total primitive vertices; 100000 unique triangles; 10000 nodes/visible mesh instances; nesting depth 64; 2000000 rendered triangles; 1000000 rendered points. Local scalar magnitude is at most 1e6 and world values/bounds at most 1e12. Singular or extremely small composite determinants (absolute determinant below 1e-24) are rejected. All arrays/counts/indices and source float values are checked before GPU upload. Errors carry `code` such as `INVALID_GLB`, `UNSUPPORTED_GLB`, or `BUDGET_EXCEEDED`.

## Browser viewer

`createViewer(canvas, {onFrame} = {})` in `pcg_demo_viewer/renderer.js` returns:

- `await load(arrayBuffer, identity)`: parse, yield for epoch arbitration, stage GPU buffers, yield again, validate upload, and replace the scene only for the newest still-active load. Visible pages draw the candidate before resolving. The result is a `getState()` snapshot, with counts accessible both directly and through `metrics`. Identity is copied, finite JSON limited to 4096 encoded characters, depth 8 and 64 items per object/array.
- `setRotating(boolean)`: pause/resume the Y-up turntable. Pausing draws one current frame and leaves no animation callback scheduled.
- `getState()`: copied serializable status, identity, camera, counts and errors. Mutating the returned object cannot change the viewer.
- `dispose()`: idempotently invalidates pending loads, cancels animation, disconnects listeners/resize observer, deletes owned GPU buffers, VAOs and shader program, and clears the displayed identity/counts.

`onFrame(state)` receives the same copied snapshot after an actual draw and after relevant visibility, error, disposal and context events. Therefore callbacks do not themselves prove a draw occurred. Integration must gate display acknowledgment on the expected `loadedIdentity`, `cameraFramed === true`, and `sceneFrameCount >= 1`. `frameCount` is lifetime actual draws, while `sceneFrameCount` resets on successful scene replacement. `yaw`/`angle` are radians used by the actual draw. Metrics are also exposed at top level for compact read-back.

State fields: `status` (`ready`, `displaying`, `hidden`, `error`, `disposed`), `loadedIdentity`, `frameCount`, `sceneFrameCount`, `yaw`, `angle`, `rotating`, `visible`, `cameraFramed`, `camera`, `bounds`, `error`, `contextLost`, `metrics`. Camera reports world `center`, bounding `radius`, world `eye`, `distance`, `near`/`far`, vertical `fovDegrees`, and aspect. Rendering rebases/normalizes world coordinates before float32 upload to retain camera precision; the reported camera remains in source units. A bounding sphere frames all orientations at the current viewport aspect.

Native instancing uploads one geometry buffer set per used primitive and one transform/normal matrix set per mesh group; all nodes draw without expanding prototypes. UV data is validated and retained by the decoder; this viewer uses a fixed local surface color and lighting, with no material/texture loader.

A failed parse or upload preserves the previous scene, loaded identity, framing and GPU ownership, while reporting the current error. Superseded loads reject `STALE_LOAD` and cannot overwrite the newest state, even with an error. Hidden-page loads can finish GPU staging and resolve `status:'hidden'`, `cameraFramed:false`, `sceneFrameCount:0`. No animation callback or draw runs while the document is hidden. Visibility restoration performs the first draw and emits its state, allowing acknowledgment then. Context loss cancels animation and clears displayed identity/counts with `CONTEXT_LOST`; restoration rebuilds the program but requires the page to load a managed asset again. Pending loads are invalidated on context loss/disposal.

## Local verification

`node --test test-pcg-demo-viewer.mjs` generates actual Mesh, rock, PointSet and shared-instance GLBs in memory through the existing Python exporter. It tests strict decode/budgets/transforms and lifecycle/ownership/races with a WebGL API double. It does not claim real GPU pixels: the integrating browser test must independently check visible geometry, turntable changes, camera framing and active identity. No model or screenshot payload is sent to a network or model.

## M4 finite update contract

`update(arrayBuffer, identity, kind)` accepts `mesh-delta` or `instance-delta`
after transport reconstruction. It independently parses/validates topology,
indices, UVs, stable instance identities and unchanged prototype as appropriate.
Mesh updates reuse index buffers; instance updates reuse prototype buffers.
Allocation/upload/draw/stale failure rolls back identity and scene atomically;
shared buffers use reference counts so rollback cannot delete the old scene.
`getState().resources` reports logical allocation/deletion/live byte counters,
VAOs and reuse counts; these are not physical device-memory telemetry.
`updateKind` identifies the last committed path.

`reconstructPreview(baseArrayBuffer, descriptor, transportArrayBuffer)` in
preview-stream.js validates version, bounded fields, lengths, canonical base64,
nonoverlapping positive ranges, and transport/base/reconstructed SHA256. Its
result is independent bytes, never mutating the retained base. The integrating
application also binds descriptor target ID/hash/bytes to the selected managed
asset, and base ID/hash to its captured retained base. A self-consistent descriptor
alone does not establish that binding. See preview-stream-v1.json schemas.
