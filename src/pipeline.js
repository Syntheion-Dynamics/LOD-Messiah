import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  copyFileSync,
  readdirSync,
} from 'node:fs';
import { join as pathJoin, relative, basename, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import {
  reorder,
  dedup,
  prune,
  flatten,
  join,
} from '@gltf-transform/functions';
import { MeshoptSimplifier, MeshoptEncoder } from 'meshoptimizer';
import sharp from 'sharp';
import {
  normalizeToGlb,
  runBlenderBakeNormals,
  assetStem,
  makeWorkDir,
} from './convert.js';
import { runAtlasBake } from './atlas.js';
import { validateAtlasBake } from './atlas-qc.js';
import { mergeMaterials } from './material-merge.js';
import { compressTexturesKtx2 } from './ktx2.js';
import { permissiveSimplify } from './permissive-simplify.js';
import { generateImpostor } from './impostor.js';
import {
  collectStats,
  fileSizeBytes,
  printAssetReport,
  reductionReport,
  assessHealth,
} from './stats.js';

/** Normal maps — biggest VRAM eaters; 1024 after BC7 is enough on buildings. */
const TEX_CAP_NORMAL = 1024;
/** Metallic-roughness / occlusion. */
const TEX_CAP_ORM = 1024;

/**
 * @typedef {object} PipelineOptions
 * @property {string} input
 * @property {string} output
 * @property {number[]} ratios
 * @property {number} error
 * @property {number[]|null} [errors]
 * @property {boolean} bake
 * @property {number} bakeRes
 * @property {number|null} maxTexture
 * @property {boolean} pack
 * @property {boolean} [sharedTextures]
 * @property {string|null} blender
 * @property {string|null} gltfpack
 * @property {string|null} [toktx]
 * @property {boolean} keepWork
 * @property {boolean} impostor
 * @property {string} [impostorMode]
 * @property {number} impostorRes
 * @property {number} [impostorFrames]
 * @property {boolean} impostorTop
 * @property {boolean} atlas
 * @property {boolean} hero
 * @property {boolean} ktx2
 */

export async function processAsset(assetPath, options) {
  const stem = assetStem(assetPath, options.input);
  const outDir = pathJoin(options.output, ...stem.split('/').filter(Boolean));
  mkdirSync(outDir, { recursive: true });

  const workDir = makeWorkDir(outDir);
  // Embedded is the engine-safe default; external `_textures/` URIs are opt-in
  // until the engine loader supports glTF external images.
  const sharedTextures = options.sharedTextures === true;
  const texturesDir = pathJoin(options.output, '_textures');

  console.log(`\n→ Processing: ${assetPath}`);
  console.log(`  work dir : ${workDir}`);
  console.log(`  output   : ${outDir}`);

  try {
    const { glbPath: rawGlb, sourceFormat, converted } = await normalizeToGlb(
      assetPath,
      workDir,
      { blender: options.blender, gltfpack: options.gltfpack },
    );
    console.log(
      `  source   : ${sourceFormat}${converted ? ' (converted→glb)' : ''}`,
    );

    let glbPath = rawGlb;
    const io = createIO();
    await MeshoptSimplifier.ready;
    await MeshoptEncoder.ready;

    const rawDoc = await io.read(glbPath);
    const beforeRaw = collectStats(rawDoc, fileSizeBytes(glbPath));

    // 1) Optional experimental atlas bake (QC-gated)
    let atlasUsed = false;
    if (options.atlas) {
      const atlasRes = options.hero ? 2048 : 1024;
      const atlasGlb = pathJoin(workDir, 'atlas.glb');
      const mapsDir = pathJoin(outDir, 'atlas_maps');
      try {
        runAtlasBake({
          inputGlb: glbPath,
          outputGlb: atlasGlb,
          mapsDir,
          resolution: atlasRes,
          blender: options.blender,
        });
        const qc = await validateAtlasBake(atlasGlb, mapsDir);
        if (qc.ok) {
          glbPath = atlasGlb;
          atlasUsed = true;
          console.log(
            `  atlas   : QC OK (luma ${qc.meanLuminance?.toFixed(3)}, uvArea ${qc.uvFaceAreaSum?.toFixed(3)})`,
          );
        } else {
          console.warn(`  atlas   : QC REJECTED — ${qc.reason}`);
          console.warn('  atlas   : continuing without atlas');
        }
      } catch (err) {
        console.warn(`  atlas   : FAILED — ${err.message}`);
        console.warn('  atlas   : continuing without atlas');
      }
    }

    let sourceDoc = await io.read(glbPath);

    // 2) Material merge (no rebake) — always
    const mergeStats = await mergeMaterials(sourceDoc);
    console.log(
      `  materials: merge ${mergeStats.materialsBefore} → ${mergeStats.materialsAfter} mat | ${mergeStats.texturesBefore} → ${mergeStats.texturesAfter} tex (slots remapped ${mergeStats.merged})`,
    );
    const mergedGlb = pathJoin(workDir, 'merged.glb');
    await io.write(mergedGlb, sourceDoc);
    glbPath = mergedGlb;
    sourceDoc = await io.read(glbPath);

    // Optional texture cap — per material slot (normal/ORM stricter than basecolor)
    if (options.maxTexture) {
      const r = await resizeTexturesSafe(sourceDoc, options.maxTexture);
      console.log(
        `  textures : resize base≤${options.maxTexture} normal/ORM≤${TEX_CAP_NORMAL} — ${r.resized} ok, ${r.skipped} skip, ${r.failed} fail`,
      );
      await io.write(glbPath, sourceDoc);
      sourceDoc = await io.read(glbPath);
    }

    // Working copy always keeps textures embedded (LOD + impostor need that).
    // Public lod0/default get external URIs into kit `_textures/` when sharedTextures.
    const embeddedGlb = pathJoin(workDir, 'embedded.glb');
    await io.write(embeddedGlb, sourceDoc);
    glbPath = embeddedGlb;

    // Fix 5: full-quality model before decimation
    const defaultPath = pathJoin(outDir, 'default.glb');
    let sharedTexStats = null;
    if (sharedTextures) {
      const defDoc = await io.read(embeddedGlb);
      sharedTexStats = await externalizeTextures(defDoc, texturesDir, outDir);
      console.log(
        `  textures : shared ${sharedTexStats.written} new, ${sharedTexStats.reused} reused → ${texturesDir}`,
      );
      await writeGlbPreservingExternalImages(io, defDoc, defaultPath, workDir);
    } else {
      await io.write(defaultPath, sourceDoc);
    }
    console.log(`  default  : ${defaultPath} (${fileSizeBytes(defaultPath)} bytes)`);

    // Impostor MUST bake from PNG/JPEG — Puppeteer has no KTX2 transcoder.
    const impostorSourceGlb = embeddedGlb;

    // 3) KTX2 once on shared textures (before LOD fork)
    if (options.ktx2 !== false) {
      try {
        const k = await compressTexturesKtx2(sourceDoc, { toktx: options.toktx });
        console.log(`  ktx2    : ${k.converted}/${k.total} textures (shared across LODs)`);
        const ktxGlb = pathJoin(workDir, 'source_ktx2.glb');
        await io.write(ktxGlb, sourceDoc);
        glbPath = ktxGlb;
        sourceDoc = await io.read(glbPath);
      } catch (err) {
        console.warn(`  ktx2    : skipped — ${err.message}`);
      }
    }

    // Geometry baseline after instance expand (same join as LOD path)
    const baselineDoc = await io.read(glbPath);
    await baselineDoc.transform(dedup(), flatten(), join());
    const beforeGeom = collectStats(baselineDoc, fileSizeBytes(glbPath));
    console.log(
      `  geometry: ${beforeGeom.triangles.toLocaleString()} tris after join (${beforeRaw.triangles.toLocaleString()} instanced)`,
    );

    // 4) LOD chain
    const lodResults = [];
    const ratios = options.ratios?.length ? options.ratios : [0.5, 0.3, 0.1];

    for (let i = 0; i < ratios.length; i++) {
      const ratio = ratios[i];
      const label = `LOD${i}`;
      const lodPath = pathJoin(outDir, `lod${i}.glb`);
      // Ladder ×1/×2/×8 (0.01 / 0.02 / 0.08).
      const errorMul = i >= 2 ? 8 : Math.pow(2, i);
      const lodError =
        Array.isArray(options.errors) && options.errors[i] != null
          ? options.errors[i]
          : options.error * errorMul;
      const protectUv = i < 2;
      const pruneError = i >= 2 ? 0.02 : 0.01;

      console.log(
        `  ${label}: permissive simplify ratio=${ratio} error=${lodError} prune=${pruneError}${protectUv ? '' : ' (uv seams free)'}`,
      );

      const doc = await io.read(glbPath);
      await doc.transform(dedup(), flatten(), join());

      const simp = await permissiveSimplify(doc, {
        ratio,
        error: lodError,
        pruneError,
        protectUv,
      });
      console.log(
        `  ${label}: tris ${simp.srcTris.toLocaleString()} → ${simp.dstTris.toLocaleString()}`,
      );

      await MeshoptEncoder.ready;
      await doc.transform(
        reorder({ encoder: MeshoptEncoder, target: 'performance' }),
        prune(),
      );

      // LOD1+ geometry-only — textures live in lod0 / _textures
      if (i >= 1) {
        const strippedCount = stripTextures(doc);
        console.log(
          `  ${label}: stripped ${strippedCount} textures (geometry-only, material name stubs kept)`,
        );
        await io.write(lodPath, doc);
      } else if (sharedTextures) {
        const embedLod0 = pathJoin(workDir, 'lod0_embedded.glb');
        await io.write(embedLod0, doc);
        const pubDoc = await io.read(embedLod0);
        await externalizeTextures(pubDoc, texturesDir, outDir);
        await writeGlbPreservingExternalImages(io, pubDoc, lodPath, workDir);
      } else {
        await io.write(lodPath, doc);
      }

      if (options.bake && i === 0) {
        console.log(`  ${label}: baking normals (${options.bakeRes}px)...`);
        const normalsPng = pathJoin(outDir, 'normals.png');
        const bakedGlb = pathJoin(outDir, 'lod0_baked.glb');
        try {
          runBlenderBakeNormals({
            blender: options.blender,
            highGlb: rawGlb,
            lowGlb: lodPath,
            outputGlb: bakedGlb,
            normalsPng,
            resolution: options.bakeRes,
          });
          copyFileSync(bakedGlb, lodPath);
          rmSync(bakedGlb, { force: true });
          console.log(`  ${label}: bake OK`);
        } catch (err) {
          console.warn(`  ${label}: bake skipped — ${err.message}`);
        }
      }

      const stats = collectStats(doc, fileSizeBytes(lodPath));
      const health = assessHealth(beforeGeom, stats, ratio);
      lodResults.push({
        label,
        level: i,
        targetRatio: ratio,
        path: lodPath,
        stats,
        health,
        baked: false,
        reduction: reductionReport(beforeGeom, stats),
        // Embedded lod0 for impostor bake (Puppeteer can't follow ../_textures)
        embedPath: i === 0 ? pathJoin(workDir, 'lod0_embedded.glb') : null,
      });
    }

    // 5) Impostor — stage into workDir; bake from embedded lod0 (not external)
    let impostorInfo = null;
    if (options.impostor) {
      const impostorPath = pathJoin(outDir, 'impostor.glb');
      const facesDir = pathJoin(workDir, 'impostor_faces');
      const mode = options.impostorMode || 'octahedral';
      let impostorRes =
        options.impostorRes || (mode === 'octahedral' ? 4096 : 512);
      let impostorFrames = options.impostorFrames || 12;
      if (options.hero && mode === 'octahedral') {
        if (options.impostorRes == null) impostorRes = 4096;
        if (options.impostorFrames == null || options.impostorFrames === 12) {
          impostorFrames = 16;
        }
      }
      const lod0Entry = lodResults.find((l) => l.level === 0);
      const bakeFrom =
        (lod0Entry?.embedPath && existsSync(lod0Entry.embedPath)
          ? lod0Entry.embedPath
          : null) ||
        impostorSourceGlb;
      try {
        const result = await generateImpostor({
          inputGlb: bakeFrom,
          outputGlb: impostorPath,
          facesDir,
          outDir,
          stageDir: workDir,
          resolution: impostorRes,
          includeTop: !!options.impostorTop,
          blender: options.blender,
          mode,
          frames: impostorFrames,
        });
        const stats = collectStats(
          await io.read(impostorPath),
          fileSizeBytes(impostorPath),
        );
        impostorInfo = {
          path: impostorPath,
          backend: result.backend,
          mode,
          stats,
          atlasPath: result.atlasPath || null,
          frames: result.frames || impostorFrames,
          resolution: result.atlasSize || impostorRes,
          hemi: true,
        };
        lodResults.push({
          label: 'IMPOSTOR',
          level: 'impostor',
          targetRatio: 0,
          path: impostorPath,
          stats,
          health: {
            ok: true,
            msg:
              mode === 'octahedral'
                ? `octahedral — open preview.html`
                : `box impostor`,
          },
          baked: false,
          impostor: true,
          reduction: reductionReport(beforeGeom, stats),
        });
        console.log(`  impostor: OK (${mode}, ${stats.fileMB} MB)`);
      } catch (err) {
        console.warn(`  impostor: skipped — ${err.message}`);
        if (err.stack) console.warn(err.stack);
      }
    }

    // Fix 3: asset.json sidecar (pack.glb only if --pack)
    const assetJsonPath = writeAssetJson(outDir, stem, lodResults, impostorInfo, {
      default: 'default.glb',
      sharedTextures,
    });
    console.log(`  asset    : ${assetJsonPath}`);

    let packPath = null;
    if (options.pack === true && lodResults.some((l) => !l.impostor)) {
      packPath = await writePackGlb(io, lodResults, outDir, stem, impostorInfo);
    }

    cleanupOutputJunk(outDir);

    printAssetReport(stem, beforeGeom, lodResults);

    const report = {
      name: stem,
      source: assetPath,
      sourceFormat,
      generatedAt: new Date().toISOString(),
      options: {
        ratios,
        atlas: !!options.atlas,
        atlasUsed,
        hero: !!options.hero,
        ktx2: options.ktx2 !== false,
        impostor: options.impostor,
        impostorMode: options.impostorMode || 'octahedral',
        sharedTextures,
        maxTexture: options.maxTexture,
      },
      beforeRaw,
      before: beforeGeom,
      materialMerge: mergeStats,
      sharedTextures: sharedTexStats,
      default: defaultPath,
      asset: assetJsonPath,
      lods: lodResults.map((l) => ({
        label: l.label,
        level: l.level,
        targetRatio: l.targetRatio,
        path: l.path,
        stats: l.stats,
        health: l.health,
        impostor: !!l.impostor,
        reduction: l.reduction,
      })),
      impostor: impostorInfo,
      pack: packPath,
    };

    try {
      report.materialsBefore = rawDoc.getRoot().listMaterials().length;
      report.texturesBefore = rawDoc.getRoot().listTextures().length;
      report.materialsAfter = mergeStats.materialsAfter;
      report.texturesAfter = mergeStats.texturesAfter;
    } catch {
      report.materialsBefore = mergeStats.materialsBefore;
      report.materialsAfter = mergeStats.materialsAfter;
      report.texturesBefore = mergeStats.texturesBefore;
      report.texturesAfter = mergeStats.texturesAfter;
    }

    const reportPath = pathJoin(outDir, 'report.json');
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`  report   : ${reportPath}`);
    if (report.materialsBefore != null) {
      console.log(
        `  materials: ${report.materialsBefore} → ${report.materialsAfter} | textures: ${report.texturesBefore} → ${report.texturesAfter}`,
      );
    }

    return report;
  } finally {
    if (!options.keepWork && existsSync(workDir)) {
      try {
        rmSync(workDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }
}

function createIO() {
  return new NodeIO().registerExtensions(ALL_EXTENSIONS);
}

/** Detach and dispose every texture; materials survive as name stubs. */
function stripTextures(doc) {
  const textures = doc.getRoot().listTextures();
  for (const texture of textures) {
    texture.dispose();
  }
  return textures.length;
}

/**
 * Cap per material slot: basecolor/emissive → maxBase; normal/ORM → 1024.
 * Texture used in multiple slots gets the strictest (smallest) cap.
 * @param {import('@gltf-transform/core').Document} doc
 * @param {number} maxBase
 */
async function resizeTexturesSafe(doc, maxBase) {
  const caps = buildTextureCaps(doc, maxBase);
  let resized = 0;
  let skipped = 0;
  let failed = 0;

  for (const texture of doc.getRoot().listTextures()) {
    const src = texture.getImage();
    if (!src || !src.byteLength) {
      skipped++;
      continue;
    }
    const maxEdge = caps.get(texture) ?? maxBase;
    const input = Buffer.from(src);
    try {
      const meta = await sharp(input).metadata();
      const w = meta.width || 0;
      const h = meta.height || 0;
      if (!w || !h) {
        skipped++;
        continue;
      }
      if (w <= maxEdge && h <= maxEdge) {
        skipped++;
        continue;
      }

      const out = await sharp(input)
        .resize(maxEdge, maxEdge, { fit: 'inside', withoutEnlargement: true })
        .png()
        .toBuffer();

      const check = await sharp(out).metadata();
      if (!check.width || !check.height) {
        failed++;
        console.warn(
          `  textures : keep original (bad resize) ${texture.getName() || '?'}`,
        );
        continue;
      }

      texture.setImage(out);
      texture.setMimeType('image/png');
      resized++;
    } catch (err) {
      failed++;
      console.warn(
        `  textures : keep original (${err.message}) ${texture.getName() || '?'}`,
      );
    }
  }

  return { resized, skipped, failed };
}

/**
 * @param {import('@gltf-transform/core').Document} doc
 * @param {number} maxBase
 * @returns {Map<object, number>}
 */
function buildTextureCaps(doc, maxBase) {
  const caps = new Map();
  const setCap = (tex, cap) => {
    if (!tex) return;
    const prev = caps.get(tex);
    caps.set(tex, prev == null ? cap : Math.min(prev, cap));
  };

  const normalCap = Math.min(maxBase, TEX_CAP_NORMAL);
  const ormCap = Math.min(maxBase, TEX_CAP_ORM);

  for (const mat of doc.getRoot().listMaterials()) {
    setCap(mat.getBaseColorTexture(), maxBase);
    setCap(mat.getEmissiveTexture(), maxBase);
    setCap(mat.getNormalTexture(), normalCap);
    setCap(mat.getMetallicRoughnessTexture(), ormCap);
    setCap(mat.getOcclusionTexture(), ormCap);
  }
  return caps;
}

/**
 * Extract textures to kit-level `_textures/<sha1>.png` and point URIs at them.
 * @param {import('@gltf-transform/core').Document} doc
 * @param {string} texturesDir
 * @param {string} outDir asset folder (for relative URI)
 */
async function externalizeTextures(doc, texturesDir, outDir) {
  mkdirSync(texturesDir, { recursive: true });
  let written = 0;
  let reused = 0;

  for (const texture of doc.getRoot().listTextures()) {
    const src = texture.getImage();
    if (!src || !src.byteLength) continue;

    let png = Buffer.from(src);
    const mime = texture.getMimeType() || '';
    if (!mime.includes('png')) {
      png = await sharp(png).png().toBuffer();
    }

    const hash = createHash('sha1').update(png).digest('hex').slice(0, 16);
    const fileName = `${hash}.png`;
    const absPath = pathJoin(texturesDir, fileName);
    if (!existsSync(absPath)) {
      writeFileSync(absPath, png);
      written++;
    } else {
      reused++;
    }

    const uri = relative(outDir, absPath).replace(/\\/g, '/');
    texture.setURI(uri);
    texture.setMimeType('image/png');
    texture.setImage(png); // keep bytes so gltf write can decide; we strip on pack
  }

  return { written, reused };
}

/**
 * gltf-transform's GLB writer re-embeds images. Write via .gltf (keeps URI) then
 * pack a GLB whose JSON still references external PNGs.
 */
async function writeGlbPreservingExternalImages(io, doc, outGlb, workDir) {
  const hasExternal = doc
    .getRoot()
    .listTextures()
    .some((t) => {
      const uri = t.getURI();
      return uri && !uri.startsWith('data:');
    });

  if (!hasExternal) {
    await io.write(outGlb, doc);
    return;
  }

  const tmpGltf = pathJoin(workDir, `_ext_${basename(outGlb, '.glb')}.gltf`);
  await io.write(tmpGltf, doc);
  const gltf = JSON.parse(readFileSync(tmpGltf, 'utf8'));
  const binUri = gltf.buffers?.[0]?.uri;
  if (!binUri) {
    await io.write(outGlb, doc);
    return;
  }
  const binPath = pathJoin(dirname(tmpGltf), binUri);
  const binBytes = readFileSync(binPath);
  delete gltf.buffers[0].uri;
  writeGlbFromJsonAndBin(gltf, binBytes, outGlb);

  try {
    rmSync(tmpGltf, { force: true });
    rmSync(binPath, { force: true });
  } catch {
    // ignore
  }
}

function writeGlbFromJsonAndBin(gltfJson, binBytes, outPath) {
  let jsonStr = JSON.stringify(gltfJson);
  while (Buffer.byteLength(jsonStr) % 4 !== 0) jsonStr += ' ';
  const jsonBuf = Buffer.from(jsonStr);
  const binPad = (4 - (binBytes.length % 4)) % 4;
  const binBuf =
    binPad === 0 ? binBytes : Buffer.concat([binBytes, Buffer.alloc(binPad)]);

  const totalLen = 12 + 8 + jsonBuf.length + 8 + binBuf.length;
  const out = Buffer.alloc(totalLen);
  out.writeUInt32LE(0x46546c67, 0); // glTF
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(totalLen, 8);
  out.writeUInt32LE(jsonBuf.length, 12);
  out.writeUInt32LE(0x4e4f534a, 16); // JSON
  jsonBuf.copy(out, 20);
  const binOffset = 20 + jsonBuf.length;
  out.writeUInt32LE(binBuf.length, binOffset);
  out.writeUInt32LE(0x004e4942, binOffset + 4); // BIN
  binBuf.copy(out, binOffset + 8);
  writeFileSync(outPath, out);
}

function writeAssetJson(outDir, stem, lodResults, impostorInfo, extra = {}) {
  const meshLods = lodResults.filter((l) => !l.impostor);
  const asset = {
    name: stem,
    default: extra.default || 'default.glb',
    lods: meshLods.map((l) => ({
      level: l.level,
      file: `lod${l.level}.glb`,
      targetRatio: l.targetRatio,
      triangles: l.stats?.triangles ?? null,
    })),
    impostor: impostorInfo
      ? {
          file: 'impostor.glb',
          atlas: impostorInfo.atlasPath
            ? basename(impostorInfo.atlasPath)
            : 'impostor_atlas.png',
          frames: impostorInfo.frames ?? null,
          hemi: impostorInfo.hemi !== false,
          resolution: impostorInfo.resolution ?? null,
          mode: impostorInfo.mode || 'octahedral',
        }
      : null,
    sharedTextures: extra.sharedTextures !== false,
  };
  const path = pathJoin(outDir, 'asset.json');
  writeFileSync(path, JSON.stringify(asset, null, 2));
  return path;
}

/** Remove leftover baker/debug junk from previous runs. */
function cleanupOutputJunk(outDir) {
  if (!existsSync(outDir)) return;
  for (const name of readdirSync(outDir)) {
    if (
      name === '_source.glb' ||
      name === '_bake.html' ||
      name.startsWith('_bad_')
    ) {
      try {
        rmSync(pathJoin(outDir, name), { force: true, recursive: true });
      } catch {
        // ignore
      }
    }
  }
}

async function writePackGlb(io, lodResults, outDir, stem, impostorInfo = null) {
  const meshLod = lodResults.find((l) => !l.impostor) || lodResults[0];
  if (!meshLod) return null;
  const packDoc = await io.read(meshLod.path);
  const asset = packDoc.getRoot().getAsset();
  asset.extras = {
    ...(asset.extras || {}),
    hpPipeline: {
      name: stem,
      lodFiles: lodResults
        .filter((l) => !l.impostor)
        .map((l) => ({
          level: l.level,
          file: `lod${l.level}.glb`,
          targetRatio: l.targetRatio,
          triangles: l.stats.triangles,
        })),
      impostor: impostorInfo
        ? {
            file: 'impostor.glb',
            mode: impostorInfo.mode,
            preview: 'preview.html',
          }
        : null,
    },
  };
  const packPath = pathJoin(outDir, 'pack.glb');
  await io.write(packPath, packDoc);
  console.log(`  pack     : ${packPath} (opt-in --pack)`);
  return packPath;
}

export async function processBatch(assets, options) {
  mkdirSync(options.output, { recursive: true });
  const reports = [];
  const failures = [];

  for (const asset of assets) {
    try {
      reports.push(await processAsset(asset, options));
    } catch (err) {
      console.error(`\n✗ FAILED: ${asset}`);
      console.error(`  ${err.message}`);
      if (err.stack) console.error(err.stack);
      failures.push({ asset, error: err.message });
    }
  }

  const summaryPath = pathJoin(options.output, 'batch_summary.json');
  writeFileSync(
    summaryPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        total: assets.length,
        ok: reports.length,
        failed: failures.length,
        failures,
        assets: reports.map((r) => ({
          name: r.name,
          beforeTris: r.before?.triangles,
          lod0Tris: r.lods?.[0]?.stats?.triangles,
          lod0MB: r.lods?.[0]?.stats?.fileMB,
          materialsBefore: r.materialsBefore,
          materialsAfter: r.materialsAfter,
          atlasUsed: r.options?.atlasUsed,
        })),
      },
      null,
      2,
    ),
  );
  console.log(`\nBatch summary: ${summaryPath}`);
  console.log(`  OK: ${reports.length}  Failed: ${failures.length}`);
  return { reports, failures };
}
