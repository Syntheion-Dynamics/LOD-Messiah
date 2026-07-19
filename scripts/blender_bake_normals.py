"""
Headless high→low normal map bake via Blender Cycles.
Usage:
  blender --background --python blender_bake_normals.py -- \\
    --high high.glb --low low.glb --output baked.glb --normals normals.png --resolution 2048
"""
import argparse
import os
import sys


def parse_args(argv):
    if "--" in argv:
        argv = argv[argv.index("--") + 1 :]
    else:
        argv = []
    p = argparse.ArgumentParser()
    p.add_argument("--high", required=True)
    p.add_argument("--low", required=True)
    p.add_argument("--output", required=True)
    p.add_argument("--normals", required=True)
    p.add_argument("--resolution", type=int, default=2048)
    p.add_argument("--cage-extrusion", type=float, default=0.05)
    return p.parse_args(argv)


def clear_scene(bpy):
    bpy.ops.wm.read_factory_settings(use_empty=True)


def import_glb(bpy, path, name_prefix):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    imported = [o for o in bpy.data.objects if o not in before]
    meshes = [o for o in imported if o.type == "MESH"]
    for i, obj in enumerate(meshes):
        obj.name = f"{name_prefix}_{i}_{obj.name}"
    return meshes


def ensure_uv(bpy, obj):
    me = obj.data
    if me.uv_layers and len(me.uv_layers) > 0:
        return False  # already had UVs
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=66.0, island_margin=0.02)
    bpy.ops.object.mode_set(mode="OBJECT")
    print(f"WARN: Smart UV Project applied to {obj.name} (no existing UVs)")
    return True


def join_meshes(bpy, meshes, name):
    if not meshes:
        return None
    if len(meshes) == 1:
        meshes[0].name = name
        return meshes[0]

    bpy.ops.object.select_all(action="DESELECT")
    for obj in meshes:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.join()
    active = bpy.context.view_layer.objects.active
    active.name = name
    return active


def setup_bake_material(bpy, obj, image):
    if not obj.data.materials:
        mat = bpy.data.materials.new(name=f"{obj.name}_BakeMat")
        mat.use_nodes = True
        obj.data.materials.append(mat)
    else:
        mat = obj.data.materials[0]
        if mat is None:
            mat = bpy.data.materials.new(name=f"{obj.name}_BakeMat")
            obj.data.materials[0] = mat
        mat.use_nodes = True

    nodes = mat.node_tree.nodes
    # Clear selection
    for n in nodes:
        n.select = False

    tex = nodes.new("ShaderNodeTexImage")
    tex.name = "BakeTarget"
    tex.image = image
    tex.select = True
    nodes.active = tex

    # Wire into Principled BSDF normal via Normal Map node for export
    bsdf = None
    for n in nodes:
        if n.type == "BSDF_PRINCIPLED":
            bsdf = n
            break
    if bsdf:
        nmap = nodes.new("ShaderNodeNormalMap")
        nmap.location = (bsdf.location.x - 300, bsdf.location.y - 200)
        tex.location = (nmap.location.x - 300, nmap.location.y)
        links = mat.node_tree.links
        links.new(tex.outputs["Color"], nmap.inputs["Color"])
        links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])

    return mat


def main():
    args = parse_args(sys.argv)
    import bpy

    clear_scene(bpy)

    high_meshes = import_glb(bpy, args.high, "HIGH")
    low_meshes = import_glb(bpy, args.low, "LOW")

    if not high_meshes:
        raise RuntimeError("No mesh found in high-poly GLB")
    if not low_meshes:
        raise RuntimeError("No mesh found in low-poly GLB")

    high = join_meshes(bpy, high_meshes, "HIGH_JOINED")
    low = join_meshes(bpy, low_meshes, "LOW_JOINED")

    # Match transforms (same space)
    low.location = high.location
    low.rotation_euler = high.rotation_euler
    low.scale = high.scale

    ensure_uv(bpy, low)

    res = int(args.resolution)
    img = bpy.data.images.new("NormalBake", width=res, height=res, alpha=False)
    img.colorspace_settings.name = "Non-Color"
    setup_bake_material(bpy, low, img)

    # Cycles bake settings
    bpy.context.scene.render.engine = "CYCLES"
    bpy.context.scene.cycles.samples = 16
    bpy.context.scene.cycles.use_denoising = False
    # Prefer GPU if available
    try:
        cycles_prefs = bpy.context.preferences.addons["cycles"].preferences
        cycles_prefs.compute_device_type = "CUDA"
        for device in cycles_prefs.devices:
            device.use = True
        bpy.context.scene.cycles.device = "GPU"
    except Exception as e:
        print(f"GPU setup skipped: {e}")

    bake = bpy.context.scene.render.bake
    bake.use_selected_to_active = True
    bake.cage_extrusion = float(args.cage_extrusion)
    bake.margin = 16
    bake.normal_space = "TANGENT"

    bpy.ops.object.select_all(action="DESELECT")
    high.select_set(True)
    low.select_set(True)
    bpy.context.view_layer.objects.active = low

    print("Baking normals (selected-to-active)...")
    bpy.ops.object.bake(type="NORMAL", use_clear=True, margin=16)

    os.makedirs(os.path.dirname(os.path.abspath(args.normals)) or ".", exist_ok=True)
    img.filepath_raw = args.normals
    img.file_format = "PNG"
    img.save()
    print(f"Saved normals: {args.normals}")

    # Delete high before export
    bpy.ops.object.select_all(action="DESELECT")
    high.select_set(True)
    bpy.ops.object.delete()

    os.makedirs(os.path.dirname(os.path.abspath(args.output)) or ".", exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=args.output,
        export_format="GLB",
        use_selection=False,
        export_apply=True,
        export_texcoords=True,
        export_normals=True,
        export_materials="EXPORT",
        export_image_format="AUTO",
    )
    print(f"Exported baked GLB: {args.output}")


if __name__ == "__main__":
    main()
