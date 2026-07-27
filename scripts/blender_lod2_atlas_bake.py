"""
LOD2 atlas bake: unique UV already in TEXCOORD_1 (from watlas), or Smart UV fallback.
Pins source textures to TEXCOORD_0 / first UV, bakes albedo+normal+ORM into one material.

  blender --background --python blender_lod2_atlas_bake.py -- \\
    --input in.glb --output out.glb --resolution 1024 --faces-dir ./lod2_atlas
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
    p.add_argument(
        "--glass-tint",
        default=None,
        help="LINEAR r,g,b sky proxy for glass with no usable base colour "
        "(default %s)" % (",".join(f"{c:.3f}" for c in SKY_TINT[:3]),),
    )
    p.add_argument("--glass-metallic", type=float, default=None)
    p.add_argument("--glass-roughness", type=float, default=None)
    p.add_argument(
        "--no-glass-proxy",
        action="store_true",
        help="bake glass materials untouched (debug: shows the raw failure)",
    )
    return p.parse_args(argv)


def parse_tint(text):
    """'0.254,0.441,0.541' → RGBA tuple; None on anything unparseable."""
    if not text:
        return None
    try:
        parts = [float(v) for v in str(text).replace(";", ",").split(",")]
    except ValueError:
        print(f"WARN: --glass-tint '{text}' not parseable — using default")
        return None
    if len(parts) < 3:
        print(f"WARN: --glass-tint '{text}' needs r,g,b — using default")
        return None
    return (
        max(0.0, min(1.0, parts[0])),
        max(0.0, min(1.0, parts[1])),
        max(0.0, min(1.0, parts[2])),
        1.0,
    )


def clear_scene(bpy):
    bpy.ops.wm.read_factory_settings(use_empty=True)


def make_meshes_single_user(bpy, meshes):
    bpy.ops.object.select_all(action="DESELECT")
    for obj in meshes:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.make_single_user(object=True, obdata=True, material=False, animation=False)
    for obj in meshes:
        if obj.data and obj.data.users > 1:
            obj.data = obj.data.copy()


def join_all_meshes(bpy):
    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    if not meshes:
        raise RuntimeError("No mesh objects in GLB")

    make_meshes_single_user(bpy, meshes)

    bpy.ops.object.select_all(action="DESELECT")
    for obj in meshes:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)

    if len(meshes) == 1:
        meshes[0].name = "Lod2AtlasMesh"
        return meshes[0]

    bpy.ops.object.select_all(action="DESELECT")
    for obj in meshes:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.join()
    obj = bpy.context.view_layer.objects.active
    obj.name = "Lod2AtlasMesh"
    return obj


def pin_textures_to_uv(bpy, obj, uv_name):
    for slot in obj.material_slots:
        mat = slot.material
        if mat is None:
            continue
        try:
            mat.use_nodes = True
        except Exception:
            pass
        nodes = mat.node_tree.nodes
        links = mat.node_tree.links
        for n in nodes:
            if n.type != "TEX_IMAGE" or n.image is None:
                continue
            if n.inputs["Vector"].is_linked:
                continue
            uv_node = nodes.new("ShaderNodeUVMap")
            uv_node.uv_map = uv_name
            uv_node.location = (n.location.x - 250, n.location.y)
            links.new(uv_node.outputs["UV"], n.inputs["Vector"])


# Distant-window sky proxy, sRGB #8AA7B8 expressed in LINEAR — Blender colour
# sockets are scene-linear and the EMIT bake encodes linear→sRGB on save, so
# writing the sRGB bytes here would come out ~#C2D3DD (washed out).
SKY_TINT = (0.254, 0.386, 0.479, 1.0)

# A base colour this dark carries no usable appearance (KitBash GlassClear is
# 0.03/0.04/0.04) — only then does the sky proxy replace it.
GLASS_BASE_DARK_LUMA = 0.05

# Far-LOD glass defaults. metallic stays low on purpose: KitBash glass ships at
# metallic=1, and a fully metallic surface with no IBL/env probe renders BLACK —
# that, not a dark albedo, is what makes most LOD2 windows go black. LOD3 is
# hardcoded metallic 0, so keeping this near 0 also avoids a specular pop.
GLASS_METALLIC = 0.0
GLASS_ROUGHNESS = 0.25


def _transmission_input(bsdf):
    """Blender 4+ renamed Transmission → Transmission Weight."""
    return bsdf.inputs.get("Transmission Weight") or bsdf.inputs.get("Transmission")


def _input_default4(sock, fallback=(1.0, 1.0, 1.0, 1.0)):
    if sock is None:
        return fallback
    try:
        v = sock.default_value
        if len(v) >= 3:
            return (float(v[0]), float(v[1]), float(v[2]), float(v[3]) if len(v) > 3 else 1.0)
    except Exception:
        pass
    return fallback


def _is_glass_material(mat, bsdf):
    name = (mat.name or "").lower()
    if any(k in name for k in ("glass", "window", "curtainwall")):
        return True
    tr = _transmission_input(bsdf)
    if tr is not None:
        try:
            if float(tr.default_value) > 0.05:
                return True
        except Exception:
            pass
    return False


def _force_value(links, sock, value):
    """Sever any incoming link and pin a constant.

    Glass metallic/roughness is often driven by a packed ORM texture, so a
    link-preserving write would leave metallic=1 in place and keep the windows
    black — the very thing this pass exists to fix.
    """
    if sock is None:
        return
    try:
        for link in list(sock.links):
            links.remove(link)
        sock.default_value = value
    except Exception:
        pass


def replace_glass_with_opaque_proxy(bpy, obj, tint=None, metallic=None, roughness=None):
    """Turn transmissive/window materials into an opaque far-LOD proxy.

    Two distinct failure modes produce "black windows" at LOD2, and they need
    different treatment:

      1. metallic=1 (EVERY KitBash glass material) — a fully metallic surface
         with no IBL has no diffuse term and renders black in-engine. Fixed by
         clamping metallic on every glass slot. This is the common case.
      2. a genuinely near-black base colour with transmission carrying the look
         (KB3D_EVC_GlassClear = 0.03/0.04/0.04, transmission 1). Only here is
         there no appearance to keep, so the sky tint substitutes for it.

    The base colour is therefore left ALONE whenever it is usable — a linked
    texture (KB3D_MIM_GlassBlue/Cyan/Black, KB3D_EVC_WindowLouversA, …) or a
    factor above GLASS_BASE_DARK_LUMA. Overwriting those would flatten authored
    window art into one uniform panel and erase the per-material tint KitBash
    ships, which is exactly what the shared-tint contract is meant to preserve.
    """
    sky = tuple(tint) if tint else SKY_TINT
    metal_v = GLASS_METALLIC if metallic is None else float(metallic)
    rough_v = GLASS_ROUGHNESS if roughness is None else float(roughness)

    n_glass = 0
    n_tinted = 0
    for slot in obj.material_slots:
        mat = slot.material
        if mat is None:
            continue
        try:
            mat.use_nodes = True
        except Exception:
            pass
        nodes = mat.node_tree.nodes
        links = mat.node_tree.links
        bsdf = next((n for n in nodes if n.type == "BSDF_PRINCIPLED"), None)
        if bsdf is None or not _is_glass_material(mat, bsdf):
            continue

        base = bsdf.inputs.get("Base Color")
        if base is None:
            continue
        tr = _transmission_input(bsdf)
        n_glass += 1

        # --- appearance: keep whatever the material already carries ----------
        base_rgba = _input_default4(base, (0.0, 0.0, 0.0, 1.0))
        base_luma = (
            0.2126 * base_rgba[0] + 0.7152 * base_rgba[1] + 0.0722 * base_rgba[2]
        )
        keep_base = base.is_linked or base_luma > GLASS_BASE_DARK_LUMA

        if keep_base:
            detail = "texture" if base.is_linked else f"luma {base_luma:.3f}"
            print(f"  glass-proxy: {mat.name} keeps base colour ({detail})")
        else:
            # Nothing usable to preserve — substitute the distant sky proxy.
            for link in list(base.links):
                links.remove(link)
            base.default_value = sky
            n_tinted += 1
            print(
                f"  glass-proxy: {mat.name} base luma {base_luma:.3f} → sky tint "
                f"rgb({sky[0]:.3f},{sky[1]:.3f},{sky[2]:.3f})"
            )

        # --- always: make it an opaque, non-metallic far-LOD surface ---------
        if tr is not None:
            try:
                for link in list(tr.links):
                    links.remove(link)
                tr.default_value = 0.0
            except Exception:
                pass
        alpha = bsdf.inputs.get("Alpha")
        if alpha is not None:
            for link in list(alpha.links):
                links.remove(link)
            try:
                alpha.default_value = 1.0
            except Exception:
                pass

        _force_value(links, bsdf.inputs.get("Metallic"), metal_v)
        _force_value(links, bsdf.inputs.get("Roughness"), rough_v)

        try:
            mat.blend_method = "OPAQUE"
        except Exception:
            pass

    if n_glass:
        print(
            f"  glass-proxy: {n_glass} glass material(s) → opaque "
            f"metallic={metal_v:.2f} roughness={rough_v:.2f}"
            f" ({n_tinted} sky-tinted, {n_glass - n_tinted} kept own colour)"
        )
    return n_glass


def ensure_basecolor_for_bake(bpy, obj):
    """Blender 5 DIFFUSE bake ignores unlinked Principled Base Color defaults → black.

    Wire an RGB node (or keep existing link) so every slot contributes color.
    """
    for slot in obj.material_slots:
        mat = slot.material
        if mat is None:
            continue
        try:
            mat.use_nodes = True
        except Exception:
            pass
        nodes = mat.node_tree.nodes
        links = mat.node_tree.links
        bsdf = next((n for n in nodes if n.type == "BSDF_PRINCIPLED"), None)
        if bsdf is None:
            continue
        base = bsdf.inputs.get("Base Color")
        if base is None:
            continue
        if base.is_linked:
            continue
        rgb = nodes.new("ShaderNodeRGB")
        rgb.outputs[0].default_value = tuple(base.default_value)
        rgb.location = (bsdf.location.x - 300, bsdf.location.y + 100)
        links.new(rgb.outputs[0], base)
        print(f"  bake-fix: RGB→BaseColor for {mat.name}")


def save_image(img, path):
    path = os.path.abspath(path).replace("\\", "/")
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    img.filepath_raw = path
    img.file_format = "PNG"
    try:
        img.save()
    except Exception as e:
        print(f"WARN: img.save failed ({e}), trying save_render")
        img.save_render(filepath=path)
    # Keep pixels available for glTF export (Blender 5 clears size after save)
    try:
        img.pack()
        img.reload()
    except Exception:
        pass
    size = os.path.getsize(path) if os.path.isfile(path) else 0
    print(f"Saved {path} ({size} B)")


def prepare_atlas_uv(bpy, obj):
    """Pin source textures to TEXCOORD_0; use watlas TEXCOORD_1 as Atlas when present."""
    me = obj.data
    layers = list(me.uv_layers)
    if not layers:
        me.uv_layers.new(name="UVMap")
        layers = list(me.uv_layers)

    print(f"UV layers after join: {[l.name for l in me.uv_layers]}")
    src_uv = layers[0].name
    pin_textures_to_uv(bpy, obj, src_uv)

    if len(layers) >= 2:
        atlas_layer = layers[-1]
        atlas_layer.name = "Atlas"
        atlas_layer.active = True
        try:
            atlas_layer.active_render = True
        except Exception:
            pass
        print(f"Using watlas UV as Atlas (source={src_uv}) — no repack")
        return

    # Fallback Smart UV
    atlas_layer = me.uv_layers.new(name="Atlas")
    atlas_layer.active = True
    try:
        atlas_layer.active_render = True
    except Exception:
        pass
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(
        angle_limit=1.151917,
        island_margin=0.04,
        area_weight=1.0,
        correct_aspect=True,
        scale_to_bounds=True,
    )
    bpy.ops.object.mode_set(mode="OBJECT")
    print(f"Smart UV Atlas created (source UV pinned: {src_uv})")


def ensure_cycles(bpy):
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 4
    scene.cycles.use_denoising = False
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
    bake_settings.margin = 8
    bake_settings.use_selected_to_active = False
    bake_settings.use_clear = True
    if bake_type == "DIFFUSE":
        bake_settings.use_pass_direct = False
        bake_settings.use_pass_indirect = False
        bake_settings.use_pass_color = True

    kwargs = {
        "type": bake_type,
        "margin": 8,
        "use_clear": True,
        "uv_layer": "Atlas",
    }
    if pass_filter is not None:
        kwargs["pass_filter"] = pass_filter

    print(f"Baking {bake_type}...")
    bpy.ops.object.bake(**kwargs)
    print(f"Bake {bake_type} done")


def bake_albedo_emit(bpy, obj, image):
    """DIFFUSE COLOR bake is unreliable on Blender 5 Principled defaults.

    Temporarily route Base Color → Emission and bake EMIT.
    """
    backups = []
    for slot in obj.material_slots:
        mat = slot.material
        if mat is None or not mat.node_tree:
            continue
        nodes = mat.node_tree.nodes
        links = mat.node_tree.links
        bsdf = next((n for n in nodes if n.type == "BSDF_PRINCIPLED"), None)
        out = next((n for n in nodes if n.type == "OUTPUT_MATERIAL"), None)
        if not bsdf or not out:
            continue
        # Remember surface link
        surf_links = [l for l in out.inputs["Surface"].links]
        surface_from = surf_links[0].from_socket if surf_links else None

        base = bsdf.inputs["Base Color"]
        emit = nodes.new("ShaderNodeEmission")
        emit.location = (bsdf.location.x + 200, bsdf.location.y)
        if base.is_linked:
            links.new(base.links[0].from_socket, emit.inputs["Color"])
        else:
            emit.inputs["Color"].default_value = tuple(base.default_value)
        emit.inputs["Strength"].default_value = 1.0
        # Replace surface
        for l in list(out.inputs["Surface"].links):
            links.remove(l)
        links.new(emit.outputs["Emission"], out.inputs["Surface"])
        backups.append((mat, out, surface_from, emit))

    try:
        bake(bpy, obj, "EMIT", image)
    finally:
        for mat, out, surface_from, emit in backups:
            nodes = mat.node_tree.nodes
            links = mat.node_tree.links
            for l in list(out.inputs["Surface"].links):
                links.remove(l)
            if surface_from:
                links.new(surface_from, out.inputs["Surface"])
            nodes.remove(emit)


def assign_atlas_material(bpy, obj, albedo, normal, orm):
    obj.data.materials.clear()
    mat = bpy.data.materials.new("Lod2AtlasMaterial")
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
    sep = nodes.new("ShaderNodeSeparateColor")
    sep.location = (-200, -300)
    links.new(tex_o.outputs["Color"], sep.inputs["Color"])
    if "Green" in sep.outputs:
        links.new(sep.outputs["Green"], bsdf.inputs["Roughness"])
        links.new(sep.outputs["Blue"], bsdf.inputs["Metallic"])

    links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    try:
        mat.blend_method = "HASHED"
    except Exception:
        pass
    obj.data.materials.append(mat)

    # Drop source UV; keep Atlas as TEXCOORD_0 for export
    me = obj.data
    if "Atlas" in me.uv_layers:
        me.uv_layers["Atlas"].active = True
        try:
            me.uv_layers["Atlas"].active_render = True
        except Exception:
            pass
    for layer in list(me.uv_layers):
        if layer.name != "Atlas":
            me.uv_layers.remove(layer)
    if "Atlas" in me.uv_layers:
        me.uv_layers["Atlas"].name = "UVMap"


def main():
    args = parse_args(sys.argv)
    import bpy

    clear_scene(bpy)
    bpy.ops.import_scene.gltf(filepath=args.input)
    obj = join_all_meshes(bpy)
    prepare_atlas_uv(bpy, obj)
    if args.no_glass_proxy:
        print("  glass-proxy: disabled (--no-glass-proxy)")
    else:
        replace_glass_with_opaque_proxy(
            bpy,
            obj,
            tint=parse_tint(args.glass_tint),
            metallic=args.glass_metallic,
            roughness=args.glass_roughness,
        )
    ensure_basecolor_for_bake(bpy, obj)
    ensure_cycles(bpy)

    os.makedirs(args.faces_dir, exist_ok=True)
    res = int(args.resolution)

    albedo = create_image(bpy, "Lod2Albedo", res, is_data=False)
    normal = create_image(bpy, "Lod2Normal", res, is_data=True)
    orm = create_image(bpy, "Lod2ORM", res, is_data=True)

    bake_albedo_emit(bpy, obj, albedo)
    bake(bpy, obj, "NORMAL", normal)
    rough_img = create_image(bpy, "Lod2RoughTmp", res, is_data=True)
    metal_img = create_image(bpy, "Lod2MetalTmp", res, is_data=True)
    bake(bpy, obj, "ROUGHNESS", rough_img)
    try:
        bake(bpy, obj, "METALNESS", metal_img)
    except Exception as e:
        print(f"WARN: METALNESS bake unavailable ({e}) — metallic=0")
        metal_img.pixels = [0.0] * len(list(rough_img.pixels))

    print("Packing ORM...")
    rp = list(rough_img.pixels)
    mp = list(metal_img.pixels)
    op = [1.0] * len(rp)
    for i in range(0, len(rp), 4):
        op[i] = 1.0
        op[i + 1] = rp[i]
        op[i + 2] = mp[i]
        op[i + 3] = 1.0
    orm.pixels = op

    albedo_path = os.path.join(args.faces_dir, "albedo.png")
    normal_path = os.path.join(args.faces_dir, "normal.png")
    orm_path = os.path.join(args.faces_dir, "orm.png")
    save_image(albedo, albedo_path)
    save_image(normal, normal_path)
    save_image(orm, orm_path)

    albedo.filepath = albedo_path
    normal.filepath = normal_path
    orm.filepath = orm_path

    assign_atlas_material(bpy, obj, albedo, normal, orm)

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
    print(f"Exported LOD2 atlas GLB: {args.output}")


if __name__ == "__main__":
    main()
