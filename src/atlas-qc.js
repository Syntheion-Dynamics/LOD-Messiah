import { existsSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';

const MIN_MEAN_LUMINANCE = 0.02;
const MIN_UV_FACE_AREA = 1e-4;

/**
 * Reject nearly-black / degenerate-UV atlas bakes so the pipeline can fall back.
 * @param {string} atlasGlb
 * @param {string} mapsDir
 * @returns {Promise<{ ok: boolean, reason?: string, meanLuminance?: number, uvFaceAreaSum?: number }>}
 */
export async function validateAtlasBake(atlasGlb, mapsDir) {
  const albedoPath = join(mapsDir, 'albedo.png');
  if (!existsSync(atlasGlb)) {
    return { ok: false, reason: 'atlas GLB missing' };
  }
  if (!existsSync(albedoPath)) {
    return { ok: false, reason: 'albedo.png missing' };
  }

  const meanLuminance = await meanLuminancePng(albedoPath);
  if (meanLuminance < MIN_MEAN_LUMINANCE) {
    return {
      ok: false,
      reason: `albedo nearly black (mean luminance ${meanLuminance.toFixed(4)} < ${MIN_MEAN_LUMINANCE})`,
      meanLuminance,
    };
  }

  const uvFaceAreaSum = await sumUvFaceArea(atlasGlb);
  if (uvFaceAreaSum < MIN_UV_FACE_AREA) {
    return {
      ok: false,
      reason: `degenerate atlas UVs (sum face area ${uvFaceAreaSum.toExponential(2)} < ${MIN_UV_FACE_AREA})`,
      meanLuminance,
      uvFaceAreaSum,
    };
  }

  return { ok: true, meanLuminance, uvFaceAreaSum };
}

async function meanLuminancePng(path) {
  const { data, info } = await sharp(path)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const channels = info.channels;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < data.length; i += channels) {
    const r = data[i] / 255;
    const g = data[i + 1] / 255;
    const b = data[i + 2] / 255;
    // Rec. 709 luminance
    sum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
    n += 1;
  }
  return n ? sum / n : 0;
}

async function sumUvFaceArea(glbPath) {
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const doc = await io.read(glbPath);
  let area = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const uv = prim.getAttribute('TEXCOORD_0');
      const indices = prim.getIndices();
      if (!uv || !indices) continue;
      const uvs = uv.getArray();
      const idx = indices.getArray();
      if (!uvs || !idx) continue;
      for (let i = 0; i + 2 < idx.length; i += 3) {
        const i0 = idx[i] * 2;
        const i1 = idx[i + 1] * 2;
        const i2 = idx[i + 2] * 2;
        const ax = uvs[i0];
        const ay = uvs[i0 + 1];
        const bx = uvs[i1];
        const by = uvs[i1 + 1];
        const cx = uvs[i2];
        const cy = uvs[i2 + 1];
        area += Math.abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) * 0.5;
      }
    }
  }
  return area;
}
