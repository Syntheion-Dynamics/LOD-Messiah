/**
 * P2: LOD2 unique-UV + single 1024px PBR atlas bake.
 * watlas → TEXCOORD_1, Blender Cycles bake (albedo/normal/ORM), QC gate.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { unwrap } from '@gltf-transform/functions';
import * as watlas from 'watlas';
import { resolveBlender, ROOT } from './convert.js';
import { validateAtlasBake } from './atlas-qc.js';

/**
 * @param {object} options
 * @param {import('@gltf-transform/core').Document} options.doc simplified lod2 with PNG textures
 * @param {import('@gltf-transform/core').NodeIO} options.io
 * @param {string} options.workDir
 * @param {string} options.outDir
 * @param {string} options.outputGlb final lod2.glb path
 * @param {number} [options.resolution]
 * @param {string|null} [options.blender]
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
  const r = spawnSync(
    bin,
    [
      '--background',
      '--python',
      script,
      '--',
      '--input',
      prepGlb,
      '--output',
      bakedGlb,
      '--faces-dir',
      mapsDir,
      '--resolution',
      String(resolution),
    ],
    {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    },
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

  copyFileSync(bakedGlb, outputGlb);
  console.log(
    `  LOD2: atlas OK (luma ${qc.meanLuminance?.toFixed(3)}, uvArea ${qc.uvFaceAreaSum?.toFixed(3)})`,
  );

  return {
    outputGlb,
    mapsDir,
    resolution,
    meanLuminance: qc.meanLuminance,
    uvFaceAreaSum: qc.uvFaceAreaSum,
    backend: 'watlas+blender',
  };
}
