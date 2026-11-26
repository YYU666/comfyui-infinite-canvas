# Local UVAtlas runtime

Microsoft UVAtlas 1.9.2, MIT license; pinned source commit `3a7eaedb26dec6c1a5b5321692b6da2a6902cd4c` from https://github.com/microsoft/UVAtlas. Retain UVAtlas-LICENSE.txt with redistributed binaries. No Blender or commercial API. The library alone needs no DirectXMesh/DirectXTex; those are upstream CLI dependencies.

Run scripts/build-native3d-uvatlas.ps1 using existing CMake3.21+, Git, Visual Studio2022 C++ tools and Windows SDK. It downloads source into the local cache and builds without installing system software. Existing source must match the reviewed commit and be clean. Runtime prefers runtime-build/Release/patch.exe, with the previously verified probe-build binary as migration fallback. NATIVE3D_UVATLAS_EXECUTABLE may select a different absolute local binary; it must implement this exact fixed protocol.

Native input: little-endian uint32 vertexCount, faceCount; float32[vertexCount,3] positions; uint32[faceCount,3] faces; uint32[faceCount,3] adjacency. Adjacency entry j references edge face[j] to face[(j+1)%3]; UINT32_MAX means boundary/hard cut. falseEdgeAdjacency is deliberately null: that API means must-not-cut, not hard seams.

Native output: uint32 vertexCount, faceCount, chartCount; float32 nativeStretch; float32[vertexCount,2] UV; uint32[faceCount,3] faces; uint32[vertexCount] sourceVertex; uint32[faceCount] partition. Face order and source corner mapping are verified inside native code and again by Python. Original double geometry is reconstructed from sourceVertex; no native positions replace original positions.

Fixed settings: maxChartNumber0 (stretch driven), maxStretch0.3, 4096square atlas,16pixel gutter, UVATLAS_DEFAULT,180second callback budget and210second process timeout. Native stretch is not the application's P95 metric. This adapter does not certify zero overlap, distortion, final repacking or gutters: downstream complete gates remain mandatory.
