# LOD Messiah

High-poly / KitBash → engine-ready **GLB LOD chain** (meshoptimizer + glTF-Transform) for custom Vulkan / C# engines.

Batch-converts `.obj` / `.fbx` / `.glb` / `.gltf` into LOD0–2 (+ optional octahedral impostor / KTX2).

> Keep purchased **`Kitbash Assets/`** local — they are gitignored. Do not push kits to GitHub.

## Features

- Batch ingest from a folder
- Material merge (dedup shared KitBash textures) — **no rebake**, tiling UVs kept
- Permissive meshopt simplify LOD 0.5 / 0.3 / 0.1
- KTX2 (ETC1S albedo, UASTC normal/ORM) once, shared across LODs
- Hemi-octahedral impostor (Puppeteer/Three)
- Optional experimental Blender atlas bake (`--atlas`, QC-gated)
- Before/after stats + `report.json`

## Why impostor?

Hard-surface / KitBash meshes often hit a **topology floor** — mid mesh LODs barely reduce tris and look broken. Recommended stack:

| Distance | Asset | Tris |
|----------|-------|------|
| Near | `lod0.glb` … `lod2.glb` | ~50% / 30% / 10% |
| Far | octahedral impostor | **2 tris** + atlas |

Default impostor is **hemi-octahedral** (Ryan Brucks). Open `preview.html` in a browser to orbit it — **Blender will only show a flat atlas quad** (no view-dependent shader).

Legacy `--impostor-mode box` bakes 4 facade planes (looks “shattered” in Blender if all faces are visible).

## Multi-kit (3 KitBash složky)

```bash
# Všechny kity pod Kitbash Assets/ → output/<KitName>/<asset>/
npm run convert:kits -- -o ./output --no-ktx2 --no-impostor

# Jen některé
npm run convert -- --kits-root "./Kitbash Assets" --only Manhattan,Brooklyn -o ./output --no-ktx2 --no-impostor

# Více vstupů najednou
npm run convert -- -i "./Kitbash Assets/Manhattan" -i "./Kitbash Assets/Brooklyn" -o ./output
```

Aktuální kity: **Brooklyn**, **Every City**, **Manhattan**.

## Gallery (LOD + impostor náhled)

Po cooku otevři lokální prohlížeč galerie — seznam assetů z `output/`, atlas thumb + orbit impostor (stejný shader jako engine):

```bash
npm run gallery
# → http://127.0.0.1:4173
```

Není to heavy: jeden Node HTTP server, žádný build. Blender impostor neumí view-dependent preview — gallery ano.

## Setup

```bash
npm install
```

**Optional:** Blender on `PATH` (or `--blender`) for FBX + experimental `--atlas` + `--bake`. Without Blender, impostors use Puppeteer + Three.js.

**Optional:** [KTX-Software](https://github.com/KhronosGroup/KTX-Software) `toktx` for `--ktx2` (on by default).

## Usage

```bash
# Recommended for buildings / KitBash (atlas OFF — keeps shared tiled textures)
npm run convert -- -i ./building.glb -o ./output

# Cap source textures before cook
npm run convert -- -i ./building.glb -o ./output --max-texture 2048

# Experimental join-all material atlas (may be rejected by QC)
npm run convert -- -i ./building.glb -o ./output --atlas

# Higher-res impostor
npm run convert -- -i ./building.glb -o ./output --impostor-res 1024 --impostor-frames 8

# Skip impostor
npm run convert -- -i ./building.glb -o ./output --no-impostor
```

## Output layout

```
output/<asset_name>/
  lod0.glb              # primary runtime mesh (+ KTX2 if enabled)
  lod1.glb              # geometry-only: textures stripped, material name stubs kept
  lod2.glb              # (engines map materials by index/name onto lod0 slots)
  impostor.glb          # far-distance billboard quad
  impostor_atlas.png
  preview.html          # view-dependent impostor preview
  pack.glb              # lod0 + metadata
  report.json
```

## Defaults

| Output | Setting |
|--------|---------|
| LOD ratios | `0.5, 0.3, 0.1` |
| Atlas bake | **off** (use `--atlas` to opt in) |
| KTX2 | on |
| Impostor | octahedral, **4096px** atlas, **12×12** frames (~341 px/view) |

Simplification `error` default: `0.01` (scaled per LOD).

## Runtime tip (Three.js)

```js
const lod = new THREE.LOD();
lod.addLevel(lod0Scene, 0);
lod.addLevel(impostorScene, 80); // switch beyond ~80 world units
```

## Notes

- Prefer shared tiled KitBash materials over join-all atlas rebake (VRAM).
- `--atlas` is experimental; nearly-black bakes are rejected and the pipeline continues without atlas.
- Dense architectural scenes may still under-simplify if UV seams dominate — check `health` in the report.
- Custom Vulkan engines need a KTX2/Basis transcoder for GPU textures.
- **Bungáč Engine:** convert with `--no-ktx2` (engine bakes PNG→BC7 itself) and copy the
  whole `output/<name>/` folder into engine `Assets/…`; the scene references `lod0.glb`
  and the engine auto-discovers `lod1/lod2.glb` siblings (material order must match — it does).
