# Compact layout and media lifecycle acceptance

The deployed source packs rows with 44-unit gaps, places references before their consumers and reserves stable 440×550 image/video/result cards. Hidden backing images retain their persisted IDs and edges; only presentation is mapped to the owning result card. Main sprite-atlas integration is retained.

Production acceptance, recorded before this synchronization: 406 total nodes, 307 visible nodes and 431 edges; revision 1682→1683 moved 405 nodes, with unchanged content/edge signature after saving and reloading. Source and saved-snapshot hashes are in layout-acceptance.json. Private project snapshots, IDs, images and screenshots are excluded.

The current-main integration additionally passes a synthetic 406-node/431-edge serialization/reload fixture, overlap checks, deterministic repeated layout, and the complete 52-file Node suite. Isolated Chromium checks prove consistent card geometry at zoom levels, release of offscreen image previews/video players, full-image access and separated compact custom input ports. All requests are mocked; no running service was changed during synchronization.

Neutral review found one P2: completed custom input ports shared an unspecified offset. Indexed positions and accessible handle titles now keep them separate; the two-input geometry regression passes. Review decision: accept after repair.

Limits: runtime measurement dimensions are not serialized, so tidying complex expanded tools after a fresh reload can adjust gaps slightly. This does not alter saved node positions on reload. No percentage claim is made for FPS or total browser memory. Video-editor/other complex tool previews are outside this patch. Main integration hashes differ from shared deployed glue because newer main safety fixes and sprite-atlas are retained. See layout-source-sha256.json.
