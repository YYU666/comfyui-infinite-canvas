"""Create synthetic, animated GLB/FBX fixtures for local sprite-renderer tests.

No user character or licensed asset is used. Run with Blender --background
--factory-startup --python scripts/make_sprite_fixture.py -- --output-dir PATH.
"""
import argparse
from pathlib import Path
import sys


def make_fixture(output_dir):
    import bpy

    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.fps = 24
    scene.frame_start, scene.frame_end = 1, 25
    material = bpy.data.materials.new("Synthetic blue albedo")
    material.use_nodes = True
    material.node_tree.nodes.get("Principled BSDF").inputs["Base Color"].default_value = (.08, .32, .7, 1)
    bpy.ops.object.armature_add(location=(0, 0, 0))
    rig = bpy.context.object
    rig.name = "SyntheticCharacterRig"
    bpy.ops.object.mode_set(mode="EDIT")
    root = rig.data.edit_bones[0]
    root.name, root.head, root.tail = "root", (0, 0, 0), (0, 0, 1)
    arm = rig.data.edit_bones.new("arm")
    arm.head, arm.tail, arm.parent = (.42, 0, 1.1), (1.1, 0, 1.1), root
    bpy.ops.object.mode_set(mode="OBJECT")

    def box(name, location, scale, bone):
        bpy.ops.mesh.primitive_cube_add(size=1, location=location)
        mesh = bpy.context.object
        mesh.name, mesh.scale = name, scale
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
        mesh.data.materials.append(material)
        group = mesh.vertex_groups.new(name=bone)
        group.add(list(range(len(mesh.data.vertices))), 1, "REPLACE")
        mesh.modifiers.new("Synthetic skin", "ARMATURE").object = rig
        mesh.parent = rig
        return mesh

    box("body", (0, 0, .85), (.7, .42, 1.7), "root")
    box("head", (-.08, -.05, 1.95), (.55, .48, .5), "root")
    box("moving right arm", (.86, 0, 1.1), (.9, .3, .3), "arm")
    # The front plane exercises actual embedded texture RGB and alpha. Half of
    # the plate is transparent; a one-pixel gutter avoids texture wrap ambiguity.
    texture = bpy.data.images.new("SyntheticRGBA", width=4, height=4, alpha=True)
    texture.pixels = [value for y in range(4) for x in range(4) for value in ((1, .1, .05, 1) if x < 2 else (0, 1, 0, 0))]
    texture.pack()
    texture_material = bpy.data.materials.new("Synthetic texture and alpha")
    texture_material.use_nodes = True
    tree = texture_material.node_tree
    image = tree.nodes.new("ShaderNodeTexImage")
    image.image, image.interpolation = texture, "Closest"
    bsdf = tree.nodes.get("Principled BSDF")
    tree.links.new(image.outputs["Color"], bsdf.inputs["Base Color"])
    tree.links.new(image.outputs["Alpha"], bsdf.inputs["Alpha"])
    texture_material.surface_render_method = "DITHERED"
    bpy.ops.mesh.primitive_plane_add(size=1, location=(-.7, -.35, 1.4), rotation=(1.5707963267948966, 0, 0))
    plate = bpy.context.object
    plate.name, plate.scale = "RGBA test flag", (.65, .65, .65)
    plate.data.materials.append(texture_material)
    plate.parent = rig
    group = plate.vertex_groups.new(name="root")
    group.add(list(range(len(plate.data.vertices))), 1, "REPLACE")
    plate.modifiers.new("Synthetic skin", "ARMATURE").object = rig

    for name, amplitude in (("Idle", .08), ("Wave", .9)):
        action = bpy.data.actions.new(name)
        rig.animation_data_create().action = action
        for frame, angle in ((1, 0), (7, amplitude), (13, 0), (19, -amplitude), (25, 0)):
            rig.pose.bones["arm"].rotation_mode = "XYZ"
            rig.pose.bones["arm"].rotation_euler[1] = angle
            rig.pose.bones["arm"].keyframe_insert(data_path="rotation_euler", frame=frame, group="arm")
        slot = rig.animation_data.action_slot
        track = rig.animation_data.nla_tracks.new()
        track.name = name
        strip = track.strips.new(name, 1, action)
        strip.action_slot = slot
        track.mute = True
        rig.animation_data.action = None
    rig.pose.bones["arm"].rotation_euler = (0, 0, 0)
    scene.frame_set(1)
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=str(output_dir / "synthetic-character.glb"), export_format="GLB", export_animations=True, export_nla_strips=True)
    # FBX stores named actions as exporter-generated takes; source names are
    # discovered and recorded rather than assumed to match the GLB spelling.
    for track in rig.animation_data.nla_tracks:
        track.mute = False
    scene.render.fps = 30
    bpy.ops.export_scene.fbx(filepath=str(output_dir / "synthetic-character.fbx"), use_selection=False, bake_anim=True, bake_anim_use_all_actions=False, bake_anim_use_nla_strips=True, path_mode="COPY", embed_textures=True)
    return output_dir


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
    print(make_fixture(args.output_dir))
