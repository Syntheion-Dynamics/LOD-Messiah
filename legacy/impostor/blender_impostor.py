"""
Bake a 4-sided (optional top) AABB box impostor from a GLB.
Usage:
  blender --background --python blender_impostor.py -- \\
    --input model.glb --output impostor.glb --faces-dir ./faces --resolution 512
"""
import argparse
import math
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
    p.add_argument("--resolution", type=int, default=512)
    p.add_argument("--margin", type=float, default=1.02, help="AABB scale padding")
    p.add_argument("--include-top", action="store_true")
    return p.parse_args(argv)


def clear_scene(bpy):
    bpy.ops.wm.read_factory_settings(use_empty=True)


def world_bbox(objects):
    import mathutils

    min_c = mathutils.Vector((1e18, 1e18, 1e18))
    max_c = mathutils.Vector((-1e18, -1e18, -1e18))
    any_mesh = False
    for obj in objects:
        if obj.type != "MESH":
            continue
        any_mesh = True
        for corner in obj.bound_box:
            w = obj.matrix_world @ mathutils.Vector(corner)
            min_c.x = min(min_c.x, w.x)
            min_c.y = min(min_c.y, w.y)
            min_c.z = min(min_c.z, w.z)
            max_c.x = max(max_c.x, w.x)
            max_c.y = max(max_c.y, w.y)
            max_c.z = max(max_c.z, w.z)
    if not any_mesh:
        raise RuntimeError("No mesh objects to impostor")
    return min_c, max_c


def setup_world(bpy):
    world = bpy.data.worlds.new("ImpostorWorld")
    bpy.context.scene.world = world
    world.use_nodes = True
    nodes = world.node_tree.nodes
    links = world.node_tree.links
    nodes.clear()
    bg = nodes.new("ShaderNodeBackground")
    bg.inputs["Color"].default_value = (0, 0, 0, 1)
    bg.inputs["Strength"].default_value = 0.0
    out = nodes.new("ShaderNodeOutputWorld")
    links.new(bg.outputs["Background"], out.inputs["Surface"])


def add_sun(bpy):
    light_data = bpy.data.lights.new(name="Sun", type="SUN")
    light_data.energy = 3.0
    light_obj = bpy.data.objects.new(name="Sun", object_data=light_data)
    bpy.context.collection.objects.link(light_obj)
    light_obj.rotation_euler = (math.radians(50), math.radians(15), math.radians(30))
    # Fill light
    fill = bpy.data.lights.new(name="Fill", type="SUN")
    fill.energy = 1.0
    fill_obj = bpy.data.objects.new(name="Fill", object_data=fill)
    bpy.context.collection.objects.link(fill_obj)
    fill_obj.rotation_euler = (math.radians(-20), math.radians(180), 0)


def render_face(bpy, name, center, size, direction, up, res, out_path, margin):
    import mathutils

    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE_NEXT" if hasattr(bpy.types, "EEVEE") or True else "BLENDER_EEVEE"
    # Prefer EEVEE; fall back quietly
    try:
        scene.render.engine = "BLENDER_EEVEE_NEXT"
    except Exception:
        try:
            scene.render.engine = "BLENDER_EEVEE"
        except Exception:
            scene.render.engine = "CYCLES"
            scene.cycles.samples = 32

    scene.render.resolution_x = res
    scene.render.resolution_y = res
    scene.render.film_transparent = True
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"

    # Remove old cameras
    for obj in list(bpy.data.objects):
        if obj.type == "CAMERA":
            bpy.data.objects.remove(obj, do_unlink=True)

    cam_data = bpy.data.cameras.new("ImpostorCam")
    cam_data.type = "ORTHO"
    # Fit the face extents
    if abs(direction.z) > 0.9:
        # top: fit X/Y
        cam_data.ortho_scale = max(size.x, size.y) * margin
    elif abs(direction.x) > 0.9:
        cam_data.ortho_scale = max(size.y, size.z) * margin
    else:
        cam_data.ortho_scale = max(size.x, size.z) * margin

    cam = bpy.data.objects.new("ImpostorCam", cam_data)
    bpy.context.collection.objects.link(cam)
    scene.camera = cam

    dist = max(size.x, size.y, size.z) * 2.0
    cam.location = center + direction.normalized() * dist
    # Look at center
    direction_to = center - cam.location
    rot = direction_to.to_track_quat("-Z", "Y")
    # Adjust up for side views so Z stays up
    if abs(direction.z) < 0.9:
        # Build basis with world Z up
        forward = direction.normalized()
        right = forward.cross(mathutils.Vector((0, 0, 1)))
        if right.length < 1e-6:
            right = forward.cross(mathutils.Vector((0, 1, 0)))
        right.normalize()
        true_up = right.cross(forward).normalized()
        # camera looks down -Z, Y is up
        mat = mathutils.Matrix(
            (
                (right.x, true_up.x, -forward.x, cam.location.x),
                (right.y, true_up.y, -forward.y, cam.location.y),
                (right.z, true_up.z, -forward.z, cam.location.z),
                (0, 0, 0, 1),
            )
        )
        cam.matrix_world = mat
    else:
        cam.rotation_euler = rot.to_euler()

    scene.render.filepath = out_path
    bpy.ops.render.render(write_still=True)
    print(f"Rendered face {name}: {out_path}")


