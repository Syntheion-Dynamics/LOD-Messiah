#!/usr/bin/env node
import { basename, join, resolve } from 'node:path';
import {
  discoverAssets,
  listKitFolders,
} from './convert.js';
import { processBatch } from './pipeline.js';

function printHelp() {
  console.log(`
LOD Messiah — High-Poly → Engine-Ready (KitBash pipeline)

  npm run convert -- -i <file|folder> [-i <more>…] -o ./output [options]
  npm run convert:kits -- -o ./output --no-ktx2

Defaults: lod2 atlas ON (1024), ktx2 ON, LOD 0.5/0.3/0.1, octahedral impostor 4096/12
  lod0/lod1: tiling multi-material. lod2: unique UV + 1× atlas (Blender), fallback geometry-only.

Multi-kit:
  -i / --input PATH       Repeatable. File or folder (walks recursively).
  --kits-root PATH        Process each subfolder as a kit
                          Output: <out>/<KitName>/<asset>/…
  --only A,B              With --kits-root: only these kit folder names

  --no-lod2-atlas         Skip LOD2 atlas bake (geometry-only like lod1)
  --lod2-atlas-res N      LOD2 atlas edge px (default 1024, hero→2048)
  --hero                  Higher impostor (4096/16) + lod2 atlas 2048
  --ktx2 / --no-ktx2      toktx KTX2 compress
  --ratio 0.5,0.3,0.1     Mesh LOD ratios
  --impostor-mode octahedral|box
  --impostor-res N        Impostor atlas edge px (default 4096)
  --impostor-frames N     Grid size (default 12)
  --no-impostor
  --max-texture N         Cap basecolor/emissive; normal/ORM capped at 1024
  --pack                  Also write legacy pack.glb (off by default)
  --shared-textures       Kit _textures/ + external URIs (engine must support!)
  --no-shared-textures    Embed textures in lod0 (DEFAULT — engine-safe)
  --blender / --toktx     Tool paths
  --keep-work

Engine handoff tip:
  npm run convert:kits -- -o ./output --no-ktx2
`);
}

function parseArgs(argv) {
  const args = {
    inputs: [],
    kitsRoot: null,
    onlyKits: null,
    output: './output',
    ratios: [0.5, 0.3, 0.1],
    error: 0.01,
    errors: null,
    bake: false,
    bakeRes: 2048,
    maxTexture: null,
    pack: false,
    sharedTextures: false,
    blender: null,
    gltfpack: null,
    toktx: null,
    keepWork: false,
    impostor: true,
    impostorMode: 'octahedral',
    impostorRes: 4096,
    impostorFrames: 12,
    impostorTop: false,
    lod2Atlas: true,
    lod2AtlasRes: null,
    hero: false,
    ktx2: true,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`Missing value after ${a}`);
      return v;
    };

    switch (a) {
      case '--help':
      case '-h':
        args.help = true;
        break;
      case '--input':
      case '-i':
        args.inputs.push(next());
        break;
      case '--kits-root':
        args.kitsRoot = next();
        break;
      case '--only':
        args.onlyKits = next()
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      case '--output':
      case '-o':
        args.output = next();
        break;
      case '--ratio':
        args.ratios = next()
          .split(',')
          .map((s) => Number(s.trim()))
          .filter((n) => !Number.isNaN(n) && n > 0 && n <= 1);
        break;
      case '--error': {
        const raw = next();
        if (raw.includes(',')) {
          args.errors = raw.split(',').map((s) => Number(s.trim()));
          args.error = args.errors[0] ?? 0.01;
        } else {
          args.error = Number(raw);
        }
        break;
      }
      case '--atlas':
        console.warn(
          '  note: --atlas (pre-LOD join-all) removed; LOD2 atlas is on by default. Use --no-lod2-atlas to disable.',
        );
        break;
      case '--no-atlas':
        args.lod2Atlas = false;
        break;
      case '--no-lod2-atlas':
        args.lod2Atlas = false;
        break;
      case '--lod2-atlas-res':
        args.lod2AtlasRes = Number(next());
        break;
      case '--hero':
        args.hero = true;
        break;
      case '--ktx2':
        args.ktx2 = true;
        break;
      case '--no-ktx2':
        args.ktx2 = false;
        break;
      case '--impostor':
        args.impostor = true;
        break;
      case '--no-impostor':
        args.impostor = false;
        break;
      case '--impostor-mode':
        args.impostorMode = next().toLowerCase();
        break;
      case '--impostor-res':
        args.impostorRes = Number(next());
        break;
      case '--impostor-frames':
        args.impostorFrames = Number(next());
        break;
      case '--impostor-top':
        args.impostorTop = true;
        break;
      case '--bake':
        args.bake = true;
        break;
      case '--bake-res':
        args.bakeRes = Number(next());
        break;
      case '--max-texture':
        args.maxTexture = Number(next());
        break;
      case '--pack':
        args.pack = true;
        break;
      case '--no-pack':
        args.pack = false;
        break;
      case '--no-shared-textures':
        args.sharedTextures = false;
        break;
      case '--blender':
        args.blender = next();
        break;
      case '--toktx':
        args.toktx = next();
        break;
      case '--gltfpack':
        args.gltfpack = next();
        break;
      case '--keep-work':
        args.keepWork = true;
        break;
      default:
        if (a.startsWith('-')) throw new Error(`Unknown option: ${a}`);
        // positional: first = input, second = output (legacy)
        if (args.inputs.length === 0) args.inputs.push(a);
        else args.output = a;
        break;
    }
  }
  return args;
}

