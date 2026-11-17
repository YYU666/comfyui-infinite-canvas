# Workflow provenance inventory

This directory documents generic interfaces and model provenance reviewed on 2026-11-17, starting from `977faf9795b70be2e68137015bd9a2f1fd89532f`. It does not install models, execute workflows, add menu entries, change runtime behavior, or certify generated output.

- [workflows.json](workflows.json): eight generic interface summaries, source references and known original JSON hashes. A missing source commit stays null; a baseline commit is never substituted for the origin of generated files.
- [models.lock.json](models.lock.json): 41 complete metadata entries, including two GGUF entries. Every entry names its repository, fixed revision, upstream filename, byte size, SHA-256 and license source. Metadata was obtained from trusted source manifests and official model-card/LFS metadata; no weights are bundled or downloaded by this change.
- [unresolved.json](unresolved.json): nine exact author dependencies and eleven other incomplete records excluded from the model lock, plus license gaps and manual auxiliary prerequisites.

## Publication and menu boundaries

Krea2 → MOSS is a structural comparison with two independently decoded/re-encoded image stages. Upstream workflow redistribution permission is unconfirmed. The original JSON and both adapted h3pack files are excluded; its interface and original JSON hash are references only. The author-exact variant also lacks nine exact dependencies and has incompatible rebalance settings. Alternate quantizations in the local baseline are explicitly different dependencies, not substitutes advertised as equivalent.

Character-sheet documentation describes a generic interface: portraits cropped above the chest and **headless front/back body panels**. The optional six-panel extension adds complete front/back long-hair views; ordinary characters retain four panels. The extension is a third-party node-library recipe, not a new official built-in menu entry. Subject-specific approved recipes, prompts, project files, source media and generated results are excluded. The runtime implementation must be decoupled from private recipes before it can be published separately.

White-plate extraction and colored-normal character replacement are proposed VFX/animation features and require feature review. RTX/SeedVR video upscale and local CPU overlay repair belong to their separate implementation review. Relighting research used the existing Qwen editor; this inventory does not imply a new IC-Light implementation. No listed interface becomes an official menu entry through this documentation.

## Model formats and terms

The model catalog contains only `.safetensors` and `.gguf` entries. The official pose workflow also requires `dw-ll_ucoco_384.onnx` and `yolox_l.onnx`; they are listed only as manual auxiliary prerequisites and are explicitly excluded from the model catalog and binaries. Consequently, MOSS pose is blocked under the current format policy. Missing dependencies are never silently omitted from a completeness claim or replaced with similar files.

The upstream HyperFlow entry is a Diffusers-layout research reference. It is **not** a loadable ComfyUI LoRA and must not be renamed to impersonate one. Full Flux2 VAE and small Flux2 VAE remain different entries and must not be interchanged. RTX requires a separate SDK and its own terms, rather than a catalog model weight.

License names and official source links are provenance, not permission grants. Custom author terms, base-model terms, territorial restrictions, attribution, hosting and commercial-use conditions apply independently. In particular, review the original QuadView Civitai listing and each model's pinned terms before use or redistribution. No model redistribution is performed here.

## Validation

Run `python docs/workflows/test_catalog.py` for offline catalog, provenance and privacy contract checks. The checks use no services, browser, queues or model files. They reject incomplete catalog entries, unsupported model extensions, unpinned revisions, malformed hashes, invalid byte sizes, missing license sources, broken model references and machine-specific paths.