def build_box(bpy, center, size, face_paths, include_top):
    import mathutils

    # Clear meshes except we need empty scene for export — hide source?
    # Delete all objects, rebuild box only
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)

    faces = [
        ("front", face_paths["front"], (0, -1, 0)),
        ("back", face_paths["back"], (0, 1, 0)),
        ("left", face_paths["left"], (-1, 0, 0)),
        ("right", face_paths["right"], (1, 0, 0)),
    ]
    if include_top and "top" in face_paths:
        faces.append(("top", face_paths["top"], (0, 0, 1)))

    hx, hy, hz = size.x / 2, size.y / 2, size.z / 2

    def make_plane(name, path, normal):
        # Create 2-tri plane at correct face of AABB
        mesh = bpy.data.meshes.new(name)
        n = mathutils.Vector(normal)
        if abs(n.y) > 0.9:
            # front/back: XZ plane
            y = -hy if n.y < 0 else hy
            verts = [
                (-hx, y, -hz),
                (hx, y, -hz),
                (hx, y, hz),
                (-hx, y, hz),
            ]
            # Flip winding for back
            faces_idx = [(0, 1, 2, 3)] if n.y < 0 else [(0, 3, 2, 1)]
        elif abs(n.x) > 0.9:
            x = -hx if n.x < 0 else hx
            verts = [
                (x, -hy, -hz),
                (x, hy, -hz),
                (x, hy, hz),
                (x, -hy, hz),
            ]
            faces_idx = [(0, 3, 2, 1)] if n.x < 0 else [(0, 1, 2, 3)]
        else:
            z = hz
            verts = [
                (-hx, -hy, z),
                (hx, -hy, z),
                (hx, hy, z),
                (-hx, hy, z),
            ]
            faces_idx = [(0, 1, 2, 3)]

        mesh.from_pydata(verts, [], faces_idx)
        mesh.update()
        obj = bpy.data.objects.new(name, mesh)
        bpy.context.collection.objects.link(obj)
        obj.location = center

        # UVs
        mesh.uv_layers.new(name="UVMap")
        uv = mesh.uv_layers.active.data
        # quad loop
        uv[0].uv = (0, 0)
        uv[1].uv = (1, 0)
        uv[2].uv = (1, 1)
        uv[3].uv = (0, 1)

        mat = bpy.data.materials.new(name=f"mat_{name}")
        mat.use_nodes = True
        mat.blend_method = "CLIP"
        try:
            mat.shadow_method = "CLIP"
        except Exception:
            pass
        nodes = mat.node_tree.nodes
        links = mat.node_tree.links
        nodes.clear()
        out = nodes.new("ShaderNodeOutputMaterial")
        bsdf = nodes.new("ShaderNodeBsdfPrincipled")
        tex = nodes.new("ShaderNodeTexImage")
        img = bpy.data.images.load(path)
        tex.image = img
        links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
        links.new(tex.outputs["Alpha"], bsdf.inputs["Alpha"])
        links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
        # Unlit-ish: high roughness, no specular
        if "Specular IOR Level" in bsdf.inputs:
            bsdf.inputs["Specular IOR Level"].default_value = 0.0
        elif "Specular" in bsdf.inputs:
            bsdf.inputs["Specular"].default_value = 0.0
        bsdf.inputs["Roughness"].default_value = 1.0
        obj.data.materials.append(mat)
        return obj

    for name, path, normal in faces:
        make_plane(name, path, normal)


def main():
    args = parse_args(sys.argv)
    import bpy
    import mathutils

    clear_scene(bpy)
    bpy.ops.import_scene.gltf(filepath=args.input)

    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    if not meshes:
        raise RuntimeError("No meshes in input GLB")

    min_c, max_c = world_bbox(meshes)
    center = (min_c + max_c) * 0.5
    size = max_c - min_c
    # Avoid zero thickness
    size.x = max(size.x, 1e-3)
    size.y = max(size.y, 1e-3)
    size.z = max(size.z, 1e-3)

    setup_world(bpy)
    add_sun(bpy)

    os.makedirs(args.faces_dir, exist_ok=True)
    res = int(args.resolution)
    margin = float(args.margin)

    face_specs = {
        "front": mathutils.Vector((0, -1, 0)),
        "back": mathutils.Vector((0, 1, 0)),
        "left": mathutils.Vector((-1, 0, 0)),
        "right": mathutils.Vector((1, 0, 0)),
    }
    if args.include_top:
        face_specs["top"] = mathutils.Vector((0, 0, 1))

    face_paths = {}
    for name, direction in face_specs.items():
        path = os.path.join(args.faces_dir, f"{name}.png")
        render_face(bpy, name, center, size, direction, mathutils.Vector((0, 0, 1)), res, path, margin)
        face_paths[name] = path

    build_box(bpy, center, size, face_paths, args.include_top)

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
    print(f"Exported impostor: {args.output}")
    print(f"AABB center={tuple(center)} size={tuple(size)}")


if __name__ == "__main__":
    main()
