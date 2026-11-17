# Generic character-sheet migration candidate

This feature branch starts at main `977faf9795b70be2e68137015bd9a2f1fd89532f`. It migrates the existing generic character-sheet branches from the reviewed runtime, rather than replacing the application with that runtime snapshot. No menu category, model download, service operation or live generation is included.

The delivered sheet has two portraits above the chest and **headless front/back body panels**. Intermediate complete-body images retain the head and feet so the rear view can inherit the accepted front proportions and outfit. Only final delivery panels are cropped; the rear stage never takes a headless crop as its conditioning source. Delivery crops and portrait framing are explicit editable pixel rectangles. The existing defaults are a starting point requiring inspection; there is no automatic anatomy or arbitrary-character framing guarantee.

Inputs remain distinct: the identity image controls facial identity; optional body reference controls proportions/outfit; optional rear reference controls rear clothing/structure only. The source-anchored mode uses the original identity reference for both portraits. Single-stage retries use their visible seed. A missing body reference falls back to identity; a missing rear reference selects the actual no-rear graph, without inventing a rear image.

The private fixed-recipe JSON and its defaults are excluded. The public resolver accepts only `generic-v2`, rejects unknown recipe versions and strips hidden frozen-prompt/model overrides. It does not preserve or import a private fixed recipe. Tests use synthetic filenames and prompts.

Native builders, roles, settings, controls, serial plan validation and staged extension versions 1–5 are migrated together. Main's completion event buffer and wait API are retained; only the sheet inspection stitch index is made dynamic. One candidate-specific compatibility adaptation accepts the existing generic stable panel order without an optional portrait preprocessing stage as version 2. This adaptation is newly authored for the isolated migration and is not claimed to be byte-identical runtime behavior.

Optional long-hair six-panel generation is not included: the retained package contains only the four-view stages and no hair stages. Ordinary characters keep four panels. A future third-party node-library recipe for complete front/back long-hair display must be reviewed separately and must not be advertised as a new built-in menu item.

Validation is offline: frontend build; synthetic dual/back role, output-crop and private-field rejection contracts; staged export/import/fallback; serial queue cancellation/restart/inspection and existing outfit/queue regressions. No private reference images or actual inference were used. UI appearance and generated identity/framing quality still require separate acceptance.

## Merge gate

The migrated execution versions 2–5 still carry the local development minimum `>=1.0.6`. Public 1.0.17 only reads version 1. This is a known compatibility blocker: set a truthful minimum/capability gate on both export and import, with tests, once the actual first supporting release is chosen. Do not publish new staged packages or merge this draft with that historical minimum. This feature is not included in the small-fix release. The new frontend contract is explicitly registered in normal Node CI.
