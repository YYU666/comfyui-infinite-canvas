# Local Native3D asset processing

The 3D asset processing menu creates project-bound model, LOD, UV and bake nodes. Import a local GLB or OBJ into the model node, then connect the model to the required stage. The viewer retains the input and lets you inspect saved results. Operations and optional adapters report readiness independently.

Use a dedicated Python environment for processing. Configure its executable via H3_NATIVE3D_PYTHON or the workbench runtime native3d-config.json pythonExecutable setting. The optional dependency recipe is requirements-native3d.txt, which is separate from the workbench dependency lock. Additional reduction adapters can require their own environments or weights. Source and result files are kept in local project storage. The project setup and model licences apply to any optional adapter.

The processing implementation comes from the 1.1.45 baseline and includes the deployed LOD count, annular UV, and texture sampling updates. Run `python scripts/setup_native3d.py --venv <path>` to create the optional environment.
