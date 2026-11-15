"""Render a local animated GLB/FBX into paired, unlit sprite atlases.

Run with Blender's bundled Python, never with ComfyUI.  The JSON request is the
only input; no model scripts are executed.  This module's PNG/validation helpers
also run under ordinary Python for isolated tests.
"""
from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path
import struct
import sys
import tempfile
import zlib


SCHEMA = "refmuse.sprite-atlas.v1"
MAX_PIXELS = 64_000_000


def validate_request(raw):
    if not isinstance(raw, dict):
        raise ValueError("Sprite request must be a JSON object.")
    request = dict(raw)
    for name in ("inputPath", "outputDir"):
        if not isinstance(request.get(name), str) or not request[name]:
            raise ValueError(f"{name} must be an absolute local path.")
        if "://" in request[name] or request[name].startswith(("\\\\", "//")) or not Path(request[name]).is_absolute():
            raise ValueError(f"{name} must be an absolute local path; URLs and network shares are unsupported.")
        request[name] = str(Path(request[name]).resolve())
    if Path(request["inputPath"]).suffix.lower() not in {".glb", ".fbx"}:
        raise ValueError("Only .glb and .fbx input files are supported.")
    for name, default, low, high in (("directions", 8, 4, 16), ("frameSize", 192, 32, 1024), ("framesPerAction", 8, 1, 64)):
        value = request.get(name, default)
        if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
            raise ValueError(f"{name} must be an integer in [{low}, {high}].")
        request[name] = value
    if request["directions"] not in (4, 8, 16):
        raise ValueError("directions must be 4, 8, or 16.")
    for name, default, low, high in (("elevation", 10, 0, 60), ("startYaw", 0, -360, 360), ("padding", .1, 0, .4)):
        value = request.get(name, default)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= value <= high:
            raise ValueError(f"{name} must be a finite number in [{low}, {high}].")
        request[name] = float(value)
    pivot = request.get("pivot", [.5, .9])
    if not isinstance(pivot, (list, tuple)) or len(pivot) != 2 or any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or not .01 <= v <= .99 for v in pivot):
        raise ValueError("pivot must contain two normalized coordinates in [.01, .99].")
    request["pivot"] = list(pivot)
    actions = request.get("actions", [])
    if not isinstance(actions, list) or len(actions) > 8 or any(not isinstance(a, str) or not a or len(a) > 200 for a in actions) or len(set(actions)) != len(actions):
        raise ValueError("actions must be a list of up to eight unique animation names.")
    request["actions"] = actions
    return request


def atlas_dimensions(request, action_count):
    if not 1 <= action_count <= 8:
        raise ValueError("Select one to eight animation clips; no clips are silently dropped.")
    width = request["frameSize"] * request["framesPerAction"]
    height = request["frameSize"] * request["directions"] * action_count
    if width > 8192 or height > 8192 or width * height > MAX_PIXELS:
        raise ValueError("Atlas exceeds the 8192px side or 64M pixel limit; reduce frame size, directions, frames, or actions.")
    return width, height


def _chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xffffffff)


def write_rgba_png(path, width, height, pixels):
    """Write raw RGBA8 rows, without applying a color transform to normal data."""
    stride = width * 4
    if len(pixels) != stride * height:
        raise ValueError("RGBA buffer dimensions do not match.")
    compressor = zlib.compressobj(6)
    with Path(path).open("wb") as file:
        file.write(b"\x89PNG\r\n\x1a\n")
        file.write(_chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)))
        for row in range(height):
            data = compressor.compress(b"\0" + pixels[row * stride:(row + 1) * stride])
            if data:
                file.write(_chunk(b"IDAT", data))
        file.write(_chunk(b"IDAT", compressor.flush()))
        file.write(_chunk(b"IEND", b""))


