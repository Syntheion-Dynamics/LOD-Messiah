/**
 * LOD3 silhouette proxy v2/v3: visual-hull (top+side) or height-slice + MASK bake.
 */
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { resolveBlender, ROOT } from './convert.js';
import { spawnAsync } from './spawn-async.js';

const MAX_TRIS = 3000;
const MIN_ALBEDO_BYTES = 2048;

/**
 * @param {object} options
 * @param {string} options.inputGlb
 * @param {string} options.outDir
 * @param {string} options.workDir
 * @param {number} [options.resolution]
 * @param {number} [options.slices]
 * @param {number} [options.maxFootprintVerts]
 * @param {number} [options.padding]
 * @param {'concave'|'convex'} [options.contour]
 * @param {'visual-hull'|'slices'} [options.method]
 * @param {number} [options.vhViews]
 * @param {string|null} [options.blender]
 */
export async function bakeLod3Silhouette(options) {
  const {
    inputGlb,
    outDir,
    workDir,
    resolution = 2048,
    slices = 8,
    maxFootprintVerts = 56,
    padding = 0,
    contour = 'concave',
    method = 'visual-hull',
    vhViews = 5,
    blender = null,
  } = options;

  const bin = resolveBlender(blender);
  if (!bin) {
    throw new Error(
      'LOD3 silhouette needs Blender. Set tools.config.json blender path or --blender.',
    );
  }
  if (!existsSync(inputGlb)) {
    throw new Error(`LOD3 input missing: ${inputGlb}`);
  }

  const sliceCount = Math.max(1, Math.min(16, Number(slices) || 8));
  const res = Math.max(256, Number(resolution) || 2048);
  const fpVerts = Math.max(8, Math.min(128, Number(maxFootprintVerts) || 56));
  const pad = Number.isFinite(Number(padding)) ? Number(padding) : 0;
  const contourMode = contour === 'convex' ? 'convex' : 'concave';
  const geomMethod = method === 'slices' ? 'slices' : 'visual-hull';
  const views = Math.max(3, Math.min(9, Number(vhViews) || 5));
  const mapsDir = join(outDir, 'lod3_atlas');
  const outputGlb = join(outDir, 'lod3.glb');
  const bakedGlb = join(workDir, 'lod3_baked.glb');
  mkdirSync(mapsDir, { recursive: true });
  mkdirSync(dirname(outputGlb), { recursive: true });
  mkdirSync(workDir, { recursive: true });

  const script = join(ROOT, 'scripts', 'blender_lod3_silhouette.py');
  console.log(
    `  LOD3: ${geomMethod} bake ${res}px, slices≤${sliceCount}, ${contourMode}, fp≤${fpVerts} from ${inputGlb}`,
  );
  const r = await spawnAsync(bin, [
    '--background',
    '--python',
    script,
    '--',
    '--input',
    inputGlb,
    '--output',
    bakedGlb,
    '--faces-dir',
    mapsDir,
    '--resolution',
    String(res),
    '--slices',
    String(sliceCount),
    '--max-footprint-verts',
    String(fpVerts),
    '--padding',
    String(pad),
    '--contour',
    contourMode,
    '--method',
    geomMethod,
    '--vh-views',
    String(views),
  ]);

  if (r.status !== 0 || !existsSync(bakedGlb)) {
    const log = `${r.stdout || ''}\n${r.stderr || ''}`.trim();
    throw new Error(
      `LOD3 silhouette bake failed (${r.status}):\n${log.slice(-4000) || 'no output'}`,
    );
  }

  const albedoPath = join(mapsDir, 'albedo.png');
  if (!existsSync(albedoPath) || statSync(albedoPath).size < MIN_ALBEDO_BYTES) {
    throw new Error('LOD3 QC: albedo.png missing or too small');
  }

  const io = new NodeIO();
  const doc = await io.read(bakedGlb);
  let tris = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const idx = prim.getIndices();
      if (idx) tris += idx.getCount() / 3;
    }
  }
  if (tris <= 0 || tris > MAX_TRIS) {
    throw new Error(`LOD3 QC: triangle count ${tris} out of range (1..${MAX_TRIS})`);
  }

  for (const mat of doc.getRoot().listMaterials()) {
    mat.setAlphaMode('MASK');
    mat.setAlphaCutoff(0.5);
    mat.setDoubleSided(false);
  }
  await io.write(outputGlb, doc);

  console.log(
    `  LOD3: OK — ${Math.round(tris)} tris, ${geomMethod}, MASK, albedo ${res}px (${(statSync(albedoPath).size / 1024).toFixed(0)} KB)`,
  );

  return {
    outputGlb,
    mapsDir,
    resolution: res,
    slices: sliceCount,
    method: geomMethod,
    triangles: Math.round(tris),
    backend: geomMethod === 'visual-hull' ? 'visual-hull+blender' : 'height-slice+blender',
  };
}