function buildOptions(args, inputRoot, outputDir) {
  return {
    input: resolve(inputRoot),
    output: resolve(outputDir),
    ratios: args.ratios,
    error: args.error,
    errors: args.errors,
    bake: args.bake,
    bakeRes: args.bakeRes,
    maxTexture: args.maxTexture,
    pack: args.pack,
    sharedTextures: args.sharedTextures,
    blender: args.blender,
    gltfpack: args.gltfpack,
    toktx: args.toktx,
    keepWork: args.keepWork,
    impostor: args.impostor,
    impostorMode: args.impostorMode,
    impostorRes: args.impostorRes,
    impostorFrames: args.impostorFrames,
    impostorTop: args.impostorTop,
    lod2Atlas: args.lod2Atlas,
    lod2AtlasRes: args.lod2AtlasRes,
    hero: args.hero,
    ktx2: args.ktx2,
  };
}

function printBanner(options, extra = '') {
  console.log('LOD Messiah — High-Poly → Engine-Ready');
  if (extra) console.log(`  ${extra}`);
  console.log(`  input  : ${options.input}`);
  console.log(`  output : ${options.output}`);
  console.log(`  ratios : ${options.ratios.join(', ')}`);
  console.log(
    `  lod2 atlas: ${
      options.lod2Atlas !== false
        ? `${options.lod2AtlasRes ?? (options.hero ? 2048 : 1024)}px`
        : 'no'
    }`,
  );
  console.log(`  ktx2   : ${options.ktx2 ? 'yes' : 'no'}`);
  console.log(
    `  impostor: ${
      options.impostor
        ? `${options.impostorMode} ${options.impostorRes}px / ${options.impostorFrames}×${options.impostorFrames}`
        : 'no'
    }`,
  );
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  const hasKits = args.kitsRoot != null;
  const hasInputs = args.inputs.length > 0;
  if (args.help || (!hasKits && !hasInputs)) {
    printHelp();
    process.exit(args.help ? 0 : 1);
  }

  let totalFailures = 0;

  // Mode A: --kits-root → each kit subfolder → output/<KitName>/
  if (hasKits) {
    const kitsRoot = resolve(args.kitsRoot || './Kitbash Assets');
    let kits = listKitFolders(kitsRoot);
    if (args.onlyKits?.length) {
      const want = new Set(args.onlyKits.map((s) => s.toLowerCase()));
      kits = kits.filter((k) => want.has(k.name.toLowerCase()));
    }
    if (kits.length === 0) {
      console.error(`No kit folders under ${kitsRoot}`);
      process.exit(1);
    }
    console.log(`LOD Messiah — kits mode (${kits.length}): ${kits.map((k) => k.name).join(', ')}`);

    for (const kit of kits) {
      const options = buildOptions(args, kit.path, join(args.output, kit.name));
      printBanner(options, `kit: ${kit.name}`);
      const assets = discoverAssets(kit.path);
      if (assets.length === 0) {
        console.warn(`  skip ${kit.name}: no assets`);
        continue;
      }
      console.log(`  assets : ${assets.length}`);
      const { failures } = await processBatch(assets, options);
      totalFailures += failures.length;
    }
    process.exit(totalFailures > 0 ? 1 : 0);
  }

  // Mode B: one or more -i paths
  const inputPaths = args.inputs.map((p) => resolve(p));

  // Multiple folder inputs → treat each like a kit (output/<folderName>/)
  if (inputPaths.length > 1) {
    console.log(
      `LOD Messiah — multi-input (${inputPaths.length} paths)`,
    );
    for (const p of inputPaths) {
      const name = basename(p);
      const options = buildOptions(args, p, join(args.output, name));
      printBanner(options);
      const assets = discoverAssets(p);
      if (assets.length === 0) {
        console.warn(`  skip ${name}: no assets`);
        continue;
      }
      console.log(`  assets : ${assets.length}`);
      const { failures } = await processBatch(assets, options);
      totalFailures += failures.length;
    }
    process.exit(totalFailures > 0 ? 1 : 0);
  }

  const options = buildOptions(args, inputPaths[0], args.output);
  printBanner(options);

  const assets = discoverAssets(inputPaths[0]);
  if (assets.length === 0) {
    console.error('No assets found.');
    process.exit(1);
  }
  console.log(`  assets : ${assets.length}`);

  const { failures } = await processBatch(assets, options);
  process.exit(failures.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