def read_rgba_png(path):
    """Read Blender's non-interlaced RGBA8 PNG output with all five filters."""
    payload = Path(path).read_bytes()
    if payload[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("Invalid rendered PNG signature.")
    offset, compressed, width, height = 8, bytearray(), 0, 0
    while offset < len(payload):
        length = struct.unpack(">I", payload[offset:offset + 4])[0]
        kind, data = payload[offset + 4:offset + 8], payload[offset + 8:offset + 8 + length]
        offset += length + 12
        if kind == b"IHDR":
            width, height, depth, color, comp, filt, interlace = struct.unpack(">IIBBBBB", data)
            if (depth, color, comp, filt, interlace) != (8, 6, 0, 0, 0):
                raise ValueError("Renderer must produce non-interlaced RGBA8 PNGs.")
        elif kind == b"IDAT":
            compressed.extend(data)
        elif kind == b"IEND":
            break
    stride = width * 4
    raw = zlib.decompress(compressed)
    if not width or not height or len(raw) != (stride + 1) * height:
        raise ValueError("Invalid rendered PNG dimensions or payload.")
    output, previous = bytearray(stride * height), bytearray(stride)
    for y in range(height):
        start = y * (stride + 1)
        mode, row = raw[start], bytearray(raw[start + 1:start + 1 + stride])
        for x in range(stride):
            left, above, upper_left = row[x - 4] if x >= 4 else 0, previous[x], previous[x - 4] if x >= 4 else 0
            if mode == 1:
                row[x] = (row[x] + left) & 255
            elif mode == 2:
                row[x] = (row[x] + above) & 255
            elif mode == 3:
                row[x] = (row[x] + ((left + above) // 2)) & 255
            elif mode == 4:
                estimate = left + above - upper_left
                distances = (abs(estimate - left), abs(estimate - above), abs(estimate - upper_left))
                predictor = (left, above, upper_left)[distances.index(min(distances))]
                row[x] = (row[x] + predictor) & 255
            elif mode != 0:
                raise ValueError("Invalid PNG row filter.")
        output[y * stride:(y + 1) * stride] = row
        previous = row
    return width, height, output


def _animation_owners(objects):
    owners = []
    for obj in objects:
        for owner in (obj, obj.data, getattr(obj.data, "shape_keys", None)):
            if owner and getattr(owner, "animation_data", None) and owner not in owners:
                owners.append(owner)
    return owners


def _render_objects(view_layer):
    """Exclude hidden import-helper collections from both framing and materials."""
    visible = set()

    def visit(layer):
        if layer.exclude or layer.collection.hide_render:
            return
        visible.update(obj for obj in layer.collection.objects if not obj.hide_render)
        for child in layer.children:
            visit(child)

    visit(view_layer.layer_collection)
    return visible


def discover_clips(objects, bpy):
    """Keep importer NLA clip groups and Action slots, including multi-object clips."""
    groups = {}
    owners = _animation_owners(objects)
    for owner in owners:
        animation = owner.animation_data
        for track in animation.nla_tracks:
            # Multiple-strip tracks are not equivalent to a single exported clip.
            if len(track.strips) != 1:
                raise ValueError(f"Animation track {track.name!r} contains multiple strips; export each action as a separate clip.")
            for strip in track.strips:
                if not strip.action:
                    continue
                name = track.name
                binding = (owner, strip.action, getattr(strip, "action_slot", None))
                groups.setdefault(name, []).append(binding)
        if animation.action and not animation.nla_tracks:
            # FBX creates all takes as datablocks but attaches only the first
            # take to its owner; the importer names them "owner|take".
            fbx_takes = [action for action in bpy.data.actions if action.name.startswith(owner.name + "|")]
            if fbx_takes:
                for action in fbx_takes:
                    slots = [slot for slot in action.slots if slot.target_id_type == owner.id_type]
                    if len(slots) > 1:
                        raise ValueError(f"Ambiguous slots in FBX action {action.name!r}.")
                    groups.setdefault(action.name[len(owner.name) + 1:], []).append((owner, action, slots[0] if slots else None))
            else:
                groups.setdefault(animation.action.name, []).append((owner, animation.action, getattr(animation, "action_slot", None)))
    if not groups:
        # A static mesh remains useful as a single one-frame pose, repeated if requested.
        groups["Static"] = []
    return groups, owners


def _activate_clip(bindings, owners, object_bases, pose_bases, shape_bases, scene):
    for owner in owners:
        animation = owner.animation_data
        animation.action = None
        for track in animation.nla_tracks:
            track.mute = True
    for obj, basis in object_bases:
        obj.matrix_basis = basis.copy()
    for bone, basis in pose_bases:
        bone.matrix_basis = basis.copy()
    for key, value in shape_bases:
        key.value = value
    for owner, action, slot in bindings:
        owner.animation_data.action = action
        if slot is not None:
            owner.animation_data.action_slot = slot
    scene.frame_set(0)


def _sample_frames(bindings, count):
    if not bindings:
        return 0., 0., [0.] * count
    start = min(float(action.frame_range[0]) for _, action, _ in bindings)
    end = max(float(action.frame_range[1]) for _, action, _ in bindings)
    # Endpoint excluded: looped clips do not duplicate the first pose at the seam.
    frames = [start + (end - start) * index / count for index in range(count)]
    return start, end, frames


def _set_frame(scene, value):
    integer = math.floor(value)
    scene.frame_set(integer, subframe=value - integer)


def _bounds(meshes, bpy, Vector):
    depsgraph = bpy.context.evaluated_depsgraph_get()
    return [evaluated.matrix_world @ Vector(corner) for obj in meshes for evaluated in [obj.evaluated_get(depsgraph)] for corner in evaluated.bound_box]


def _camera_basis(yaw, elevation, Vector):
    theta, phi = math.radians(yaw), math.radians(elevation)
    towards = Vector((math.sin(theta) * math.cos(phi), -math.cos(theta) * math.cos(phi), math.sin(phi)))
    rotation = (-towards).to_track_quat("-Z", "Y")
    return rotation, rotation @ Vector((1, 0, 0)), rotation @ Vector((0, 1, 0)), towards


def _copy_socket(tree, source, destination):
    if source.is_linked:
        tree.links.new(source.links[0].from_socket, destination)
    else:
        destination.default_value = source.default_value


def _emission_material(original, normal, bpy):
    material = original.copy() if original else bpy.data.materials.new("Sprite default")
    material.use_nodes = True
    tree = material.node_tree
    principled = next((node for node in tree.nodes if node.type == "BSDF_PRINCIPLED"), None)
    output = next((node for node in tree.nodes if node.type == "OUTPUT_MATERIAL" and node.is_active_output), None)
    if output is None:
        output = tree.nodes.new("ShaderNodeOutputMaterial")
    if original and principled is None:
        raise ValueError(f"Material {original.name!r} is not a Principled BSDF material; convert it to glTF PBR before baking.")
    emission = tree.nodes.new("ShaderNodeEmission")
    emission.inputs["Strength"].default_value = 1
    if normal:
        geometry = tree.nodes.new("ShaderNodeNewGeometry")
        source_normal = principled.inputs["Normal"].links[0].from_socket if principled and principled.inputs["Normal"].is_linked else geometry.outputs["Normal"]
        # Explicit world-basis dot products avoid renderer-dependent camera-Z
        # conventions. These basis vectors are updated once per view below.
        transform = tree.nodes.new("ShaderNodeCombineXYZ")
        for axis, name in zip(("X", "Y", "Z"), ("right", "up", "towards")):
            dot = tree.nodes.new("ShaderNodeVectorMath")
            dot.name, dot.operation = f"Sprite camera {name}", "DOT_PRODUCT"
            tree.links.new(source_normal, dot.inputs[0])
            tree.links.new(dot.outputs["Value"], transform.inputs[axis])
        normalize = tree.nodes.new("ShaderNodeVectorMath")
        normalize.operation = "NORMALIZE"
        tree.links.new(transform.outputs["Vector"], normalize.inputs[0])
        encode = tree.nodes.new("ShaderNodeVectorMath")
        encode.operation = "MULTIPLY_ADD"
        encode.inputs[1].default_value = (.5, .5, .5)
        encode.inputs[2].default_value = (.5, .5, .5)
        tree.links.new(normalize.outputs["Vector"], encode.inputs[0])
        tree.links.new(encode.outputs["Vector"], emission.inputs["Color"])
    elif principled:
        _copy_socket(tree, principled.inputs["Base Color"], emission.inputs["Color"])
    else:
        emission.inputs["Color"].default_value = (.8, .8, .8, 1)
    transparent, mix = tree.nodes.new("ShaderNodeBsdfTransparent"), tree.nodes.new("ShaderNodeMixShader")
    if principled:
        _copy_socket(tree, principled.inputs["Alpha"], mix.inputs[0])
    else:
        mix.inputs[0].default_value = 1
    tree.links.new(transparent.outputs[0], mix.inputs[1])
    tree.links.new(emission.outputs[0], mix.inputs[2])
    tree.links.new(mix.outputs[0], output.inputs["Surface"])
    return material


def _paste(atlas, width, tile, x, y, size):
    stride = size * 4
    for row in range(size):
        start = ((y + row) * width + x) * 4
        atlas[start:start + stride] = tile[row * stride:(row + 1) * stride]


def render(request):
    import bpy
    from mathutils import Vector

    request = validate_request(request)
    source, destination = Path(request["inputPath"]), Path(request["outputDir"])
    if not source.is_file():
        raise ValueError("Input model file does not exist.")
    if destination.exists() and any(path.name not in {"request.json", "job.json", "render.log"} for path in destination.iterdir()):
        raise ValueError("Output directory must not contain previous render artifacts.")
    destination.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    if source.suffix.lower() == ".glb":
        bpy.ops.import_scene.gltf(filepath=str(source), import_pack_images=True)
    else:
        bpy.ops.import_scene.fbx(filepath=str(source), use_anim=True, use_custom_props=False)
    objects = list(bpy.context.scene.objects)
    render_objects = _render_objects(bpy.context.view_layer)
    meshes = [obj for obj in objects if obj.type == "MESH" and obj in render_objects]
    if not meshes:
        raise ValueError("Model contains no renderable mesh.")
    groups, owners = discover_clips(objects, bpy)
    names = request["actions"] or list(groups)
    missing = [name for name in names if name not in groups]
    if missing:
        raise ValueError(f"Unknown animation actions: {missing!r}; available: {list(groups)!r}")
    width, height = atlas_dimensions(request, len(names))
    scene = bpy.context.scene
    fps = scene.render.fps / scene.render.fps_base
    scene.render.engine = "CYCLES"
    scene.cycles.device, scene.cycles.samples = "CPU", 1
    scene.cycles.use_denoising = False
    scene.cycles.use_adaptive_sampling = False
    scene.cycles.transparent_max_bounces = 16
    scene.render.threads_mode, scene.render.threads = "FIXED", 2
    scene.render.resolution_x = scene.render.resolution_y = request["frameSize"]
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = True
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.image_settings.color_depth = "8"
    scene.render.image_settings.compression = 15
    scene.view_settings.look = "None"
    scene.view_settings.exposure, scene.view_settings.gamma = 0, 1
    # Mesh imports may carry lights/cameras; only the new camera and unlit
    # materials participate. The renderer deliberately never uses a GPU.
    for obj in objects:
        if obj.type in {"LIGHT", "CAMERA"}:
            obj.hide_render = True
    object_bases = [(obj, obj.matrix_basis.copy()) for obj in objects]
    pose_bases = [(bone, bone.matrix_basis.copy()) for obj in objects if obj.type == "ARMATURE" for bone in obj.pose.bones]
    shape_bases = [(key, key.value) for obj in meshes for key in getattr(getattr(obj.data, "shape_keys", None), "key_blocks", [])]
    clips, all_bounds = [], []
    for name in names:
        start, end, frames = _sample_frames(groups[name], request["framesPerAction"])
        duration = (end - start) / fps
        clips.append({"name": name, "sourceStart": start, "sourceEnd": end, "sourceFrames": frames, "frameCount": len(frames),
                      "durationSeconds": duration, "playbackFps": len(frames) / duration if duration else 0})
        _activate_clip(groups[name], owners, object_bases, pose_bases, shape_bases, scene)
        for frame in frames:
            _set_frame(scene, frame)
            all_bounds.extend(_bounds(meshes, bpy, Vector))
    if not all_bounds or any(not math.isfinite(value) for corner in all_bounds for value in corner):
        raise ValueError("Model has invalid animated bounds.")
    anchor = Vector(((min(p.x for p in all_bounds) + max(p.x for p in all_bounds)) / 2,
                     (min(p.y for p in all_bounds) + max(p.y for p in all_bounds)) / 2,
                     min(p.z for p in all_bounds)))
    direction_metadata, bases = [], []
    labels8 = ["front", "front-right", "right", "back-right", "back", "back-left", "left", "front-left"]
    scale = 1e-5
    px, py = request["pivot"]
    for index in range(request["directions"]):
        yaw = request["startYaw"] + index * 360 / request["directions"]
        basis = _camera_basis(yaw, request["elevation"], Vector)
        bases.append(basis)
        right, up = basis[1:3]
        for point in all_bounds:
            x, y = (point - anchor).dot(right), (point - anchor).dot(up)
            scale = max(scale, x / (1 - px), -x / px, y / py, -y / (1 - py))
        label = labels8[index * 8 // request["directions"]] if request["directions"] <= 8 else f"direction-{index:02d}"
        direction_metadata.append({"index": index, "label": label, "yawDegrees": yaw})
    scale /= 1 - request["padding"]
    camera_data = bpy.data.cameras.new("Sprite orthographic camera")
    camera_data.type, camera_data.ortho_scale = "ORTHO", scale
    camera = bpy.data.objects.new("Sprite orthographic camera", camera_data)
    scene.collection.objects.link(camera)
    scene.camera = camera
    distance = max(scale * 4, 10)
    camera_data.clip_start, camera_data.clip_end = .001, distance * 4
    material_sets, original_slots = {}, {}
    for mesh in meshes:
        originals = [slot.material for slot in mesh.material_slots]
        if not originals:
            mesh.data.materials.append(None)
            originals = [None]
        original_slots[mesh] = originals
        for material in originals:
            if material not in material_sets:
                material_sets[material] = (_emission_material(material, False, bpy), _emission_material(material, True, bpy))
    albedo_atlas, normal_atlas = bytearray(width * height * 4), bytearray(width * height * 4)
    frame_metadata = []
    with tempfile.TemporaryDirectory(prefix=".frames-", dir=destination) as temporary:
        tile_path = Path(temporary) / "tile.png"
        for action_index, clip in enumerate(clips):
            _activate_clip(groups[clip["name"]], owners, object_bases, pose_bases, shape_bases, scene)
            for direction_index, (rotation, right, up, towards) in enumerate(bases):
                center = anchor - right * ((px - .5) * scale) - up * ((.5 - py) * scale)
                camera.location, camera.rotation_mode, camera.rotation_quaternion = center + towards * distance, "QUATERNION", rotation
                for _, normal_material in material_sets.values():
                    for name, basis in (("right", right), ("up", up), ("towards", towards)):
                        normal_material.node_tree.nodes[f"Sprite camera {name}"].inputs[1].default_value = basis
                for frame_index, frame in enumerate(clip["sourceFrames"]):
                    _set_frame(scene, frame)
                    x = frame_index * request["frameSize"]
                    y = (action_index * request["directions"] + direction_index) * request["frameSize"]
                    for channel, atlas in enumerate((albedo_atlas, normal_atlas)):
                        for mesh, originals in original_slots.items():
                            for slot, original in zip(mesh.material_slots, originals):
                                slot.material = material_sets[original][channel]
                        scene.view_settings.view_transform = "Standard" if channel == 0 else "Raw"
                        scene.render.filepath = str(tile_path)
                        bpy.ops.render.render(write_still=True)
                        tw, th, tile = read_rgba_png(tile_path)
                        if tw != request["frameSize"] or th != request["frameSize"]:
                            raise RuntimeError("Unexpected tile size from Blender.")
                        _paste(atlas, width, tile, x, y, request["frameSize"])
                    frame_metadata.append({"action": clip["name"], "direction": direction_index, "index": frame_index,
                                           "rect": {"x": x, "y": y, "w": request["frameSize"], "h": request["frameSize"]},
                                           "pivot": {"x": px * request["frameSize"], "y": py * request["frameSize"]},
                                           "sourceFrame": frame, "sourceTimeSeconds": frame / fps,
                                           "clipTimeSeconds": (frame - clip["sourceStart"]) / fps})
                    print(f"SPRITE_ATLAS_PROGRESS={len(frame_metadata)}/{len(clips) * request['directions'] * request['framesPerAction']}", flush=True)
    write_rgba_png(destination / "albedo.png", width, height, albedo_atlas)
    write_rgba_png(destination / "normal.png", width, height, normal_atlas)
    metadata = {"schema": SCHEMA, "schemaVersion": 1,
                "files": {"albedo": "albedo.png", "normal": "normal.png"},
                "size": {"width": width, "height": height},
                "frameSize": {"width": request["frameSize"], "height": request["frameSize"]},
                "layout": {"columns": request["framesPerAction"], "rows": request["directions"] * len(clips), "order": "action-direction-frame", "origin": "top-left"},
                "pivot": {"x": px, "y": py, "units": "normalized-top-left"},
                "worldAnchor": list(anchor), "worldAxes": {"up": "+Z", "frontCamera": "-Y", "yawPositive": "toward +X"},
                "projection": {"type": "orthographic", "elevationDegrees": request["elevation"], "scale": scale, "paddingFraction": request["padding"], "fixedAcrossFramesAndDirections": True},
                "normalConvention": {"space": "camera", "x": "right", "y": "up", "z": "toward-viewer", "encoding": "rgb=normal*0.5+0.5", "colorSpace": "linear", "alpha": "coverage"},
                "albedoColorSpace": "sRGB", "sourceFps": fps, "samplePolicy": "uniform-source-range-end-exclusive",
                "directions": direction_metadata, "actions": clips, "frames": frame_metadata,
                "renderer": {"name": "Blender Cycles CPU", "version": bpy.app.version_string, "samples": 1}}
    (destination / "atlas.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"schemaVersion": 1, "files": {"albedo": "albedo.png", "normal": "normal.png", "metadata": "atlas.json"}, "width": width, "height": height, "frameCount": len(frame_metadata), "sourceFps": fps,
            "actions": [{key: clip[key] for key in ("name", "frameCount", "sourceStart", "sourceEnd", "durationSeconds", "playbackFps")} for clip in clips], "directions": request["directions"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--request", required=True)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:])
    try:
        result = render(json.loads(Path(args.request).read_text(encoding="utf-8")))
    except Exception as error:
        print(f"SPRITE_ATLAS_ERROR={type(error).__name__}: {error}", file=sys.stderr, flush=True)
        raise
    print("SPRITE_ATLAS_RESULT=" + json.dumps(result, separators=(",", ":")), flush=True)


if __name__ == "__main__":
    main()
