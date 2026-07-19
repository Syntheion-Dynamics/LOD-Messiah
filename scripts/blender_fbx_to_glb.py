"""
Headless FBX → GLB conversion via Blender.
Usage:
  blender --background --python blender_fbx_to_glb.py -- --input in.fbx --output out.glb
"""
import argparse
import sys


def parse_args(argv):
    if "--" in argv:
        argv = argv[argv.index("--") + 1 :]
    else:
        argv = []
    p = argparse.ArgumentParser()
    p.add_argument("--input", required=True)
    p.add_argument("--output", required=True)
    return p.parse_args(argv)


def main():
    args = parse_args(sys.argv)
    import bpy

    # Reset scene
    bpy.ops.wm.read_factory_settings(use_empty=True)

    bpy.ops.import_scene.fbx(filepath=args.input)

    bpy.ops.export_scene.gltf(
        filepath=args.output,
        export_format="GLB",
        use_selection=False,
        export_apply=True,
        export_texcoords=True,
        export_normals=True,
        export_materials="EXPORT",
    )
    print(f"Exported GLB: {args.output}")


if __name__ == "__main__":
    main()
