# Natural macro UV candidate — 2026-11-06

Planner `ai-structural-ao-v2-macro-uvatlas1` uses the existing
`ai_structure_ao_v2` settings and cached high-surface PartField/AO evidence.
Old immutable plans retain their original backend. No AI inference is repeated
during unwrap.

The macro policy protects AI/manual boundaries, preserves substantial structural
regions, and absorbs structural regions smaller than 0.2% of total surface area
only within their AI base group. Internal structural slits become explicitly
recorded **review-only soft evidence**, not UVAtlas constraints or weights.
The reviewed LOD0 changed from 685 to 57 hard groups: 1,853 hard edges and
5,508 soft edges. This does not claim all old 7,361 constraints are enforced.
The plan records before/after area distributions and per-reason dispositions.

UVAtlas receives explicit adjacency with hard edges disconnected. Output uses
original double-precision positions through the returned source-vertex map.
Every source face corner, complete source-face permutation, and actual hard seam
is checked. No circle boundary, geometry repair, face deletion, or deliberate
single-face isolation is used.

Packing uses xatlas only to propose placements. Its independently pixel-rounded
chart dimensions are discarded. Original double-precision chart shapes are
reconstructed with one common scale after per-chart density normalization and
world-up mean alignment; packing rotation is disabled. Final float64 and exported
float32 UVs are independently checked for geometric and raster overlap,
orientation, bounds, and requested 16-pixel inter-island spacing at 4096.

## LOD0 candidate evidence

Artifacts: `.cache/native3d/uv-production-v1/full-uvatlas/`.
Key files: `packed-final.npz`, `packed-report.json`, `shape-summary.json`,
`independent-source-seam-review.json`, `packed/uv-layout.png`.

- Exactly 100,000 original triangles; all 1,853 hard edges retained.
- 67 islands; zero float64/float32 geometric overlap, raster interior overlap,
  flips, degeneracy, or 16-pixel spacing violations.
- Triangle area occupancy 50.968%; tile margin 18.2445 pixels.
- Area-weighted stretch P95 2.08816; area over stretch 3 is 1.1951%; maximum
  stretch 50.7156. Stretch remains a disclosed warning, not a hidden exemption.
- 14 singleton islands occupy 0.00703% of surface area; 39 islands with at most
  four faces occupy 0.06091%. These remain from protected partitions/library
  charting, not intentional single-face repair.
- `worldUpFaceConsistency=false`: local tangent angle P95 119.68 degrees and
  opposite area 9.42%. Mean island orientation is aligned; curved surfaces do
  not all share that direction. This warning remains visible and was accepted
  for proceeding to actual canvas UV/bake review, rather than adding more cuts.

## Runtime and cache

`native3d_uv_uvatlas_runtime.runtime_status()` reports local readiness.
The Windows native wrapper is built by `scripts/build-native3d-uvatlas.ps1`;
the wrapper sources/build metadata and MIT notices are in
`scripts/native3d-uvatlas/`. UVAtlas 1.9.2 is pinned to commit
`3a7eaedb26dec6c1a5b5321692b6da2a6902cd4c`. This is an explicit native dependency,
not a claim of an installation-free cross-platform runtime. No runtime download
or installation is triggered. `NATIVE3D_UVATLAS_EXECUTABLE` overrides discovery.

Verified per-group parameterizations are reusable across jobs under the module's
`.cache/native3d/uvatlas-group-cache/`, or `NATIVE3D_UVATLAS_GROUP_CACHE`.
Identity covers exact geometry, face/group order, hard-edge topology and solver
version/settings. Human-readable edge reason labels are provenance, not solver
inputs. Reuse validates bytes and source mapping and still performs current-plan
seam, overlap, packing, raster, and float32 export checks. It never bypasses QA.

`cache-promotion.json` records the validated LOD0 candidate registration for
actual plan `15479632f9989349a860140aad754ba39a87bdca92a3da0e7f164b581637388a`.
Its geometry, group owner array, and hard-edge set exactly match the candidate;
1,763 edge reason labels differ without changing constraints. No project asset
was injected during this local candidate work.
