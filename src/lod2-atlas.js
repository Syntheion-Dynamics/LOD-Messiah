/**
 * P2: LOD2 unique-UV + single 1024px PBR atlas bake.
 * watlas → TEXCOORD_1, Blender Cycles bake (albedo/normal/ORM), QC gate.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { unwrap } from '@gltf-transform/functions';
import * as watlas from 'watlas';
import { resolveBlender, ROOT } from './convert.js';
import { validateAtlasBake } from './atlas-qc.js';
import { spawnAsync } from './spawn-async.js';

/**
 * @param {object} options
 * @param {import('@gltf-transform/core').Document} options.doc simplified lod2 with PNG textures
 * @param {import('@gltf-transform/core').NodeIO} options.io
 * @param {string} options.workDir
 * @param {string} options.outDir
 * @param {string} options.outputGlb final lod2.glb path
 * @param {number} [options.resolution]
 * @param {string|null} [options.blender]
 * @param {number[]} [options.glassTint] LINEAR r,g,b sky proxy for unusable glass base colours
 * @param {number} [options.glassMetallic] far-LOD glass metallic (low: no IBL → metal reads black)
 * @param {number} [options.glassRoughness]
 * @param {boolean} [options.glassProxy] default true; false bakes glass untouched (debug)
 */
export async function bakeLod2Atlas(options) {
  const {
    doc,
    io,
    workDir,
    outDir,
    outputGlb,
    resolution = 1024,
    blender = null,
    glassTint = null,
    glassMetallic = null,
    glassRoughness = null,
    glassProxy = true,
  } = options;

  const bin = resolveBlender(blender);
  if (!bin) {
    throw new Error(
      'LOD2 atlas needs Blender. Set tools.config.json blender path or --blender.',
    );
  }

  const mapsDir = join(outDir, 'lod2_atlas');
  const prepGlb = join(workDir, 'lod2_pre_atlas.glb');
  const bakedGlb = join(workDir, 'lod2_atlas_baked.glb');
  mkdirSync(mapsDir, { recursive: true });
  mkdirSync(dirname(outputGlb), { recursive: true });

  // Unique UV on TEXCOORD_1; keep TEXCOORD_0 for tiling sample during bake
  try {
    await doc.transform(
      unwrap({
        watlas,
        texcoord: 1,
        overwrite: true,
        groupBy: 'scene',
      }),
    );
    console.log('  LOD2: watlas unwrap → TEXCOORD_1');
  } catch (err) {
    console.warn(`  LOD2: watlas unwrap failed — Blender Smart UV fallback (${err.message})`);
  }

  await io.write(prepGlb, doc);

  const script = join(ROOT, 'scripts', 'blender_lod2_atlas_bake.py');
  console.log(`  LOD2: Blender atlas bake ${resolution}px`);

  const bakeArgs = [
    '--input',
    prepGlb,
    '--output',
    bakedGlb,
    '--faces-dir',
    mapsDir,
    '--resolution',
    String(resolution),
  ];
  if (!glassProxy) {
    bakeArgs.push('--no-glass-proxy');
  } else {
    if (Array.isArray(glassTint) && glassTint.length >= 3) {
      bakeArgs.push('--glass-tint', glassTint.slice(0, 3).join(','));
    }
    if (glassMetallic != null) {
      bakeArgs.push('--glass-metallic', String(glassMetallic));
    }
    if (glassRoughness != null) {
      bakeArgs.push('--glass-roughness', String(glassRoughness));
    }
  }

  const r = await spawnAsync(
    bin,
    ['--background', '--python', script, '--', ...bakeArgs],
    { maxBuffer: 256 * 1024 * 1024 },
  );

  if (r.status !== 0 || !existsSync(bakedGlb)) {
    const log = `${r.stdout || ''}\n${r.stderr || ''}`.trim();
    throw new Error(
      `LOD2 atlas bake failed (${r.status}):\n${log.slice(-4000) || 'no output'}`,
    );
  }

  const qc = await validateAtlasBake(bakedGlb, mapsDir);
  if (!qc.ok) {
    throw new Error(`LOD2 atlas QC rejected — ${qc.reason}`);
  }

  // Blender exports the atlas material as BLEND+doubleSided; with fully-opaque
  // alpha that only buys depth-sorting artifacts (see-through facades). Force OPAQUE.
  const bakedDoc = await io.read(bakedGlb);
  for (const mat of bakedDoc.getRoot().listMaterials()) {
    mat.setAlphaMode('OPAQUE');
  }
  await io.write(outputGlb, bakedDoc);
  console.log(
    `  LOD2: atlas OK (luma ${qc.meanLuminanceOpaque?.toFixed(3)} opaque / ` +
      `${qc.meanLuminance?.toFixed(3)} all, ` +
      `nearBlack ${((qc.nearBlackRatio ?? 0) * 100).toFixed(1)}%, ` +
      `uvArea ${qc.uvFaceAreaSum?.toFixed(3)})`,
  );
  for (const w of qc.warnings ?? []) {
    console.warn(`  LOD2: ⚠ ${w}`);
  }

  return {
    outputGlb,
    mapsDir,
    resolution,
    meanLuminance: qc.meanLuminance,
    meanLuminanceOpaque: qc.meanLuminanceOpaque,
    nearBlackRatio: qc.nearBlackRatio,
    uvFaceAreaSum: qc.uvFaceAreaSum,
    warnings: qc.warnings ?? [],
    backend: 'watlas+blender',
  };
}
