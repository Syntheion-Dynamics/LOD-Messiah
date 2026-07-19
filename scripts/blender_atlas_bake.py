"""
Bake all materials of a GLB into a single atlas (albedo + normal + ORM).
Usage:
  blender --background --python blender_atlas_bake.py -- \\
    --input in.glb --output out.glb --resolution 1024 --faces-dir ./atlas_maps
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
    p.add_argument("--input", required=True)
    p.add_argument("--output", required=True)
    p.add_argument("--faces-dir", required=True)
    p.add_argument("--resolution", type=int, default=1024)
    p.add_argument("--margin", type=int, default=8)
    return p.parse_args(argv)


def clear_scene(bpy):
    bpy.ops.wm.read_factory_settings(use_empty=True)


def make_meshes_single_user(bpy, meshes):
    """KitBash GLBs share mesh datablocks (instances). Apply/join needs unique data."""
    bpy.ops.object.select_all(action="DESELECT")
    for obj in meshes:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.make_single_user(object=True, obdata=True, material=False, animation=False)
    # Defensive: copy any mesh still shared
    for obj in meshes:
        if obj.data and obj.data.users > 1:
            obj.data = obj.data.copy()


def join_all_meshes(bpy):
    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    if not meshes:
        raise RuntimeError("No mesh objects in GLB")

    make_meshes_single_user(bpy, meshes)

    # Apply transforms (safe after single-user)
    bpy.ops.object.select_all(action="DESELECT")
    for obj in meshes:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)

    if len(meshes) == 1:
        meshes[0].name = "AtlasMesh"
        return meshes[0]

    bpy.ops.object.select_all(action="DESELECT")
    for obj in meshes:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.join()
    obj = bpy.context.view_layer.objects.active
    obj.name = "AtlasMesh"
    return obj


def pin_textures_to_uv(bpy, obj, uv_name):
    """Source textures must keep original UVs; active Atlas UV is only the bake target."""
    for slot in obj.material_slots:
        mat = slot.material
        if mat is None or not getattr(mat, "use_nodes", False):
            continue
        nodes = mat.node_tree.nodes
        links = mat.node_tree.links
        for n in nodes:
            if n.type != "TEX_IMAGE":
                continue
            # Skip empty / bake-target images added later
            if n.image is None:
                continue
            # Already has an explicit UV Map link
            if n.inputs["Vector"].is_linked:
                continue
            uv_node = nodes.new("ShaderNodeUVMap")
            uv_node.uv_map = uv_name
            uv_node.location = (n.location.x - 250, n.location.y)
            links.new(uv_node.outputs["UV"], n.inputs["Vector"])


def make_atlas_uv(bpy, obj):
    me = obj.data
    # Remember source UV (gltf usually "UVMap" / "TEXCOORD_0")
    src_uv = me.uv_layers.active.name if me.uv_layers.active else None
    if not src_uv and me.uv_layers:
        src_uv = me.uv_layers[0].name
    if not src_uv:
        me.uv_layers.new(name="UVMap")
        src_uv = "UVMap"

    pin_textures_to_uv(bpy, obj, src_uv)

    if "Atlas" in me.uv_layers:
        atlas = me.uv_layers["Atlas"]
    else:
        atlas = me.uv_layers.new(name="Atlas")
    atlas.active = True
    try:
        atlas.active_render = True
    except Exception:
        pass

    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    # Blender 4+/5: angle_limit is radians; scale_to_bounds is required or
    # islands stay microscopic and the bake writes a few black pixels.
    bpy.ops.uv.smart_project(
        angle_limit=1.151917,  # ~66°
        island_margin=0.02,
        area_weight=0.0,
        correct_aspect=True,
        scale_to_bounds=True,
    )
    try:
        bpy.ops.uv.average_islands_scale()
        bpy.ops.uv.pack_islands(margin=0.01)
    except Exception as e:
        print(f"WARN: pack_islands skipped ({e})")
    bpy.ops.object.mode_set(mode="OBJECT")
    print(f"Atlas UV created and packed (source UV pinned: {src_uv})")


def ensure_cycles(bpy):
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 8
    scene.cycles.use_denoising = False
    scene.cycles.bake_type = "DIFFUSE"
    try:
        prefs = bpy.context.preferences.addons["cycles"].preferences
        prefs.compute_device_type = "CUDA"
        for d in prefs.devices:
            d.use = True
        scene.cycles.device = "GPU"
        print("Cycles GPU enabled")
    except Exception as e:
        print(f"Cycles GPU setup skipped: {e}")
        scene.cycles.device = "CPU"


def create_image(bpy, name, res, is_data=False):
    img = bpy.data.images.new(name, width=res, height=res, alpha=True)
    if is_data:
        img.colorspace_settings.name = "Non-Color"
    return img


def set_active_bake_image(bpy, obj, image):
    # Every material slot needs an Image Texture node selected as bake target
    if not obj.data.materials:
        mat = bpy.data.materials.new("BakeTmp")
        mat.use_nodes = True
        obj.data.materials.append(mat)

    for slot in obj.material_slots:
        mat = slot.material
        if mat is None:
            continue
        mat.use_nodes = True
        nodes = mat.node_tree.nodes
        for n in nodes:
            n.select = False
        tex = None
        for n in nodes:
            if n.type == "TEX_IMAGE" and n.image == image:
                tex = n
                break
        if tex is None:
            tex = nodes.new("ShaderNodeTexImage")
            tex.image = image
        tex.select = True
        nodes.active = tex


def bake(bpy, obj, bake_type, image, pass_filter=None):
    set_active_bake_image(bpy, obj, image)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    scene = bpy.context.scene
    scene.cycles.bake_type = bake_type
    bake_settings = scene.render.bake
    bake_settings.margin = 16
    bake_settings.use_selected_to_active = False
    bake_settings.use_clear = True
    if bake_type == "DIFFUSE":
        bake_settings.use_pass_direct = False
        bake_settings.use_pass_indirect = False
        bake_settings.use_pass_color = True

    # Blender 5.x: BakeSettings has no uv_layer; pass it on the operator instead.
    kwargs = {
        "type": bake_type,
        "margin": 16,
        "use_clear": True,
        "uv_layer": "Atlas",
    }
    if pass_filter is not None:
        kwargs["pass_filter"] = pass_filter

    print(f"Baking {bake_type}...")
    bpy.ops.object.bake(**kwargs)
    print(f"Bake {bake_type} done")


def assign_atlas_material(bpy, obj, albedo, normal, orm):
    # Remove old materials
    obj.data.materials.clear()
    mat = bpy.data.materials.new("AtlasMaterial")
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    nodes.clear()

    out = nodes.new("ShaderNodeOutputMaterial")
    bsdf = nodes.new("ShaderNodeBsdfPrincipled")
    out.location = (400, 0)
    bsdf.location = (100, 0)

    tex_a = nodes.new("ShaderNodeTexImage")
    tex_a.image = albedo
    tex_a.location = (-500, 200)
    links.new(tex_a.outputs["Color"], bsdf.inputs["Base Color"])
    links.new(tex_a.outputs["Alpha"], bsdf.inputs["Alpha"])

    tex_n = nodes.new("ShaderNodeTexImage")
    tex_n.image = normal
    tex_n.location = (-500, -50)
    nmap = nodes.new("ShaderNodeNormalMap")
    nmap.location = (-200, -50)
    links.new(tex_n.outputs["Color"], nmap.inputs["Color"])
    links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])

    tex_o = nodes.new("ShaderNodeTexImage")
    tex_o.image = orm
    tex_o.location = (-500, -300)
    # ORM: R=AO (unused in core glTF separate), G=Roughness, B=Metallic
    sep = nodes.new("ShaderNodeSeparateColor")
    sep.location = (-200, -300)
    links.new(tex_o.outputs["Color"], sep.inputs["Color"])
    # Blender 4+/5 Separate Color outputs Red/Green/Blue
    if "Green" in sep.outputs:
        links.new(sep.outputs["Green"], bsdf.inputs["Roughness"])
        links.new(sep.outputs["Blue"], bsdf.inputs["Metallic"])
    else:
        # fallback Separate RGB
        pass

    links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    try:
        mat.blend_method = "HASHED"
    except Exception:
        pass
    obj.data.materials.append(mat)


def save_image(img, path):
    img.filepath_raw = path
    img.file_format = "PNG"
    img.save()
    print(f"Saved {path}")


def main():
    args = parse_args(sys.argv)
    import bpy

    clear_scene(bpy)
    bpy.ops.import_scene.gltf(filepath=args.input)
    obj = join_all_meshes(bpy)
    make_atlas_uv(bpy, obj)
    ensure_cycles(bpy)

    os.makedirs(args.faces_dir, exist_ok=True)
    res = int(args.resolution)

    albedo = create_image(bpy, "AtlasAlbedo", res, is_data=False)
    normal = create_image(bpy, "AtlasNormal", res, is_data=True)
    orm = create_image(bpy, "AtlasORM", res, is_data=True)

    # Diffuse color only (skip direct/indirect lighting)
    bake(bpy, obj, "DIFFUSE", albedo, pass_filter={"COLOR"})
    bake(bpy, obj, "NORMAL", normal)
    # Roughness + Metallic into separate then pack — bake ROUGHNESS and COMBINED-ish
    # Bake roughness to ORM green via ROUGHNESS type, metallic separately then pack with compositing
    rough_img = create_image(bpy, "AtlasRoughTmp", res, is_data=True)
    metal_img = create_image(bpy, "AtlasMetalTmp", res, is_data=True)
    bake(bpy, obj, "ROUGHNESS", rough_img)
    try:
        bake(bpy, obj, "METALNESS", metal_img)
    except Exception as e:
        print(f"WARN: METALNESS bake unavailable ({e}) — metallic=0")
        # flat black metallic
        metal_img.pixels = [0.0] * len(list(rough_img.pixels))

    # Pack ORM in pixels: R=1, G=rough, B=metal
    print("Packing ORM...")
    rough_img.pixels[:]  # ensure loaded
    rp = list(rough_img.pixels)
    mp = list(metal_img.pixels)
    op = [1.0] * len(rp)
    for i in range(0, len(rp), 4):
        op[i] = 1.0  # AO
        op[i + 1] = rp[i]  # rough from R
        op[i + 2] = mp[i]  # metal from R
        op[i + 3] = 1.0
    orm.pixels = op

    albedo_path = os.path.join(args.faces_dir, "albedo.png")
    normal_path = os.path.join(args.faces_dir, "normal.png")
    orm_path = os.path.join(args.faces_dir, "orm.png")
    save_image(albedo, albedo_path)
    save_image(normal, normal_path)
    save_image(orm, orm_path)

    # Reload saved images so file paths stick for glTF export
    albedo.filepath = albedo_path
    normal.filepath = normal_path
    orm.filepath = orm_path

    assign_atlas_material(bpy, obj, albedo, normal, orm)

    # Delete non-mesh leftovers
    for o in list(bpy.data.objects):
        if o.type != "MESH":
            bpy.data.objects.remove(o, do_unlink=True)

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
        export_cameras=False,
        export_lights=False,
    )
    print(f"Exported atlas GLB: {args.output}")
    print(f"Materials merged → 1 | maps {res}px")


if __name__ == "__main__":
    main()
