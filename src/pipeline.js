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
import { mergeMaterials } from './material-merge.js';
import { compressTexturesKtx2 } from './ktx2.js';
import { permissiveSimplify } from './permissive-simplify.js';
import { countGlassTris } from './glass-materials.js';
import { generateImpostor } from './impostor.js';
import { bakeLod2Atlas } from './lod2-atlas.js';
import { bakeLod3Silhouette } from './lod3-silhouette.js';
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
 * @property {boolean} [lod2Atlas] default true — bake unique UV + 1024 atlas on last LOD
 * @property {number} [lod2AtlasRes]
 * @property {boolean} [lod3Silhouette] default true — 6-plane boxcards + MASK atlas
 * @property {number} [lod3Res] atlas edge px (default 2048)
 * @property {number} [lod3Slices] ignored (legacy CLI compat)
 * @property {string} [lod3Method] ignored (legacy CLI compat; always boxcards)
 * @property {boolean} hero
 * @property {boolean} ktx2
 * @property {number} [jobs] parallel assets (default 1)
 */

export async function processAsset(assetPath, options) {
  const stem = assetStem(assetPath, options.input);
  const outDir = pathJoin(options.output, ...stem.split('/').filter(Boolean));
  mkdirSync(outDir, { recursive: true });

  const workDir = makeWorkDir(outDir);
  // Opt-in: external URIs into per-kit `_shared/textures/<sha1>.png` (engine resolves vs GLB dir).
  const sharedTextures = options.sharedTextures === true;
  const texturesDir = resolveSharedTexturesDir(options.output, stem);

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

    let atlasUsed = false;
    let sourceDoc = await io.read(glbPath);

    // 1) Material merge (no rebake) — always; keeps tiling for lod0/lod1
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
    // Public lod0/default get external URIs into kit `_shared/textures/` when sharedTextures.
    const embeddedGlb = pathJoin(workDir, 'embedded.glb');
    await io.write(embeddedGlb, sourceDoc);
    glbPath = embeddedGlb;

    // Fix 5: full-quality model before decimation
    const defaultPath = pathJoin(outDir, 'default.glb');
    let sharedTexStats = null;
    /** @type {string[]} */
    let sharedTextureFiles = [];
    if (sharedTextures) {
      const defDoc = await io.read(embeddedGlb);
      sharedTexStats = await externalizeTextures(defDoc, texturesDir, outDir);
      sharedTextureFiles = mergeSharedTextureFiles(
        sharedTextureFiles,
        sharedTexStats.files,
      );
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
      // Keep glass/emissive facade panes on every LOD (thin windows vanish under meshopt).
      const protectGlass = true;
      const pruneError = i >= 2 ? 0.02 : 0.01;

      console.log(
        `  ${label}: permissive simplify ratio=${ratio} error=${lodError} prune=${pruneError}${protectUv ? '' : ' (uv seams free)'}${protectGlass ? ' +glass protect' : ''}`,
      );

      const doc = await io.read(glbPath);
      await doc.transform(dedup(), flatten(), join());

      const simp = await permissiveSimplify(doc, {
        ratio,
        error: lodError,
        pruneError,
        protectUv,
        protectGlass,
      });
      console.log(
        `  ${label}: tris ${simp.srcTris.toLocaleString()} → ${simp.dstTris.toLocaleString()}${simp.skippedTris ? ` (glass kept ${simp.skippedTris.toLocaleString()})` : ''}`,
      );

      await MeshoptEncoder.ready;
      await doc.transform(
        reorder({ encoder: MeshoptEncoder, target: 'performance' }),
        prune(),
      );

      const isLastLod = i === ratios.length - 1;
      const wantLod2Atlas = isLastLod && i >= 1 && options.lod2Atlas !== false;
      let lod2AtlasOk = false;

      if (i === 0) {
        // Always write PNG-capable lod0_embedded for impostor bake.
        const embedLod0 = pathJoin(workDir, 'lod0_embedded.glb');
        if (sharedTextures) {
          await io.write(embedLod0, doc);
          const pubDoc = await io.read(embedLod0);
          const lod0Shared = await externalizeTextures(pubDoc, texturesDir, outDir);
          sharedTextureFiles = mergeSharedTextureFiles(
            sharedTextureFiles,
            lod0Shared.files,
          );
          await writeGlbPreservingExternalImages(io, pubDoc, lodPath, workDir);
        } else {
          await io.write(lodPath, doc);
          await io.write(embedLod0, doc);
        }
        // Puppeteer has no KTX2 transcoder — re-simplify from PNG working copy.
        if (options.ktx2 !== false) {
          const pngDoc = await io.read(embeddedGlb);
          await pngDoc.transform(dedup(), flatten(), join());
          await permissiveSimplify(pngDoc, {
            ratio,
            error: lodError,
            pruneError,
            protectUv,
            protectGlass,
          });
          await MeshoptEncoder.ready;
          await pngDoc.transform(
            reorder({ encoder: MeshoptEncoder, target: 'performance' }),
            prune(),
          );
          await io.write(embedLod0, pngDoc);
          console.log(`  ${label}: impostor source = PNG lod0_embedded.glb`);
        }
      } else if (wantLod2Atlas) {
        // P2: unique UV + single atlas — self-contained far LOD
        try {
          let bakeDoc = doc;
          if (options.ktx2 !== false) {
            bakeDoc = await io.read(embeddedGlb);
            await bakeDoc.transform(dedup(), flatten(), join());
            await permissiveSimplify(bakeDoc, {
              ratio,
              error: lodError,
              pruneError,
              protectUv,
              protectGlass,
            });
            await MeshoptEncoder.ready;
            await bakeDoc.transform(
              reorder({ encoder: MeshoptEncoder, target: 'performance' }),
              prune(),
            );
          }
          const atlasRes =
            options.lod2AtlasRes ?? (options.hero ? 2048 : 1024);
          await bakeLod2Atlas({
            doc: bakeDoc,
            io,
            workDir,
            outDir,
            outputGlb: lodPath,
            resolution: atlasRes,
            blender: options.blender,
          });
          lod2AtlasOk = true;
        } catch (err) {
          console.warn(`  ${label}: atlas skipped — ${err.message}`);
          if (err.stack) console.warn(err.stack);
          const strippedCount = stripTextures(doc);
          console.log(
            `  ${label}: stripped ${strippedCount} textures (geometry-only fallback)`,
          );
          await io.write(lodPath, doc);
        }
      } else {
        // LOD1 (and lod2 if --no-lod2-atlas): geometry-only stubs
        const strippedCount = stripTextures(doc);
        console.log(
          `  ${label}: stripped ${strippedCount} textures (geometry-only, material name stubs kept)`,
        );
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

      const statsDoc = lod2AtlasOk ? await io.read(lodPath) : doc;
      const stats = collectStats(statsDoc, fileSizeBytes(lodPath));
      const health = assessHealth(beforeGeom, stats, ratio);
      // Count glass after simplify (before atlas merges materials away).
      const glassAfterSimplify = countGlassTris(doc);
      lodResults.push({
        label,
        level: i,
        targetRatio: ratio,
        path: lodPath,
        stats,
        health,
        baked: lod2AtlasOk,
        atlas: lod2AtlasOk,
        glassTris: glassAfterSimplify.tris,
        glassPrims: glassAfterSimplify.prims,
        reduction: reductionReport(beforeGeom, stats),
        // Embedded lod0 kept for diagnostics / fallback
        embedPath: i === 0 ? pathJoin(workDir, 'lod0_embedded.glb') : null,
      });
      if (lod2AtlasOk) atlasUsed = true;
    }

    // 5) LOD3 boxcards — 6 AABB quads + ortho atlas (MASK)
    let lod3Info = null;
    if (options.lod3Silhouette !== false) {
      const lod3Source = existsSync(impostorSourceGlb)
        ? impostorSourceGlb
        : existsSync(defaultPath)
          ? defaultPath
          : null;
      if (!lod3Source) {
        console.warn('  LOD3: skipped — no bake source GLB');
      } else {
        const lod3Res = options.lod3Res ?? 2048;
        try {
          lod3Info = await bakeLod3Silhouette({
            inputGlb: lod3Source,
            outDir,
            workDir,
            resolution: lod3Res,
            blender: options.blender,
          });
          const lod3Path = lod3Info.outputGlb;
          const stats = collectStats(await io.read(lod3Path), fileSizeBytes(lod3Path));
          lodResults.push({
            label: 'LOD3',
            level: 3,
            targetRatio: null,
            path: lod3Path,
            stats,
            health: {
              ok: true,
              msg: `boxcards — ${lod3Info.triangles} tris`,
            },
            baked: true,
            atlas: true,
            maps: 'lod3_atlas/',
            reduction: reductionReport(beforeGeom, stats),
          });
        } catch (err) {
          console.warn(`  LOD3: skipped — ${err.message}`);
          if (err.stack) console.warn(err.stack);
          lod3Info = { ok: false, reason: err.message };
        }
      }
    }

    // 6) Legacy impostor (opt-in) — octahedral / AABB box; prefer LOD3 boxcards
    let impostorInfo = null;
    if (options.impostor) {
      console.warn(
        '  impostor: LEGACY path enabled — default cook uses LOD3 boxcards; see legacy/README.md',
      );
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
      // Prefer PNG full mesh (same as default.glb quality). External default
      // can't be loaded in Puppeteer — embeddedGlb always has textures inline.
      const lod0Entry = lodResults.find((l) => l.level === 0);
      const bakeFrom = existsSync(impostorSourceGlb)
        ? impostorSourceGlb
        : (lod0Entry?.embedPath && existsSync(lod0Entry.embedPath)
            ? lod0Entry.embedPath
            : lod0Entry?.path);
      if (!bakeFrom || !existsSync(bakeFrom)) {
        console.warn('  impostor: FAILED — no bake source GLB');
        impostorInfo = { ok: false, reason: 'no bake source GLB' };
      } else {
      const bakeSrcLabel =
        bakeFrom === impostorSourceGlb
          ? 'default (full mesh)'
          : bakeFrom === lod0Entry?.embedPath
            ? 'lod0_embedded'
            : 'lod0';
      console.log(
        `  impostor: baking from ${bakeSrcLabel} (${(fileSizeBytes(bakeFrom) / (1024 * 1024)).toFixed(1)} MB) @ ${impostorRes}px / ${impostorFrames}×${impostorFrames}`,
      );
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
          ok: true,
          path: impostorPath,
          backend: result.backend,
          mode,
          stats,
          atlasPath: result.atlasPath || null,
          frames: result.frames || impostorFrames,
          resolution: result.atlasSize || impostorRes,
          hemi: true,
          source: bakeSrcLabel,
          gutterPx: result.gutterPx ?? null,
          alphaMode: result.alphaMode || null,
          meta: 'impostor.json',
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
                ? `octahedral from ${bakeSrcLabel} — open preview.html`
                : `box impostor`,
          },
          baked: false,
          impostor: true,
          reduction: reductionReport(beforeGeom, stats),
        });
        console.log(`  impostor: OK (${mode}, ${stats.fileMB} MB)`);
      } catch (err) {
        const reason = err?.message || String(err);
        console.warn(`  impostor: FAILED — ${reason}`);
        if (err?.stack) console.warn(err.stack);
        impostorInfo = { ok: false, reason };
      }
      } // bakeFrom exists
    }

    // Fix 3: asset.json sidecar (pack.glb only if --pack)
    const assetJsonPath = writeAssetJson(outDir, stem, lodResults, impostorInfo, {
      default: 'default.glb',
      sharedTextures,
      sharedTextureFiles,
      lod3: lod3Info,
    });
    console.log(`  asset    : ${assetJsonPath}`);

    let packPath = null;
    if (options.pack === true && lodResults.some((l) => !l.impostor)) {
      packPath = await writePackGlb(io, lodResults, outDir, stem, impostorInfo);
    }

    cleanupOutputJunk(outDir);

    printAssetReport(stem, beforeGeom, lodResults);

    const glassQc = await buildGlassQc(io, baselineDoc, lodResults);
    if (glassQc) {
      const fmtPct = (tris) =>
        glassQc.baselineTris > 0
          ? ((tris / glassQc.baselineTris) * 100).toFixed(1)
          : 'n/a';
      console.log(
        `  glass QC : baseline ${glassQc.baselineTris.toLocaleString()} tris` +
          ` | LOD0 ${glassQc.lod0Tris.toLocaleString()} (${fmtPct(glassQc.lod0Tris)}%)` +
          ` | LOD1 ${glassQc.lod1Tris.toLocaleString()} (${fmtPct(glassQc.lod1Tris)}%)` +
          ` | LOD2 ${glassQc.lod2Tris.toLocaleString()} (${fmtPct(glassQc.lod2Tris)}%)` +
          `${glassQc.warn ? ' ⚠ below 95%' : ''}`,
      );
      if (glassQc.materials.length) {
        console.log(`  glass QC : materials [${glassQc.materials.join(', ')}]`);
      }
    }

    const report = {
      name: stem,
      source: assetPath,
      sourceFormat,
      generatedAt: new Date().toISOString(),
      options: {
        ratios,
        lod2Atlas: options.lod2Atlas !== false,
        atlasUsed,
        lod3Silhouette: options.lod3Silhouette !== false,
        lod3Res: options.lod3Res ?? 2048,
        lod3Method: 'boxcards',
        hero: !!options.hero,
        ktx2: options.ktx2 !== false,
        impostor: options.impostor,
        impostorMode: options.impostorMode || 'octahedral',
        sharedTextures,
        maxTexture: options.maxTexture,
      },
      lod3: lod3Info,
      beforeRaw,
      before: beforeGeom,
      materialMerge: mergeStats,
      sharedTextures: sharedTexStats,
      default: defaultPath,
      asset: assetJsonPath,
      glassQc,
      lods: lodResults.map((l) => ({
        label: l.label,
        level: l.level,
        targetRatio: l.targetRatio,
        path: l.path,
        stats: l.stats,
        health: l.health,
        impostor: !!l.impostor,
        atlas: !!l.atlas,
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

/**
 * Soft QC: glass/emissive tris on baseline vs LOD0/1/2 (warn if any under 95% kept).
 * Prefers per-LOD counts taken after simplify (before atlas merges materials).
 * @param {import('@gltf-transform/core').NodeIO} io
 * @param {import('@gltf-transform/core').Document} baselineDoc
 * @param {Array<{ level: number, path: string, glassTris?: number, glassPrims?: number, atlas?: boolean }>} lodResults
 */
async function buildGlassQc(io, baselineDoc, lodResults) {
  const baseline = countGlassTris(baselineDoc);
  const materials = new Set(baseline.materials);

  /** @type {{ tris: number, prims: number }[]} */
  const perLod = [];
  for (let level = 0; level <= 2; level++) {
    const entry = lodResults.find((l) => l.level === level && l.path);
    if (!entry) {
      perLod.push({ tris: 0, prims: 0 });
      continue;
    }
    if (typeof entry.glassTris === 'number') {
      perLod.push({
        tris: entry.glassTris,
        prims: entry.glassPrims ?? 0,
      });
      continue;
    }
    if (!existsSync(entry.path)) {
      perLod.push({ tris: 0, prims: 0 });
      continue;
    }
    try {
      const doc = await io.read(entry.path);
      const counted = countGlassTris(doc);
      perLod.push({ tris: counted.tris, prims: counted.prims });
      for (const name of counted.materials) materials.add(name);
    } catch {
      perLod.push({ tris: 0, prims: 0 });
    }
  }

  const ratioOf = (tris) => {
    if (baseline.tris > 0) return Math.round((tris / baseline.tris) * 1000) / 1000;
    return tris === 0 ? 1 : 0;
  };
  const ratio0 = ratioOf(perLod[0].tris);
  const ratio1 = ratioOf(perLod[1].tris);
  const ratio2 = ratioOf(perLod[2].tris);
  const warn =
    baseline.tris > 0 &&
    (ratio0 < 0.95 || ratio1 < 0.95 || ratio2 < 0.95);

  return {
    baselineTris: baseline.tris,
    lod0Tris: perLod[0].tris,
    lod1Tris: perLod[1].tris,
    lod2Tris: perLod[2].tris,
    baselinePrims: baseline.prims,
    lod0Prims: perLod[0].prims,
    lod1Prims: perLod[1].prims,
    lod2Prims: perLod[2].prims,
    ratio: ratio0,
    ratio0,
    ratio1,
    ratio2,
    warn,
    materials: [...materials].sort(),
  };
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
 * Per-kit shared pool: `output/<Kit>/_shared/textures/`.
 * Flat stem (no kit) → `output/_shared/textures/`.
 * @param {string} outputRoot
 * @param {string} stem e.g. "Manhattan/Office_Plaza" or "Office_Plaza"
 */
function resolveSharedTexturesDir(outputRoot, stem) {
  const parts = stem.split('/').filter(Boolean);
  if (parts.length >= 2) {
    return pathJoin(outputRoot, parts[0], '_shared', 'textures');
  }
  return pathJoin(outputRoot, '_shared', 'textures');
}

/** @param {string[]} a @param {string[]} b */
function mergeSharedTextureFiles(a, b) {
  const set = new Set(a);
  for (const f of b) set.add(f);
  return [...set].sort();
}

/**
 * Extract textures to kit-level `_shared/textures/<sha1>.png` and point URIs at them.
 * @param {import('@gltf-transform/core').Document} doc
 * @param {string} texturesDir
 * @param {string} outDir asset folder (for relative URI)
 */
async function externalizeTextures(doc, texturesDir, outDir) {
  mkdirSync(texturesDir, { recursive: true });
  let written = 0;
  let reused = 0;
  /** @type {Set<string>} */
  const files = new Set();

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
    files.add(fileName);

    const uri = relative(outDir, absPath).replace(/\\/g, '/');
    texture.setURI(uri);
    texture.setMimeType('image/png');
    texture.setImage(png); // keep bytes so gltf write can decide; we strip on pack
  }

  return { written, reused, files: [...files].sort() };
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
  let impostor = null;
  if (impostorInfo) {
    if (impostorInfo.ok === false) {
      impostor = { ok: false, reason: impostorInfo.reason || 'unknown' };
    } else {
      impostor = {
        ok: true,
        file: 'impostor.glb',
        atlas: impostorInfo.atlasPath
          ? basename(impostorInfo.atlasPath)
          : 'impostor_atlas.png',
        meta: impostorInfo.meta || 'impostor.json',
        frames: impostorInfo.frames ?? null,
        hemi: impostorInfo.hemi !== false,
        resolution: impostorInfo.resolution ?? null,
        mode: impostorInfo.mode || 'octahedral',
        gutterPx: impostorInfo.gutterPx ?? null,
        alphaMode: impostorInfo.alphaMode || null,
        legacy: true,
      };
    }
  }

  let lod3 = null;
  const lod3Info = extra.lod3;
  if (lod3Info) {
    if (lod3Info.ok === false) {
      lod3 = { ok: false, reason: lod3Info.reason || 'unknown' };
    } else if (lod3Info.outputGlb || lod3Info.backend) {
      lod3 = {
        ok: true,
        file: 'lod3.glb',
        atlas: 'lod3_atlas/',
        triangles: lod3Info.triangles ?? null,
        resolution: lod3Info.resolution ?? null,
        backend: lod3Info.backend || 'boxcards',
        alphaMode: lod3Info.alphaMode || 'MASK',
      };
    }
  }

  const asset = {
    name: stem,
    default: extra.default || 'default.glb',
    lods: meshLods.map((l) => ({
      level: l.level,
      file: `lod${l.level}.glb`,
      targetRatio: l.targetRatio,
      triangles: l.stats?.triangles ?? null,
      atlas: !!l.atlas,
      ...(l.atlas
        ? {
            maps: l.maps || (l.level === 3 ? 'lod3_atlas/' : 'lod2_atlas/'),
            note:
              l.level === 3
                ? '6-plane boxcards + MASK atlas; self-contained'
                : 'self-contained PBR atlas (unique UV)',
          }
        : l.level >= 1
          ? { note: 'geometry-only; materials from lod0' }
          : {}),
    })),
    lod3,
    impostor,
    sharedTextures: !!extra.sharedTextures,
  };
  if (asset.sharedTextures) {
    asset.sharedTextureFiles = Array.isArray(extra.sharedTextureFiles)
      ? [...extra.sharedTextureFiles].sort()
      : [];
  }
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

/**
 * @template T
 * @param {T[]} items
 * @param {number} concurrency
 * @param {(item: T, index: number) => Promise<void>} worker
 */
async function mapPool(items, concurrency, worker) {
  let next = 0;
  const n = Math.max(1, Math.min(concurrency, items.length || 1));
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        await worker(items[i], i);
      }
    }),
  );
}

export async function processBatch(assets, options) {
  mkdirSync(options.output, { recursive: true });
  const reports = [];
  const failures = [];
  const jobs = Math.max(1, Math.min(16, Number(options.jobs) || 1));

  if (jobs > 1) {
    console.log(`  parallel jobs: ${jobs} (Blender LOD2/LOD3/impostor overlap)`);
  }

  await mapPool(assets, jobs, async (asset) => {
    try {
      const report = await processAsset(asset, options);
      reports.push(report);
    } catch (err) {
      console.error(`\n✗ FAILED: ${asset}`);
      console.error(`  ${err.message}`);
      if (err.stack) console.error(err.stack);
      failures.push({ asset, error: err.message });
    }
  });

  const summaryPath = pathJoin(options.output, 'batch_summary.json');
  writeFileSync(
    summaryPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        total: assets.length,
        ok: reports.length,
        failed: failures.length,
        jobs,
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
  console.log(`  OK: ${reports.length}  Failed: ${failures.length}  jobs=${jobs}`);
  return { reports, failures };
}
