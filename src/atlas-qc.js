import { existsSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';

const MIN_MEAN_LUMINANCE = 0.02;
const MIN_UV_FACE_AREA = 1e-4;
/** Opaque pixels darker than this count as near-black (failed glass bake). */
const NEAR_BLACK_LUMA = 0.04;
/**
 * Warn — never fail — above this share of near-black opaque pixels.
 *
 * Rejecting the bake makes things strictly worse: the caller falls back to
 * stripTextures(), so a partly-dark atlas is traded for a LOD2 with no texture
 * at all, which in turn drops LOD3 off the proxy chain. Dark buildings are also
 * a legitimate art choice. Surface it, keep the atlas.
 */
const WARN_NEAR_BLACK_RATIO = 0.18;

/**
 * @typedef {object} AtlasQcResult
 * @property {boolean} ok
 * @property {string} [reason]        set only when ok === false
 * @property {string[]} warnings      non-fatal findings, safe to ship
 * @property {number} [meanLuminance] mean over every pixel (legacy gate)
 * @property {number} [meanLuminanceOpaque] mean over opaque pixels only
 * @property {number} [nearBlackRatio]
 * @property {number} [uvFaceAreaSum]
 */

/**
 * Reject nearly-black / degenerate-UV atlas bakes so the pipeline can fall back.
 * @param {string} atlasGlb
 * @param {string} mapsDir
 * @returns {Promise<AtlasQcResult>}
 */
export async function validateAtlasBake(atlasGlb, mapsDir) {
  const albedoPath = join(mapsDir, 'albedo.png');
  if (!existsSync(atlasGlb)) {
    return { ok: false, reason: 'atlas GLB missing', warnings: [] };
  }
  if (!existsSync(albedoPath)) {
    return { ok: false, reason: 'albedo.png missing', warnings: [] };
  }

  const stats = await albedoStatsPng(albedoPath);
  const { meanLuminance, meanLuminanceOpaque, nearBlackRatio } = stats;
  /** @type {string[]} */
  const warnings = [];

  if (nearBlackRatio > WARN_NEAR_BLACK_RATIO) {
    warnings.push(
      `albedo near-black ${(nearBlackRatio * 100).toFixed(1)}% of opaque px ` +
        `(> ${(WARN_NEAR_BLACK_RATIO * 100).toFixed(0)}%) — check glass proxy`,
    );
  }

  if (meanLuminance < MIN_MEAN_LUMINANCE) {
    return {
      ok: false,
      reason: `albedo nearly black (mean luminance ${meanLuminance.toFixed(4)} < ${MIN_MEAN_LUMINANCE})`,
      warnings,
      meanLuminance,
      meanLuminanceOpaque,
      nearBlackRatio,
    };
  }

  const uvFaceAreaSum = await sumUvFaceArea(atlasGlb);
  if (uvFaceAreaSum < MIN_UV_FACE_AREA) {
    return {
      ok: false,
      reason: `degenerate atlas UVs (sum face area ${uvFaceAreaSum.toExponential(2)} < ${MIN_UV_FACE_AREA})`,
      warnings,
      meanLuminance,
      meanLuminanceOpaque,
      nearBlackRatio,
      uvFaceAreaSum,
    };
  }

  return {
    ok: true,
    warnings,
    meanLuminance,
    meanLuminanceOpaque,
    nearBlackRatio,
    uvFaceAreaSum,
  };
}

/**
 * Mean Rec.709 luminance + fraction of opaque pixels below NEAR_BLACK_LUMA.
 *
 * `meanLuminance` spans every pixel and is kept only for the legacy
 * MIN_MEAN_LUMINANCE gate. Use `meanLuminanceOpaque` to compare two atlases:
 * empty atlas space differs wildly between layouts (a watlas LOD2 pack vs the
 * LOD3 3×2 grid, which leaves ~33% of a square atlas unused), so an all-pixel
 * mean measures packing efficiency far more than it measures appearance.
 *
 * @param {string} path
 * @returns {Promise<{ meanLuminance: number, meanLuminanceOpaque: number, nearBlackRatio: number, opaqueRatio: number }>}
 */
export async function albedoStatsPng(path) {
  const { data, info } = await sharp(path)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const channels = info.channels;
  let sum = 0;
  let n = 0;
  let sumOpaque = 0;
  let opaque = 0;
  let nearBlack = 0;
  for (let i = 0; i < data.length; i += channels) {
    const a = channels > 3 ? data[i + 3] / 255 : 1;
    const r = data[i] / 255;
    const g = data[i + 1] / 255;
    const b = data[i + 2] / 255;
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    sum += luma;
    n += 1;
    if (a < 0.1) continue;
    opaque += 1;
    sumOpaque += luma;
    if (luma < NEAR_BLACK_LUMA) nearBlack += 1;
  }
  return {
    meanLuminance: n ? sum / n : 0,
    meanLuminanceOpaque: opaque ? sumOpaque / opaque : 0,
    nearBlackRatio: opaque ? nearBlack / opaque : 0,
    opaqueRatio: n ? opaque / n : 0,
  };
}

async function meanLuminancePng(path) {
  const { meanLuminance } = await albedoStatsPng(path);
  return meanLuminance;
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
